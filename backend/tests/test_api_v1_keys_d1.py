"""
D1 path of the v1 API-key store (CHAMPDF_KEYS_BACKEND=d1).

A stdlib http.server plays the Worker's d1.champdf.internal outbound handler:
it checks the internal token, maps named statements from
cloudflare/containers/src/statements.json to SQL, runs each batch in one
transaction against a SQLite file built from migrations/0001_champdf_init.sql,
and answers in the D1 batch shape. Contract: cloudflare/containers/PHASE1.md s5.

Run:  cd backend && python -m pytest tests/test_api_v1_keys_d1.py -v
"""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
CF_DIR = BACKEND_DIR.parent / "cloudflare" / "containers"
STATEMENTS = json.loads((CF_DIR / "src" / "statements.json").read_text())
MIGRATION = (CF_DIR / "migrations" / "0001_champdf_init.sql").read_text()

TOKEN = "test-internal-token"
ADMIN_TOKEN = "test-admin-token"

import api_v1  # noqa: E402


def _fake_d1(db_path: Path) -> ThreadingHTTPServer:
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status: int, body) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.headers.get("x-champdf-internal") != TOKEN:
                return self._send(401, {"detail": "unauthorized"})
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            batch = body["batch"]
            for s in batch:
                sql = STATEMENTS.get(s["q"])
                if sql is None or len(s["params"]) != sql.count("?"):
                    return self._send(400, {"detail": f"bad statement {s['q']}"})
            out = []
            with lock:
                conn = sqlite3.connect(db_path)
                conn.row_factory = sqlite3.Row
                try:
                    with conn:  # one transaction, like DB.batch()
                        for s in batch:
                            cur = conn.execute(STATEMENTS[s["q"]], s["params"])
                            out.append({
                                "results": [dict(r) for r in cur.fetchall()],
                                "success": True,
                                "meta": {"changes": max(cur.rowcount, 0), "last_row_id": cur.lastrowid or 0},
                            })
                except sqlite3.Error as e:
                    return self._send(500, {"detail": f"d1 batch failed: {e}"})
                finally:
                    conn.close()
            self._send(200, out)

    return ThreadingHTTPServer(("127.0.0.1", 0), Handler)


@pytest.fixture
def d1(tmp_path, monkeypatch):
    db_path = tmp_path / "d1.sqlite"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(MIGRATION)
    server = _fake_d1(db_path)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("CHAMPDF_KEYS_BACKEND", "d1")
    monkeypatch.setenv("CHAMPDF_D1_URL", f"http://127.0.0.1:{server.server_address[1]}/")
    monkeypatch.setenv("CHAMPDF_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("CHAMPDF_ADMIN_TOKEN", ADMIN_TOKEN)
    # Point the sqlite path somewhere empty so a fallthrough to sqlite cannot pass a test.
    monkeypatch.setenv("CHAMPDF_DB_PATH", str(tmp_path / "must-stay-unused.db"))
    api_v1._burst_window.clear()  # ids restart at 1 here; other suites may have filled those windows
    server.db_path = db_path
    yield server
    server.shutdown()
    server.server_close()
    assert not (tmp_path / "must-stay-unused.db").exists(), "d1 mode touched the sqlite file"


def _rows(server, sql, *params):
    with sqlite3.connect(server.db_path) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(sql, params)]


@pytest.fixture
def client(d1):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(api_v1.router)
    return TestClient(app)


# --------------------------------------------------------------------------
# Store functions
# --------------------------------------------------------------------------


def test_init_db_probes_health(d1):
    api_v1.init_db()  # no exception, no sqlite file (checked in the fixture)


def test_init_db_logs_and_continues_when_store_down(d1, caplog, monkeypatch):
    monkeypatch.setenv("CHAMPDF_INTERNAL_TOKEN", "wrong")
    api_v1.init_db()
    assert any(r.levelname == "ERROR" for r in caplog.records)


def test_create_and_by_hash(d1):
    rec = api_v1.create_key("alpha", monthly_quota=50, scopes=["pdf.sign"])
    assert rec["id"] == 1 and rec["scopes"] == ["pdf.sign"]
    row = api_v1.get_key_by_hash(api_v1._hash_key(rec["key"]))
    assert row["id"] == 1 and row["label"] == "alpha" and row["monthly_quota"] == 50
    assert row["scopes"] == "pdf.sign" and row["requests_used"] == 0 and row["disabled_at"] is None
    assert api_v1.create_key("beta")["id"] == 2
    assert api_v1.get_key_by_hash("0" * 64) is None


def test_active_for_clerk(d1):
    api_v1.create_key("old", clerk_user_id="user_1")
    newer = api_v1.create_key("new", clerk_user_id="user_1")
    api_v1.create_key("other", clerk_user_id="user_2")
    assert api_v1.get_active_key_for_clerk_user("user_1")["id"] == newer["id"]
    assert api_v1.revoke_key(newer["id"])
    assert api_v1.get_active_key_for_clerk_user("user_1")["label"] == "old"
    assert api_v1.get_active_key_for_clerk_user("nobody") is None


def test_list_keys(d1):
    api_v1.create_key("a")
    api_v1.create_key("b", scopes=["image"])
    keys = api_v1.list_keys()
    assert [k["label"] for k in keys] == ["b", "a"]
    assert set(keys[0]) == {"id", "label", "monthly_quota", "month_bucket", "requests_used",
                            "created_at", "last_used_at", "disabled_at", "scopes"}
    assert keys[0]["scopes"] == "image"


def test_revoke_true_then_false(d1):
    rec = api_v1.create_key("r")
    assert api_v1.revoke_key(rec["id"]) is True
    assert api_v1.revoke_key(rec["id"]) is False
    assert api_v1.revoke_key(999) is False
    assert api_v1.get_key_by_hash(api_v1._hash_key(rec["key"]))["disabled_at"]


def test_record_request_bumps_usage_and_logs(d1):
    rec = api_v1.create_key("u")
    api_v1._record_request(rec["id"], "whoami", 200, 12)
    api_v1._record_request(rec["id"], "whoami", 200, 7)
    key = _rows(d1, "SELECT * FROM api_keys WHERE id = ?", rec["id"])[0]
    assert key["requests_used"] == 2 and key["last_used_at"]
    logs = _rows(d1, "SELECT key_id, endpoint, status, latency_ms FROM request_log ORDER BY id")
    assert logs == [
        {"key_id": rec["id"], "endpoint": "whoami", "status": 200, "latency_ms": 12},
        {"key_id": rec["id"], "endpoint": "whoami", "status": 200, "latency_ms": 7},
    ]


def test_record_request_month_rollover_resets_to_1(d1):
    rec = api_v1.create_key("m")
    with sqlite3.connect(d1.db_path) as conn:
        conn.execute("UPDATE api_keys SET month_bucket = '2000-01', requests_used = 7 WHERE id = ?", (rec["id"],))
    api_v1._record_request(rec["id"], "x", 200, 1)
    key = _rows(d1, "SELECT * FROM api_keys WHERE id = ?", rec["id"])[0]
    assert key["requests_used"] == 1 and key["month_bucket"] == api_v1._current_month_bucket()


def test_record_request_swallows_store_down(d1, caplog):
    d1.shutdown()
    d1.server_close()
    api_v1._record_request(1, "x", 200, 1)  # must not raise: it runs on the way out
    assert any("usage not recorded" in r.getMessage() for r in caplog.records)


# --------------------------------------------------------------------------
# HTTP, v1 router
# --------------------------------------------------------------------------


def _admin_create(client) -> dict:
    res = client.post("/api/v1/admin/keys", headers={"X-Admin-Token": ADMIN_TOKEN}, json={"label": "http"})
    assert res.status_code == 200, res.text
    return res.json()


def test_http_admin_create_whoami_revoke(client):
    rec = _admin_create(client)
    auth = {"Authorization": f"Bearer {rec['key']}"}
    res = client.get("/api/v1/whoami", headers=auth)
    assert res.status_code == 200, res.text
    assert res.json()["id"] == rec["id"] and res.json()["label"] == "http"
    assert client.get("/api/v1/admin/keys", headers={"X-Admin-Token": ADMIN_TOKEN}).json()[0]["id"] == rec["id"]
    assert client.delete(f"/api/v1/admin/keys/{rec['id']}", headers={"X-Admin-Token": ADMIN_TOKEN}).status_code == 200
    res = client.get("/api/v1/whoami", headers=auth)
    assert res.status_code == 401 and "revoked" in res.json()["detail"]


def test_http_unknown_key_is_401(client):
    res = client.get("/api/v1/whoami", headers={"Authorization": f"Bearer {api_v1.API_KEY_PREFIX}{'0' * 48}"})
    assert res.status_code == 401


def test_http_store_down_is_503_not_401(client, d1):
    rec = _admin_create(client)
    d1.shutdown()
    d1.server_close()
    res = client.get("/api/v1/whoami", headers={"Authorization": f"Bearer {rec['key']}"})
    assert res.status_code == 503, res.text
    assert res.json()["detail"] == {"code": "key_store_unavailable"}


@pytest.mark.parametrize("token", ["wrong-token", None])
def test_http_bad_or_missing_internal_token_is_503(client, monkeypatch, token):
    rec = _admin_create(client)
    if token:
        monkeypatch.setenv("CHAMPDF_INTERNAL_TOKEN", token)
    else:
        monkeypatch.delenv("CHAMPDF_INTERNAL_TOKEN")
    res = client.get("/api/v1/whoami", headers={"Authorization": f"Bearer {rec['key']}"})
    assert res.status_code == 503, res.text
    assert res.json()["detail"] == {"code": "key_store_unavailable"}
