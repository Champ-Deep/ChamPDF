#!/usr/bin/env python3
"""Backend smoke test for a running ChamPDF API (local or deployed).

    CHAMPDF_ADMIN_TOKEN=<token> python scripts/smoke_backend.py [BASE_URL]

BASE_URL defaults to http://localhost:8000. Exits non-zero if any check fails.
Needs PyMuPDF (already in backend/requirements.txt) to make a sample PDF.
"""
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

import fitz

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")
TOKEN = os.environ.get("CHAMPDF_ADMIN_TOKEN", "")
failed = 0


def call(method, path, headers=None, body=None, ctype=None):
    h = dict(headers or {})
    if ctype:
        h["Content-Type"] = ctype
    req = urllib.request.Request(BASE + path, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except OSError as e:
        return 0, str(e).encode()


def check(name, ok, detail=""):
    global failed
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"  -> {detail}"))
    failed += not ok


def multipart(files):
    b = uuid.uuid4().hex
    out = b""
    for field, (fname, data) in files.items():
        out += f'--{b}\r\nContent-Disposition: form-data; name="{field}"; filename="{fname}"\r\nContent-Type: application/pdf\r\n\r\n'.encode() + data + b"\r\n"
    return out + f"--{b}--\r\n".encode(), f"multipart/form-data; boundary={b}"


doc = fitz.open()
doc.new_page().insert_text((72, 72), "ChamPDF smoke test")
pdf = doc.tobytes()

s, b = call("GET", "/health")
check("GET /health is healthy", s == 200 and b'"healthy"' in b, f"{s} {b[:120]}")

s, b = call("GET", "/api/capabilities")
check("GET /api/capabilities", s == 200 and b.startswith(b"{"), f"{s} {b[:120]}")

s, b = call("GET", "/api/sign/status")
check("GET /api/sign/status", s == 200 and json.loads(b).get("enabled") is True, f"{s} {b[:160]}")

if not TOKEN:
    print("SKIP  admin checks (set CHAMPDF_ADMIN_TOKEN on both server and this shell)")
else:
    adm = {"X-Admin-Token": TOKEN}
    s, b = call("POST", "/api/v1/admin/keys", adm, json.dumps({"label": "smoke", "monthly_quota": 50}).encode(), "application/json")
    check("admin issues an API key", s == 200 and b"key" in b, f"{s} {b[:160]}")
    made = json.loads(b) if s == 200 else {}
    key = made.get("key")
    if key:
        auth = {"Authorization": f"Bearer {key}"}
        body, ct = multipart({"file": ("a.pdf", pdf)})
        s, b = call("POST", "/api/v1/pdf/info", auth, body, ct)
        check("v1 pdf/info reports 1 page", s == 200 and json.loads(b).get("page_count", json.loads(b).get("pages")) == 1, f"{s} {b[:160]}")
        s, b = call("DELETE", f"/api/v1/admin/keys/{made['id']}", adm)
        check("admin revokes the smoke key", s == 200, f"{s} {b[:120]}")
    s, b = call("GET", "/api/sign/templates", adm)
    check("sign templates list (admin token)", s == 200 and b"templates" in b, f"{s} {b[:160]}")

print("\nFAILED" if failed else "\nALL PASSED")
sys.exit(1 if failed else 0)
