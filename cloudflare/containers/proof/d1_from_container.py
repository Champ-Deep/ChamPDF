"""Run INSIDE the container (docker exec ... python /dev/stdin < d1_from_container.py).
Proves the container reaches D1 and R2 only through the Worker outbound handlers, with no SDK and no credentials.
"""
import json, sys, urllib.request

def post(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

mode = sys.argv[1] if len(sys.argv) > 1 else "write"
if mode == "write":
    out = post("http://d1.champdf.internal/", {"statements": [
        {"sql": "INSERT INTO api_keys (key_hash,label,month_bucket,created_at) VALUES (?,?,?,?)", "params": ["proofhash-" + sys.argv[2], "container-proof", "2026-10", "2026-10-24T00:00:00Z"]},
        {"sql": "SELECT count(*) AS n FROM api_keys WHERE label='container-proof'"},
    ]})
    req = urllib.request.Request("http://r2.champdf.internal/proof/" + sys.argv[2], data=b"%PDF-1.7 synthetic", method="PUT")
    print(json.dumps({"d1_rows": out[1]["results"], "r2_put": urllib.request.urlopen(req, timeout=20).status}))
else:
    out = post("http://d1.champdf.internal/", {"statements": [{"sql": "SELECT count(*) AS n FROM api_keys WHERE label='container-proof'"}]})
    got = urllib.request.urlopen("http://r2.champdf.internal/proof/" + sys.argv[2], timeout=20).read()
    print(json.dumps({"d1_rows": out[0]["results"], "r2_object": got.decode()}))
