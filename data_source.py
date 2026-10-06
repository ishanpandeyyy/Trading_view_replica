"""Pluggable market-data layer.

A provider is ONE function  history(symbol, tf) -> list of bars, registered with register().
Bar = {"time": unix_seconds, "open", "high", "low", "close", "volume"}, sorted oldest -> newest.

Live updates:
  * default: the hub re-calls history() every `poll` seconds and pushes the newest bar
  * push-based feeds: also pass stream(symbol, tf, emit, stop) which blocks, calls emit(bar), exits when stop is set

Adding a broker later = write history() (and optionally stream()) and call register(). Example:

    def alpaca_history(symbol, tf): ...            # return bars
    register("alpaca", "US (Alpaca)", ["AAPL", "MSFT"], ["1m", "5m", "1d"], history=alpaca_history, poll=5)
"""
import json, queue, re, threading, time
import requests

PROVIDERS = {}


def register(name, label, symbols, timeframes, history, stream=None, poll=5, custom=False):
    """symbols: list or {id: display name}. custom=True lets the UI request any ticker (regex-checked)."""
    if not isinstance(symbols, dict):
        symbols = {x: x for x in symbols}
    PROVIDERS[name] = dict(label=label, symbols=symbols, timeframes=timeframes,
                           history=history, stream=stream, poll=poll, custom=custom)


def catalog():
    return {n: dict(label=p["label"], symbols=p["symbols"], timeframes=p["timeframes"], custom=p["custom"])
            for n, p in PROVIDERS.items()}


def valid(source, symbol, tf):
    p = PROVIDERS.get(source)
    return bool(p) and tf in p["timeframes"] and (
        symbol in p["symbols"] or (p["custom"] and re.fullmatch(r"[A-Za-z0-9.^=&-]{1,20}", symbol)))


def history(source, symbol, tf):
    if not valid(source, symbol, tf):
        raise ValueError("unknown symbol/timeframe")
    return PROVIDERS[source]["history"](symbol, tf)


# ---------------- Hyperliquid (crypto, websocket) ----------------
HL_REST = "https://api.hyperliquid.xyz/info"
HL_WS = "wss://api.hyperliquid.xyz/ws"
HL_SECS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}


def _hl_bar(c):
    return dict(time=c["t"] // 1000, open=float(c["o"]), high=float(c["h"]),
                low=float(c["l"]), close=float(c["c"]), volume=float(c["v"]))


def hl_history(symbol, tf):
    end = int(time.time() * 1000)
    start = end - HL_SECS[tf] * 1000 * 500
    r = requests.post(HL_REST, timeout=10, json={"type": "candleSnapshot", "req": {
        "coin": symbol, "interval": tf, "startTime": start, "endTime": end}})
    r.raise_for_status()
    return [_hl_bar(c) for c in r.json()]


def hl_stream(symbol, tf, emit, stop):
    import websocket  # websocket-client

    def on_open(ws):
        ws.send(json.dumps({"method": "subscribe",
                            "subscription": {"type": "candle", "coin": symbol, "interval": tf}}))

        def keepalive():  # Hyperliquid drops idle sockets after 60s
            while not stop.wait(30):
                try:
                    ws.send('{"method":"ping"}')
                except Exception:
                    return
            ws.close()
        threading.Thread(target=keepalive, daemon=True).start()

    def on_message(ws, msg):
        m = json.loads(msg)
        if m.get("channel") == "candle":
            emit(_hl_bar(m["data"]))

    websocket.WebSocketApp(HL_WS, on_open=on_open, on_message=on_message).run_forever()


register("hyperliquid", "Crypto (Hyperliquid)",
         ["BTC", "ETH", "SOL"],
         list(HL_SECS), history=hl_history, stream=hl_stream)

# ---------------- yfinance (Indian equities, polled) ----------------
YF = {"1m": ("1m", "5d"), "5m": ("5m", "30d"), "15m": ("15m", "30d"),
      "1h": ("60m", "180d"), "1d": ("1d", "2y")}


def yf_history(symbol, tf):
    import yfinance as yf
    interval, period = YF[tf]
    df = yf.Ticker(symbol).history(period=period, interval=interval).dropna()
    return [dict(time=int(ts.timestamp()), open=float(r.Open), high=float(r.High),
                 low=float(r.Low), close=float(r.Close), volume=float(r.Volume))
            for ts, r in df.iterrows()]


NSE = {"^NSEI": "NIFTY 50", "^NSEBANK": "BANK NIFTY", "^BSESN": "SENSEX"}
NSE.update({f"{x}.NS": x for x in ['ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK', 'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV', 'BEL', 'BHARTIARTL', 'BPCL', 'BRITANNIA', 'CIPLA', 'COALINDIA', 'DRREDDY', 'EICHERMOT', 'ETERNAL', 'GRASIM', 'HCLTECH', 'HDFCBANK', 'HDFCLIFE', 'HEROMOTOCO', 'HINDALCO', 'HINDUNILVR', 'ICICIBANK', 'INDUSINDBK', 'INFY', 'ITC', 'JIOFIN', 'JSWSTEEL', 'KOTAKBANK', 'LT', 'M&M', 'MARUTI', 'NESTLEIND', 'NTPC', 'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SBIN', 'SHRIRAMFIN', 'SUNPHARMA', 'TATACONSUM', 'TATASTEEL', 'TCS', 'TECHM', 'TITAN', 'TRENT', 'ULTRACEMCO', 'WIPRO', 'VEDL', 'IRCTC', 'PNB', 'YESBANK', 'IDEA', 'DMART', 'HAL', 'BANKBARODA', 'ADANIPOWER', 'TATAPOWER']})
register("yfinance", "India (NSE via yfinance)", NSE, list(YF), history=yf_history, poll=5, custom=True)
register("commodities", "Commodities (yfinance futures)",
         {"GC=F": "Gold", "SI=F": "Silver", "CL=F": "US Oil (WTI)", "BZ=F": "Brent Oil"},
         list(YF), history=yf_history, poll=5)


# ---------------- Hub: one worker per (source, symbol, tf), fanned out to subscribers ----------------
class Hub:
    def __init__(self):
        self.subs, self.stops, self.lock = {}, {}, threading.Lock()

    def subscribe(self, key):
        q = queue.Queue(maxsize=200)
        with self.lock:
            if key not in self.subs:
                self.subs[key], self.stops[key] = set(), threading.Event()
                threading.Thread(target=self._run, args=(key, self.stops[key]), daemon=True).start()
            self.subs[key].add(q)
        return q

    def unsubscribe(self, key, q):
        with self.lock:
            s = self.subs.get(key)
            if s is None:
                return
            s.discard(q)
            if not s:
                del self.subs[key]
                self.stops.pop(key).set()

    def _emit(self, key, bar):
        for q in list(self.subs.get(key, ())):
            try:
                q.put_nowait(bar)
            except queue.Full:
                pass

    def _run(self, key, stop):
        src, sym, tf = key
        p = PROVIDERS[src]
        while not stop.is_set():
            try:
                if p["stream"]:
                    p["stream"](sym, tf, lambda b: self._emit(key, b), stop)
                    stop.wait(2)  # socket dropped -> reconnect
                else:
                    bars = p["history"](sym, tf)
                    if bars:
                        self._emit(key, bars[-1])
                    stop.wait(p["poll"])
            except Exception as e:
                print(f"[{key}] {e}")
                stop.wait(5)


hub = Hub()
