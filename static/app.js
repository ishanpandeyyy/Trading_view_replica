const LAYOUT = {1: [1, 1], 2: [2, 1], 4: [2, 2], 6: [3, 2], 8: [4, 2]}; // [cols, rows]
const DEFAULTS = ["hyperliquid|BTC|5m", "hyperliquid|ETH|5m", "hyperliquid|SOL|5m", "commodities|GC=F|5m",
  "commodities|SI=F|5m", "commodities|CL=F|5m", "yfinance|^NSEI|5m", "yfinance|RELIANCE.NS|5m"];
const $ = s => document.querySelector(s);
let catalog, ws, panes = [], cfg;
const save = () => localStorage.setItem("cfg2", JSON.stringify(cfg));
const fmt = n => n.toLocaleString(undefined, {maximumFractionDigits: Math.abs(n) < 1 ? 6 : 2});
const sma = (B, n) => { const o = []; let s = 0;
  B.forEach((b, i) => { s += b.close; if (i >= n) s -= B[i - n].close; if (i >= n - 1) o.push({time: b.time, value: s / n}); }); return o; };
const rsi = (B, n) => { const o = []; let g = 0, l = 0; // Wilder smoothing
  for (let i = 1; i < B.length; i++) {
    const d = B[i].close - B[i - 1].close, u = Math.max(d, 0), v = Math.max(-d, 0);
    if (i <= n) { g += u / n; l += v / n; } else { g = (g * (n - 1) + u) / n; l = (l * (n - 1) + v) / n; }
    if (i >= n) o.push({time: B[i].time, value: l === 0 ? 100 : 100 - 100 / (1 + g / l)});
  } return o; };

class Pane {
  constructor(i) {
    this.i = i; this.px = null; this.key = null; this.bars = []; this.dr = []; this.tool = "cursor"; this.tmp = null; this.mv = {};
    const el = this.el = document.createElement("section");
    el.className = "pane";
    el.innerHTML = `<div class="bar"><select class="sym"></select><button class="add" title="Any Yahoo Finance ticker">＋</button><select class="tf"></select>
        <label><input type="checkbox" class="cma" checked>MA 9/15</label><label><input type="checkbox" class="crsi" checked>RSI 7</label></div>
      <div class="ticker"><span class="name"></span><span class="px">–</span><span class="chg"></span><span class="leg"></span></div>
      <div class="body"><div class="tools">
        <button data-tool="cursor" title="Cursor" class="on">✛</button><button data-tool="trend" title="Trend line">╱</button>
        <button data-tool="h" title="Horizontal support / resistance">―</button><button data-tool="rect" title="Rectangle">▭</button>
        <button data-tool="undo" title="Undo last drawing">↶</button><button data-tool="clear" title="Clear drawings">🗑</button></div>
        <div class="chart"><div class="nav"><button data-nav="-" title="Zoom out">−</button><button data-nav="+" title="Zoom in">+</button>
        <button data-nav="<" title="Scroll left">‹</button><button data-nav=">" title="Scroll right">›</button>
        <button data-nav="r" title="Reload & reset view">↺</button></div><canvas class="ov"></canvas></div></div>`;
    $("#grid").append(el);
    const q = s => el.querySelector(s);
    this.symSel = q(".bar .sym"); this.tfSel = q(".tf"); this.ticker = q(".ticker"); this.chartEl = q(".chart"); this.cv = q(".ov");
    for (const [src, p] of Object.entries(catalog)) {
      const g = document.createElement("optgroup"); g.label = p.label; g.dataset.src = src;
      Object.entries(p.symbols).forEach(([id, name]) => g.append(new Option(name === id ? id : `${name} (${id})`, `${src}|${id}`)));
      this.symSel.append(g);
    }
    const [src, sym, tf] = cfg[i].split("|");
    this.ensureOpt(`${src}|${sym}`); this.symSel.value = `${src}|${sym}`; this.fillTf(tf);
    const LC = LightweightCharts;
    this.chart = LC.createChart(this.chartEl, {autoSize: true,
      layout: {background: {color: "#ffffff"}, textColor: "#131722"},
      grid: {vertLines: {color: "#f0f3fa"}, horzLines: {color: "#f0f3fa"}},
      rightPriceScale: {borderColor: "#e0e3eb"},
      timeScale: {borderColor: "#e0e3eb", timeVisible: true, secondsVisible: false, rightOffset: 6,
        tickMarkFormatter: (t, type) => { const d = new Date(t * 1000);
          return type < 3 ? d.toLocaleDateString([], {month: "short", day: "numeric"})
                          : d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}); }},
      localization: {timeFormatter: t => new Date(t * 1000).toLocaleString([], {dateStyle: "short", timeStyle: "short"})}});
    this.series = this.chart.addSeries(LC.CandlestickSeries, {upColor: "#ffffff", downColor: "#000000",
      borderUpColor: "#000000", borderDownColor: "#000000", wickUpColor: "#000000", wickDownColor: "#000000",
      priceLineStyle: 1, priceLineWidth: 1}, 0);
    this.setInd("ma", true); this.setInd("rsi", true);
    q(".cma").onchange = e => this.setInd("ma", e.target.checked);
    q(".crsi").onchange = e => this.setInd("rsi", e.target.checked);
    this.symSel.onchange = () => { this.fillTf(this.tfSel.value); this.load(); };
    this.tfSel.onchange = () => this.load();
    q(".add").onclick = () => { const s = (prompt("Yahoo Finance ticker (e.g. TATAMOTORS.NS, AAPL, ^NSEI):") || "").trim().toUpperCase();
      if (!s) return; this.ensureOpt(`yfinance|${s}`); this.symSel.value = `yfinance|${s}`; this.fillTf(this.tfSel.value); this.load(); };
    q(".tools").onclick = e => { const t = e.target.closest("button")?.dataset.tool; if (!t) return;
      if (t === "undo") { this.dr.pop(); this.saveDr(); } else if (t === "clear") { this.dr = []; this.saveDr(); } else this.setTool(t); };
    q(".nav").onclick = e => { const a = e.target.closest("button")?.dataset.nav; if (a) this.nav(a); };
    this.cv.onclick = e => this.click(e); this.cv.onmousemove = e => this.move(e);
    this.load();
  }
  ensureOpt(v) { // custom Yahoo tickers get added to the dropdown on demand
    if ([...this.symSel.options].some(o => o.value === v)) return;
    this.symSel.querySelector('optgroup[data-src="yfinance"]').append(new Option(v.split("|")[1], v));
  }
  fillTf(want) {
    const tfs = catalog[this.symSel.value.split("|")[0]].timeframes;
    this.tfSel.replaceChildren(...tfs.map(t => new Option(t, t)));
    this.tfSel.value = tfs.includes(want) ? want : tfs[0];
  }
  send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({pane: this.i, ...o})); }
  subscribe() { const [source, symbol, tf] = this.key.split("|"); this.send({op: "sub", source, symbol, tf}); }
  async load() {
    const [source, symbol] = this.symSel.value.split("|"), tf = this.tfSel.value;
    const key = this.key = `${source}|${symbol}|${tf}`;
    cfg[this.i] = key; save();
    this.bars = []; this.px = null; this.tmp = null; this.series.setData([]); this.drawInd(true);
    this.drKey = `dr|${source}|${symbol}`; this.dr = JSON.parse(localStorage.getItem(this.drKey) || "[]");
    this.ticker.querySelector(".name").textContent = `${catalog[source].symbols[symbol] || symbol} · ${tf}`;
    this.el.querySelectorAll(".err").forEach(e => e.remove());
    this.subscribe();
    try {
      const r = await fetch(`/api/history?source=${source}&symbol=${encodeURIComponent(symbol)}&tf=${tf}`);
      const bars = await r.json();
      if (!r.ok) throw new Error(bars.error);
      if (key !== this.key) return;
      this.bars = bars; this.series.setData(bars); this.drawInd(true);
      this.chart.timeScale().fitContent();
      if (bars.length) this.tick(bars[bars.length - 1]);
    } catch (e) {
      const d = document.createElement("div"); d.className = "err"; d.textContent = e.message; this.chartEl.append(d);
    }
  }
  onBar(b) {
    const B = this.bars, last = B[B.length - 1];
    if (!last || b.time < last.time) return;
    if (b.time === last.time) B[B.length - 1] = b; else B.push(b);
    this.series.update(b); this.drawInd(false); this.tick(b);
  }
  setInd(kind, on) {
    const LS = LightweightCharts.LineSeries, ch = this.chart, o = c => ({color: c, lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false});
    if (kind === "ma") {
      if (on && !this.ma9) { this.ma9 = ch.addSeries(LS, o("#ff9800"), 0); this.ma15 = ch.addSeries(LS, o("#2196f3"), 0); }
      else if (!on && this.ma9) { ch.removeSeries(this.ma9); ch.removeSeries(this.ma15); this.ma9 = this.ma15 = null; }
    } else if (on && !this.rsi) {
      this.rsi = ch.addSeries(LS, {...o("#7e57c2"), autoscaleInfoProvider: () => ({priceRange: {minValue: 0, maxValue: 100}})}, 1);
      [70, 50, 30].forEach(p => this.rsi.createPriceLine({price: p, color: "#b2b5be", lineWidth: 1, lineStyle: 2, axisLabelVisible: p === 50}));
    } else if (!on && this.rsi) { ch.removeSeries(this.rsi); this.rsi = null; }
    const ps = ch.panes ? ch.panes() : [];
    if (ps[1]) { ps[0].setStretchFactor?.(3); ps[1].setStretchFactor?.(1); }
    this.drawInd(true);
  }
  drawInd(full) {
    const B = this.bars, up = (s, a) => { if (!s) return; if (full) s.setData(a); else if (a.length) s.update(a[a.length - 1]); };
    const a = this.ma9 && sma(B, 9), b = this.ma15 && sma(B, 15), r = this.rsi && rsi(B, 7), v = x => x && x.length ? x[x.length - 1].value : null;
    up(this.ma9, a); up(this.ma15, b); up(this.rsi, r);
    this.mv = {ma9: v(a), ma15: v(b), rsi: v(r)};
  }
  tick(b) {
    const t = this.ticker, px = b.close, m = this.mv, pct = (px / b.open - 1) * 100;
    t.querySelector(".px").textContent = fmt(px);
    const chg = t.querySelector(".chg"); chg.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`; chg.className = "chg " + (pct >= 0 ? "up" : "dn");
    t.querySelector(".leg").innerHTML = `O ${fmt(b.open)} H ${fmt(b.high)} L ${fmt(b.low)} C ${fmt(b.close)}` +
      (m.ma9 != null ? `<i style="color:#ff9800">MA9 ${fmt(m.ma9)}</i>` : "") + (m.ma15 != null ? `<i style="color:#2196f3">MA15 ${fmt(m.ma15)}</i>` : "") +
      (m.rsi != null ? `<i style="color:#b39ddb">RSI7 ${m.rsi.toFixed(2)}</i>` : "");
    this.series.applyOptions({priceLineColor: px >= b.open ? "#089981" : "#f23645"});
    if (this.px !== null && px !== this.px) { t.classList.remove("flash-up", "flash-dn"); void t.offsetWidth; t.classList.add(px > this.px ? "flash-up" : "flash-dn"); }
    this.px = px;
  }
  nav(a) {
    if (a === "r") return this.load();
    const ts = this.chart.timeScale(), r = ts.getVisibleLogicalRange(); if (!r) return;
    const n = r.to - r.from, c = (r.from + r.to) / 2, k = {"-": [c - n * .65, c + n * .65], "+": [c - n * .385, c + n * .385],
      "<": [r.from - n * .2, r.to - n * .2], ">": [r.from + n * .2, r.to + n * .2]}[a];
    ts.setVisibleLogicalRange({from: k[0], to: k[1]});
  }
  // ---- drawing tools (canvas overlay, stored as time/price so they survive zoom & timeframe changes) ----
  setTool(t) {
    this.tool = t; this.tmp = null; this.cv.style.pointerEvents = t === "cursor" ? "none" : "auto"; this.cv.style.cursor = "crosshair";
    this.el.querySelectorAll(".tools button").forEach(b => b.classList.toggle("on", b.dataset.tool === t));
  }
  pt(e) { const r = this.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    return {t: this.chart.timeScale().coordinateToTime(x), p: this.series.coordinateToPrice(y)}; }
  click(e) {
    const {t, p} = this.pt(e); if (t == null || p == null) return;
    if (this.tool === "h") this.dr.push({k: "h", p});
    else if (!this.tmp) { this.tmp = {k: this.tool, t1: t, p1: p, t2: t, p2: p}; return; }
    else { Object.assign(this.tmp, {t2: t, p2: p}); this.dr.push(this.tmp); }
    this.saveDr(); this.setTool("cursor");
  }
  move(e) { if (!this.tmp) return; const {t, p} = this.pt(e); if (t != null && p != null) Object.assign(this.tmp, {t2: t, p2: p}); }
  saveDr() { localStorage.setItem(this.drKey, JSON.stringify(this.dr)); }
  draw() {
    const cv = this.cv, c = cv.getContext("2d"), dpr = devicePixelRatio || 1, w = this.chartEl.clientWidth, h = this.chartEl.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + "px"; cv.style.height = h + "px"; }
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const ts = this.chart.timeScale(), pw = ts.width ? ts.width() : w - 60, p0 = this.chart.panes && this.chart.panes()[0];
    c.save(); c.beginPath(); c.rect(0, 0, pw, p0 ? p0.getHeight() : h - 26); c.clip();
    c.lineWidth = 2; c.strokeStyle = "#2962ff"; c.font = "11px sans-serif";
    for (const d of this.tmp ? [...this.dr, this.tmp] : this.dr) {
      if (d.k === "h") { const y = this.series.priceToCoordinate(d.p); if (y == null) continue;
        c.beginPath(); c.moveTo(0, y); c.lineTo(pw, y); c.stroke();
        c.fillStyle = "#2962ff"; c.fillRect(pw - 70, y - 9, 70, 18); c.fillStyle = "#fff"; c.fillText(fmt(d.p), pw - 64, y + 4); continue; }
      const x1 = ts.timeToCoordinate(d.t1), x2 = ts.timeToCoordinate(d.t2), y1 = this.series.priceToCoordinate(d.p1), y2 = this.series.priceToCoordinate(d.p2);
      if ([x1, x2, y1, y2].some(v => v == null)) continue;
      if (d.k === "rect") { c.fillStyle = "rgba(41,98,255,.15)"; c.fillRect(x1, y1, x2 - x1, y2 - y1); c.strokeRect(x1, y1, x2 - x1, y2 - y1); }
      else { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
    }
    c.restore();
  }
  destroy() { this.send({op: "unsub"}); this.chart.remove(); this.el.remove(); }
}

function render(n) {
  panes.forEach(p => p.destroy());
  const [cols, rows] = LAYOUT[n], g = $("#grid");
  g.style.gridTemplateColumns = `repeat(${cols},1fr)`; g.style.gridTemplateRows = `repeat(${rows},1fr)`;
  panes = Array.from({length: n}, (_, i) => new Pane(i));
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { $("#status").textContent = "● live"; panes.forEach(p => p.key && p.subscribe()); };
  ws.onmessage = e => { const m = JSON.parse(e.data), p = panes[m.pane]; if (p && p.key === m.k) p.onBar(m.bar); };
  ws.onclose = () => { $("#status").textContent = "reconnecting…"; setTimeout(connect, 2000); };
}

(async () => {
  catalog = await (await fetch("/api/catalog")).json();
  cfg = (JSON.parse(localStorage.getItem("cfg2") || "null") || DEFAULTS).map((k, i) => {
    const [s, y] = k.split("|"), p = catalog[s]; return p && (y in p.symbols || (p.custom && y)) ? k : DEFAULTS[i]; });
  const sel = $("#count");
  Object.keys(LAYOUT).forEach(n => sel.append(new Option(n, n)));
  sel.value = LAYOUT[localStorage.getItem("count")] ? localStorage.getItem("count") : "4";
  sel.onchange = () => { localStorage.setItem("count", sel.value); render(+sel.value); };
  document.addEventListener("keydown", e => { if (e.key === "Escape") panes.forEach(p => p.setTool("cursor")); });
  connect(); render(+sel.value);
  (function loop() { panes.forEach(p => p.draw()); requestAnimationFrame(loop); })();
})();
