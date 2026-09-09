"""
ChampPDF Sign: the dry run, as a test.

Definition of done from the DPRD: an external address that has never touched
our systems receives an invitation, opens it, verifies an OTP, signs a mutual
NDA, and both parties hold a sealed PDF with a certificate of completion.
Every step is in the audit table with an intact hash chain.

Runs against a minimal app that mounts only the Sign router, with the log
mailer (OTPs are read from the outbox), local write-once storage, the native
provider and a generated self-signed seal. No network.

Run:  pytest backend/tests/test_sign_flow.py -v
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

ADMIN_TOKEN = "test-admin-token"
BASE = "https://champdf.test"
LINK_RE = re.compile(r"https://champdf\.test/s/([A-Za-z0-9_-]+)")
OTP_RE = re.compile(r"\b(\d{6})\b")

_ip_counter = [10]


def ip() -> dict:
    """A fresh X-Forwarded-For per test so the per-IP page-load limit never bleeds between tests."""
    _ip_counter[0] += 1
    return {"X-Forwarded-For": f"203.0.113.{_ip_counter[0] % 250}"}


ADMIN = {"X-Admin-Token": ADMIN_TOKEN}


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


@pytest.fixture(scope="session")
def client(tmp_path_factory):
    d = tmp_path_factory.mktemp("sign")
    os.environ["CHAMPDF_DB_PATH"] = str(d / "champdf.db")
    os.environ["CHAMPDF_SIGN_DATA_DIR"] = str(d / "signdata")
    os.environ["CHAMPDF_ADMIN_TOKEN"] = ADMIN_TOKEN
    os.environ["SIGN_ADMIN_EMAIL"] = "deep@championsmail.com"
    os.environ["SIGN_ADMIN_NAME"] = "Deep"
    os.environ["SIGN_SEAL_TIMESTAMP"] = "false"  # no TSA on the network in CI
    os.environ["SIGN_PUBLIC_BASE_URL"] = BASE
    os.environ["SIGN_PROVIDER"] = "native"
    os.environ["SIGN_ENTITY_CIN"] = "U65990KA2020PTC000000"
    for k in ("RESEND_API_KEY", "SIGN_STORAGE_BUCKET", "CHAMPBEAM_API_URL", "CLERK_ISSUER", "CLERK_JWKS_URL"):
        os.environ.pop(k, None)

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from sign import mailer, providers, seal, storage, store

    store.init_sign_db()
    storage.reset_storage_for_tests()
    mailer.reset_mailer_for_tests()
    seal.reset_seal_for_tests()
    providers.reset_provider_for_tests()

    from sign.router import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def outbox(client):
    from sign import mailer

    box = mailer.get_mailer().sent
    box.clear()
    return box


def create_doc(client, **overrides):
    body = {
        "template_id": "mutual-nda-v1",
        "fields": {
            "counterparty_entity": "Acme Technologies Private Limited",
            "counterparty_cin": "U72900KA2019PTC123456",
            "counterparty_address": "1 MG Road, Bengaluru 560001",
            "purpose": "Evaluating a B2B data and demand generation engagement.",
            "non_circumvention": "yes",
        },
        "signer": {"name": "Jane Doe", "email": "jane.doe@acme.example", "designation": "Director"},
        "expires_in_days": 14,
    }
    body.update(overrides)
    res = client.post("/api/sign/documents", json=body, headers={**ADMIN, **ip()})
    assert res.status_code == 201, res.text
    return res.json()


def link_from(outbox, kind="invitation") -> str:
    for e in reversed(outbox):
        if e.tags.get("kind") == kind:
            m = LINK_RE.search(e.text)
            assert m, e.text
            return m.group(1)
    raise AssertionError(f"no {kind} email in outbox")


def otp_from(outbox) -> str:
    for e in reversed(outbox):
        if e.tags.get("kind") == "otp":
            m = OTP_RE.search(e.subject)
            assert m, e.subject
            return m.group(1)
    raise AssertionError("no otp email in outbox")


def verify_to_session(client, token: str, outbox) -> str:
    r = client.post(f"/api/sign/s/{token}/otp", headers=ip())
    assert r.status_code == 200, r.text
    code = otp_from(outbox)
    r = client.post(f"/api/sign/s/{token}/otp/verify", json={"code": code}, headers=ip())
    assert r.status_code == 200, r.text
    return r.json()["session_token"]


def bearer(session: str) -> dict:
    return {"Authorization": f"Bearer {session}", **ip()}


def drawn_png() -> str:
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (420, 160), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.line([(20, 120), (120, 40), (200, 130), (300, 50), (400, 110)], fill=(20, 30, 90, 255), width=6)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


# --------------------------------------------------------------------------
# Status, templates, validation
# --------------------------------------------------------------------------


def test_status_and_templates(client):
    r = client.get("/api/sign/status")
    assert r.status_code == 200
    s = r.json()
    assert s["enabled"] is True
    assert s["provider"]["name"] == "native"
    assert s["mail_configured"] is False
    assert s["seal_self_signed"] is True
    assert "mutual-nda-v1" in s["templates"]

    r = client.get("/api/sign/templates", headers=ADMIN)
    assert r.status_code == 200
    t = {x["id"]: x for x in r.json()["templates"]}["mutual-nda-v1"]
    keys = [f["key"] for f in t["fields"]]
    assert "counterparty_entity" in keys and "purpose" in keys
    assert t["instrument_class"] == "commercial_agreement"
    assert r.json()["role"] == "admin"


def test_sender_auth(client):
    assert client.get("/api/sign/templates").status_code == 503  # Clerk not configured
    assert client.get("/api/sign/templates", headers={"X-Admin-Token": "nope"}).status_code == 401


def test_preview_renders_pdf(client):
    r = client.post(
        "/api/sign/documents/preview",
        json={"template_id": "mutual-nda-v1", "fields": {
            "counterparty_entity": "Acme", "counterparty_address": "1 MG Road", "purpose": "Testing"}},
        headers=ADMIN,
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/pdf")
    assert r.content.startswith(b"%PDF")


def test_validation_errors(client):
    r = client.post("/api/sign/documents", json={
        "template_id": "mutual-nda-v1", "fields": {"counterparty_entity": "Acme"},
        "signer": {"name": "Jane", "email": "jane@acme.example"}}, headers=ADMIN)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_field"
    assert r.json()["detail"]["field"] == "counterparty_address"

    r = client.post("/api/sign/documents", json={
        "template_id": "mutual-nda-v1",
        "fields": {"counterparty_entity": "Acme", "counterparty_address": "x", "purpose": "y"},
        "signer": {"name": "Jane", "email": "not-an-email"}}, headers=ADMIN)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_recipient"

    r = client.post("/api/sign/documents", json={
        "template_id": "nope", "fields": {}, "signer": {"name": "Jane", "email": "jane@acme.example"}}, headers=ADMIN)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "unknown_template"


def test_first_schedule_templates_are_refused(tmp_path):
    from sign import templates as tpl

    spec = {"id": "poa-v1", "name": "Power of Attorney", "instrument_class": "power_of_attorney",
            "roles": [{"role": "signer", "party": "counterparty", "label": "Donor"}], "fields": []}
    p = tmp_path / "poa-v1.json"
    p.write_text(json.dumps(spec))
    (tmp_path / "poa-v1.body.html").write_text("<p>x</p>")
    with pytest.raises(tpl.TemplateError):
        tpl._load_template(p)


# --------------------------------------------------------------------------
# The spine
# --------------------------------------------------------------------------


def test_full_spine_typed_signature(client, outbox):
    from sign import store

    doc = create_doc(client)
    assert doc["status"] == "sent"
    assert doc["template_id"] == "mutual-nda-v1"
    assert doc["draft_sha256"] and len(doc["draft_sha256"]) == 64
    assert doc["page_count"] >= 4
    assert doc["recipients"][0]["email"] == "jane.doe@acme.example"
    assert doc["dev_links"], "mail is not configured, so the raw link is returned for the dry run"

    invite = [e for e in outbox if e.tags.get("kind") == "invitation"]
    assert len(invite) == 1 and invite[0].to == ["jane.doe@acme.example"]
    assert invite[0].reply_to == "deep@championsmail.com"
    token = link_from(outbox)
    assert doc["dev_links"][doc["recipients"][0]["id"]].endswith(token)

    # Landing: who sent it, what it is, no signing rights.
    r = client.get(f"/api/sign/s/{token}", headers=ip())
    assert r.status_code == 200, r.text
    assert r.headers["x-robots-tag"].startswith("noindex")
    assert r.headers["referrer-policy"] == "no-referrer"
    land = r.json()
    assert land["next"] == "otp"
    assert land["recipient"]["email_masked"] == "j***@acme.example"
    assert land["document"]["counterparty_entity"] == "Acme Technologies Private Limited"

    # No PDF without a verified session.
    assert client.get(f"/api/sign/s/{token}/document.pdf", headers=ip()).status_code == 401

    # OTP: wrong first, then right.
    r = client.post(f"/api/sign/s/{token}/otp", headers=ip())
    assert r.status_code == 200 and r.json()["sent_to"] == "j***@acme.example"
    code = otp_from(outbox)
    r = client.post(f"/api/sign/s/{token}/otp/verify", json={"code": "000000" if code != "000000" else "111111"}, headers=ip())
    assert r.status_code == 400 and r.json()["detail"]["code"] == "otp_invalid"
    assert r.json()["detail"]["attempts_left"] == 4
    r = client.post(f"/api/sign/s/{token}/otp/verify", json={"code": code}, headers=ip())
    assert r.status_code == 200, r.text
    session = r.json()["session_token"]
    assert r.json()["next"] == "view"

    # Landing with the session now points at the viewer.
    assert client.get(f"/api/sign/s/{token}", headers=bearer(session)).json()["next"] == "view"

    # The PDF is byte-identical to what was hashed at creation.
    r = client.get(f"/api/sign/s/{token}/document.pdf", headers=bearer(session))
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    assert hashlib.sha256(r.content).hexdigest() == doc["draft_sha256"]
    assert r.headers["cache-control"] == "no-store"

    # Read gate is enforced server-side.
    r = client.post(f"/api/sign/s/{token}/sign", json={"kind": "typed", "name": "Jane Doe", "intent": True}, headers=bearer(session))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "read_required"
    r = client.post(f"/api/sign/s/{token}/events", json={"type": "scrolled_to_end"}, headers=bearer(session))
    assert r.status_code == 200 and r.json()["ok"]

    # Intent statement is mandatory.
    r = client.post(f"/api/sign/s/{token}/sign", json={"kind": "typed", "name": "Jane Doe", "intent": False}, headers=bearer(session))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "intent_required"

    # Sign.
    r = client.post(f"/api/sign/s/{token}/sign", json={"kind": "typed", "name": "Jane Doe", "designation": "Director", "intent": True},
                    headers=bearer(session))
    assert r.status_code == 200, r.text
    assert r.json()["executed"] is True

    # Sealed copy for the signer.
    r = client.get(f"/api/sign/s/{token}/download", headers=bearer(session))
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    sealed = r.content
    sealed_sha = hashlib.sha256(sealed).hexdigest()

    # Sender's view: executed, hash recorded in the database matches the file.
    r = client.get(f"/api/sign/documents/{doc['id']}", headers=ADMIN)
    assert r.status_code == 200
    d = r.json()
    assert d["status"] == "executed"
    assert d["content_sha256"] == sealed_sha
    assert d["chain"]["ok"] is True
    assert d["seal"]["sealed"] is True and d["seal"]["self_signed"] is True
    types = [e["event_type"] for e in d["events"]]
    for expected in ("document.created", "document.sent", "link.opened", "otp.requested", "otp.failed", "otp.verified",
                     "document.viewed", "document.scrolled_to_end", "signature.applied", "document.signed",
                     "document.executed", "copy.downloaded"):
        assert expected in types, types
    assert types.index("document.signed") < types.index("document.executed")
    assert d["chain_head_at_execution"]
    # The chain head embedded at execution is the hash of the last event before document.executed.
    executed_idx = types.index("document.executed")
    assert d["events"][executed_idx]["prev_hash"] == d["chain_head_at_execution"]

    # Hash chain: every event links to the previous one.
    events = d["events"]
    assert events[0]["prev_hash"] == "0" * 64
    for prev, cur in zip(events, events[1:]):
        assert cur["prev_hash"] == prev["event_hash"]

    # Independent verification endpoint: chain, draft hash, sealed hash, PAdES seal intact.
    r = client.get(f"/api/sign/documents/{doc['id']}/verify", headers=ADMIN)
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["ok"] is True and v["chain"]["ok"] and v["draft"]["ok"] and v["sealed"]["ok"]
    assert v["sealed"]["seal_intact"] is True
    assert v["sealed"]["signatures"]["signature_count"] == 1

    # Certificate of completion is in the sealed file and carries the evidence.
    import pymupdf

    pdf = pymupdf.open("pdf", sealed)
    text = "\n".join(p.get_text() for p in pdf)
    assert "CERTIFICATE OF COMPLETION" in text
    assert doc["draft_sha256"] in text
    assert d["chain_head_at_execution"] in text
    assert "jane.doe@acme.example" in text
    assert "otp.verified" in text and "document.scrolled_to_end" in text
    exec_page = pdf[doc["page_count"] - 1].get_text()
    assert "Signed electronically via ChampPDF Sign" in exec_page

    # Both parties get the sealed file, attached, with the hash in the body.
    executed = [e for e in outbox if e.tags.get("kind") == "executed"]
    assert sorted(e.to[0] for e in executed) == ["deep@championsmail.com", "jane.doe@acme.example"]
    for e in executed:
        assert len(e.attachments) == 1
        assert hashlib.sha256(e.attachments[0].content).hexdigest() == sealed_sha
        assert sealed_sha in e.text

    # Done state and idempotence.
    assert client.get(f"/api/sign/s/{token}", headers=bearer(session)).json()["next"] == "done"
    r = client.post(f"/api/sign/s/{token}/sign", json={"kind": "typed", "name": "Jane Doe", "intent": True}, headers=bearer(session))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_signed"

    # Sealed object is write-once.
    from sign.storage import StorageError, get_storage

    with pytest.raises(StorageError):
        get_storage().put(f"sign/{doc['id']}/executed.pdf", b"tamper")

    # And the audit table refuses edits at the database level.
    with sqlite3.connect(os.environ["CHAMPDF_DB_PATH"]) as conn:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE sign_audit_events SET event_type = 'x' WHERE document_id = ?", (doc["id"],))
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("DELETE FROM sign_audit_events WHERE document_id = ?", (doc["id"],))
    assert store.verify_chain(doc["id"])["ok"]


def test_drawn_signature_is_embedded(client, outbox):
    doc = create_doc(client, signer={"name": "Ravi Kumar", "email": "ravi@gorisco.example", "designation": "CEO"})
    token = link_from(outbox)
    session = verify_to_session(client, token, outbox)
    client.get(f"/api/sign/s/{token}/document.pdf", headers=bearer(session))
    client.post(f"/api/sign/s/{token}/events", json={"type": "scrolled_to_end"}, headers=bearer(session))

    r = client.post(f"/api/sign/s/{token}/sign", json={"kind": "drawn", "name": "Ravi Kumar", "intent": True,
                                                     "image_png_b64": "data:image/png;base64," + drawn_png()},
                    headers=bearer(session))
    assert r.status_code == 200, r.text
    assert r.json()["executed"] is True

    r = client.get(f"/api/sign/documents/{doc['id']}/download", headers=ADMIN)
    assert r.status_code == 200 and r.headers["x-champdf-sign-file"] == "executed"
    import pymupdf

    pdf = pymupdf.open("pdf", r.content)
    assert pdf[doc["page_count"] - 1].get_images(), "drawn signature should be embedded as an image on the execution page"

    # Garbage image is rejected before anything is stamped.
    doc2 = create_doc(client, signer={"name": "Asha", "email": "asha@egs.example"})
    token2 = link_from(outbox)
    s2 = verify_to_session(client, token2, outbox)
    client.get(f"/api/sign/s/{token2}/document.pdf", headers=bearer(s2))
    client.post(f"/api/sign/s/{token2}/events", json={"type": "scrolled_to_end"}, headers=bearer(s2))
    r = client.post(f"/api/sign/s/{token2}/sign", json={"kind": "drawn", "name": "Asha", "intent": True,
                                                      "image_png_b64": base64.b64encode(b"not a png").decode()},
                    headers=bearer(s2))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_signature"
    assert client.get(f"/api/sign/documents/{doc2['id']}", headers=ADMIN).json()["status"] == "viewed"


def test_countersigner_sequential_flow(client, outbox):
    doc = create_doc(client, countersigner={"name": "Sreedeep Surapaneni", "email": "deep@championsmail.com", "designation": "Director"})
    assert [r["role"] for r in doc["recipients"]] == ["signer", "countersigner"]
    # Only the first party is invited at send time.
    assert [e.to[0] for e in outbox if e.tags.get("kind") == "invitation"] == ["jane.doe@acme.example"]

    token = link_from(outbox)
    session = verify_to_session(client, token, outbox)
    client.get(f"/api/sign/s/{token}/document.pdf", headers=bearer(session))
    client.post(f"/api/sign/s/{token}/events", json={"type": "scrolled_to_end"}, headers=bearer(session))
    r = client.post(f"/api/sign/s/{token}/sign", json={"kind": "typed", "name": "Jane Doe", "intent": True}, headers=bearer(session))
    assert r.status_code == 200 and r.json()["executed"] is False and r.json()["status"] == "signed"

    # Countersigner is now invited and completes execution.
    token2 = link_from(outbox)
    assert token2 != token
    s2 = verify_to_session(client, token2, outbox)
    client.get(f"/api/sign/s/{token2}/document.pdf", headers=bearer(s2))
    client.post(f"/api/sign/s/{token2}/events", json={"type": "scrolled_to_end"}, headers=bearer(s2))
    r = client.post(f"/api/sign/s/{token2}/sign", json={"kind": "typed", "name": "Sreedeep Surapaneni", "intent": True}, headers=bearer(s2))
    assert r.status_code == 200 and r.json()["executed"] is True

    d = client.get(f"/api/sign/documents/{doc['id']}", headers=ADMIN).json()
    types = [e["event_type"] for e in d["events"]]
    assert "document.signed" in types and "document.countersigned" in types
    assert types.index("document.countersigned") < types.index("document.executed")
    assert all(r["status"] == "signed" for r in d["recipients"])


# --------------------------------------------------------------------------
# Failure modes the DPRD cares about
# --------------------------------------------------------------------------


def test_otp_lockout_notifies_sender_and_resend_rotates_token(client, outbox):
    doc = create_doc(client)
    token = link_from(outbox)
    assert client.post(f"/api/sign/s/{token}/otp", headers=ip()).status_code == 200
    real = otp_from(outbox)
    wrong = "123456" if real != "123456" else "654321"
    codes = []
    for _ in range(5):
        r = client.post(f"/api/sign/s/{token}/otp/verify", json={"code": wrong}, headers=ip())
        codes.append(r.status_code)
    assert codes == [400, 400, 400, 400, 423]
    assert client.get(f"/api/sign/s/{token}", headers=ip()).json()["detail"]["code"] == "locked"
    locked = [e for e in outbox if e.tags.get("kind") == "otp_locked"]
    assert locked and locked[0].to == ["deep@championsmail.com"]

    d = client.get(f"/api/sign/documents/{doc['id']}", headers=ADMIN).json()
    assert d["recipients"][0]["locked"] is True
    assert "token.locked" in [e["event_type"] for e in d["events"]]

    # Resend: fresh token, old one dead.
    r = client.post(f"/api/sign/documents/{doc['id']}/resend", json={}, headers={**ADMIN, **ip()})
    assert r.status_code == 200, r.text
    assert r.json()["recipients"][0]["locked"] is False
    new_token = link_from(outbox)
    assert new_token != token
    assert client.get(f"/api/sign/s/{token}", headers=ip()).status_code == 404
    assert client.get(f"/api/sign/s/{new_token}", headers=ip()).status_code == 200


def test_void_returns_410(client, outbox):
    doc = create_doc(client)
    token = link_from(outbox)
    r = client.post(f"/api/sign/documents/{doc['id']}/void", json={"reason": "wrong counterparty"}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["status"] == "voided"
    r = client.get(f"/api/sign/s/{token}", headers=ip())
    assert r.status_code == 410 and r.json()["detail"]["code"] == "voided"
    assert client.post(f"/api/sign/documents/{doc['id']}/void", json={}, headers=ADMIN).status_code == 409
    assert client.post(f"/api/sign/s/{token}/otp", headers=ip()).status_code == 410
    d = client.get(f"/api/sign/documents/{doc['id']}", headers=ADMIN).json()
    assert "document.voided" in [e["event_type"] for e in d["events"]] and "link.rejected" in [e["event_type"] for e in d["events"]]


def test_expired_link_returns_410(client, outbox):
    doc = create_doc(client, expires_in_days=1)
    token = link_from(outbox)
    with sqlite3.connect(os.environ["CHAMPDF_DB_PATH"]) as conn:
        conn.execute("UPDATE sign_documents SET expires_at = '2020-01-01T00:00:00.000000Z' WHERE id = ?", (doc["id"],))
    r = client.get(f"/api/sign/s/{token}", headers=ip())
    assert r.status_code == 410 and r.json()["detail"]["code"] == "expired"
    d = client.get(f"/api/sign/documents/{doc['id']}", headers=ADMIN).json()
    assert d["status"] == "expired"
    assert "document.expired" in [e["event_type"] for e in d["events"]]
    assert client.post(f"/api/sign/documents/{doc['id']}/resend", json={}, headers=ADMIN).status_code == 409


def test_otp_request_limit_and_page_load_limit(client, outbox):
    create_doc(client)
    token = link_from(outbox)
    statuses = [client.post(f"/api/sign/s/{token}/otp", headers=ip()).status_code for _ in range(6)]
    assert statuses == [200] * 5 + [429]

    fixed = {"X-Forwarded-For": "198.51.100.77"}
    loads = [client.get(f"/api/sign/s/{token}", headers=fixed).status_code for _ in range(61)]
    assert loads[:60] == [200] * 60 and loads[60] == 429


def test_session_expiry_is_enforced(client, outbox):
    create_doc(client)
    token = link_from(outbox)
    session = verify_to_session(client, token, outbox)
    with sqlite3.connect(os.environ["CHAMPDF_DB_PATH"]) as conn:
        conn.execute("UPDATE sign_recipients SET session_expires_at = '2020-01-01T00:00:00.000000Z'")
    r = client.get(f"/api/sign/s/{token}/document.pdf", headers=bearer(session))
    assert r.status_code == 401 and r.json()["detail"]["code"] == "session_invalid"


def test_list_and_ownership(client):
    r = client.get("/api/sign/documents", headers=ADMIN)
    assert r.status_code == 200 and len(r.json()["documents"]) >= 3
    assert client.get("/api/sign/documents/does-not-exist", headers=ADMIN).status_code == 404


# --------------------------------------------------------------------------
# Delivery webhooks
# --------------------------------------------------------------------------


def _svix_headers(secret_b64: str, body: bytes) -> dict:
    import hmac

    msg_id, ts = "msg_test", str(int(time.time()))
    signed = f"{msg_id}.{ts}.".encode() + body
    sig = base64.b64encode(hmac.new(base64.b64decode(secret_b64), signed, hashlib.sha256).digest()).decode()
    return {"svix-id": msg_id, "svix-timestamp": ts, "svix-signature": f"v1,{sig}"}


def test_resend_webhook_records_delivery(client, outbox, monkeypatch):
    secret = base64.b64encode(b"0123456789abcdef0123456789abcdef").decode()
    monkeypatch.setenv("RESEND_WEBHOOK_SECRET", f"whsec_{secret}")
    doc = create_doc(client)
    rid = doc["recipients"][0]["id"]
    payload = json.dumps({"type": "email.delivered", "created_at": "2026-09-10T00:00:00Z",
                          "data": {"email_id": "em_1", "to": ["jane.doe@acme.example"],
                                   "tags": {"kind": "invitation", "document_id": doc["id"], "recipient_id": rid}}}).encode()
    r = client.post("/api/sign/webhooks/resend", content=payload, headers={**_svix_headers(secret, payload), "content-type": "application/json"})
    assert r.status_code == 200 and r.json()["recorded"] is True
    d = client.get(f"/api/sign/documents/{doc['id']}", headers=ADMIN).json()
    assert "invitation.delivered" in [e["event_type"] for e in d["events"]]

    r = client.post("/api/sign/webhooks/resend", content=payload, headers={"content-type": "application/json"})
    assert r.status_code == 401


# --------------------------------------------------------------------------
# Roles
# --------------------------------------------------------------------------


def test_role_resolution():
    from sign.auth import _role_from_claims

    assert _role_from_claims({}) == "member"
    assert _role_from_claims({"org_role": "org:admin"}) == "admin"
    assert _role_from_claims({"o": {"rol": "admin"}}) == "admin"
    assert _role_from_claims({"champdf_sign_role": "legal"}) == "legal"
    assert _role_from_claims({"public_metadata": {"champdf_sign_role": "admin"}}) == "admin"
    assert _role_from_claims({"champdf_sign_role": "superuser"}) == "member"
