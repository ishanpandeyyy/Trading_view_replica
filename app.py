import json, queue
from flask import Flask, jsonify, request
from flask_sock import Sock
import data_source as ds

app = Flask(__name__, static_folder="static", static_url_path="")
sock = Sock(app)


@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.route("/api/catalog")
def catalog():
    return jsonify(ds.catalog())


@app.route("/api/history")
def history():
    try:
        a = request.args
        return jsonify(ds.history(a["source"], a["symbol"], a["tf"]))
    except Exception as e:
        return jsonify(error=str(e)), 502


@sock.route("/ws")  # one browser socket carries every pane's live bars
def live(ws):
    subs = {}  # pane id -> (key, queue)

    def drop(pane):
        old = subs.pop(pane, None)
        if old:
            ds.hub.unsubscribe(*old)
    try:
        while True:
            msg = ws.receive(timeout=0.1)
            if msg:
                m = json.loads(msg)
                drop(m["pane"])
                key = (m.get("source"), m.get("symbol"), m.get("tf"))
                if m["op"] == "sub" and ds.valid(*key):
                    subs[m["pane"]] = (key, ds.hub.subscribe(key))
            for pane, (key, q) in list(subs.items()):
                while True:
                    try:
                        bar = q.get_nowait()
                    except queue.Empty:
                        break
                    ws.send(json.dumps({"pane": pane, "k": "|".join(key), "bar": bar}))
    except Exception:
        pass
    finally:
        for pane in list(subs):
            drop(pane)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, threaded=True)
