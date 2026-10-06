# Local Trading Dashboard

    python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
    pip install -r requirements.txt
    python app.py                                          # open http://127.0.0.1:5000

- Crypto: Hyperliquid websocket (no key). Indian equities + gold/silver/oil futures: yfinance, polled every 5s (no key, ~15 min delayed on some symbols).
- Add a broker: write `history(symbol, tf)` (+ optional `stream(...)`) in `data_source.py` and call `register(...)`.
- Chart library loads from unpkg (needs internet once; browser caches it).
# Trading_view_replica
# Trading_view_replica
