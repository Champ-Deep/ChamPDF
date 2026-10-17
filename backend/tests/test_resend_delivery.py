"""
Resend is the delivery layer for legally significant mail. Two failures matter.

  1. A signer gets two copies of an invitation, or two OTPs, because a send was
     retried or a double-clicked button fired twice. Two live OTP codes, two
     links, two copies in the recipient's inbox: all of it destroys confidence
     in the audit trail.
  2. Resend's inbound webhooks are unsigned, or signed with a stale timestamp,
     or replayed. Any of those lets a third party append forged audit events.

These tests pin the behaviour of the mailer and the webhook endpoint directly.

Run:  pytest backend/tests/test_resend_delivery.py -v
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))


SECRET_B64 = base64.b64encode(b"0123456789abcdef0123456789abcdef").decode()
SECRET = f"whsec_{SECRET_B64}"


def svix_headers(body: bytes, msg_id: str = "msg_1", ts: int | None = None) -> dict:
    ts = str(ts if ts is not None else int(time.time()))
    signed = f"{msg_id}.{ts}.".encode() + body
    sig = base64.b64encode(hmac.new(base64.b64decode(SECRET_B64), signed, hashlib.sha256).digest()).decode()
    return {"svix-id": msg_id, "svix-timestamp": ts, "svix-signature": f"v1,{sig}"}


# --------------------------------------------------------------------------
# Idempotency: the same logical send must not produce two messages
# --------------------------------------------------------------------------


def test_idempotency_key_is_stable_for_the_same_email():
    """
    RED first: ResendMailer had no Idempotency-Key, so a retry after a timeout
    delivered a second copy. The key must derive from the message's identity
    (kind, document, recipient, content), not from wall-clock time.
    """
    from sign import mailer

    email = mailer.invitation_email(
        to="jane.doe@acme.example", recipient_name="Jane", sender_name="Deep",
        sender_email="deep@championsmail.com", entity="Champions Superior Capital",
        title="Mutual NDA", link="https://champdf.test/s/abc", expires_at_text="in 14 days",
        document_id="doc1", recipient_id="rec1",
    )
    key1 = mailer.idempotency_key(email)
    key2 = mailer.idempotency_key(email)
    assert key1 == key2
    assert len(key1) <= 255

    # A different document or recipient is a different send.
    other = mailer.invitation_email(
        to="jane.doe@acme.example", recipient_name="Jane", sender_name="Deep",
        sender_email="deep@championsmail.com", entity="Champions Superior Capital",
        title="Mutual NDA", link="https://champdf.test/s/abc", expires_at_text="in 14 days",
        document_id="doc2", recipient_id="rec1",
    )
    assert mailer.idempotency_key(other) != key1


def test_idempotency_key_changes_when_the_code_changes():
    """An OTP resend carries a different code, so it must be a distinct send."""
    from sign import mailer

    a = mailer.otp_email(to="jane@acme.example", code="111111", title="Mutual NDA",
                         minutes=10, document_id="doc1", recipient_id="rec1")
    b = mailer.otp_email(to="jane@acme.example", code="222222", title="Mutual NDA",
                         minutes=10, document_id="doc1", recipient_id="rec1")
    assert mailer.idempotency_key(a) != mailer.idempotency_key(b)


def test_resend_mailer_sends_the_idempotency_key_header(monkeypatch):
    """RED first: no header was sent at all."""
    from sign import mailer

    seen = {}

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"id": "em_123"}'

    def fake_urlopen(req, timeout=None):
        seen["headers"] = dict(req.headers)
        seen["url"] = req.full_url
        seen["body"] = json.loads(req.data.decode())
        return _Resp()

    monkeypatch.setattr(mailer.urllib.request, "urlopen", fake_urlopen)

    m = mailer.ResendMailer("re_test_key", "Champions <notifications@sign.championsmail.com>")
    import asyncio

    email = mailer.otp_email(to="jane@acme.example", code="111111", title="Mutual NDA",
                             minutes=10, document_id="doc1", recipient_id="rec1")
    message_id = asyncio.run(m.send(email))

    assert message_id == "em_123"
    assert seen["url"] == "https://api.resend.com/emails"
    key = seen["headers"].get("Idempotency-key") or seen["headers"].get("Idempotency-Key")
    assert key == mailer.idempotency_key(email)
    assert seen["headers"].get("Authorization") == "Bearer re_test_key"


def test_resend_mailer_retries_transient_failures_once(monkeypatch):
    """
    A 5xx or a dropped connection is not the signer's fault. Retrying once is
    the difference between a contract arriving and a support ticket.
    """
    from sign import mailer

    calls = {"n": 0}

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"id": "em_retry_ok"}'

    def flaky(req, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("connection reset")
        return _Resp()

    monkeypatch.setattr(mailer.urllib.request, "urlopen", flaky)
    monkeypatch.setattr(mailer.time, "sleep", lambda s: None)

    m = mailer.ResendMailer("re_test_key", "Champions <notifications@sign.championsmail.com>")
    import asyncio

    email = mailer.otp_email(to="jane@acme.example", code="111111", title="NDA",
                             minutes=10, document_id="doc1", recipient_id="rec1")
    assert asyncio.run(m.send(email)) == "em_retry_ok"
    assert calls["n"] == 2


def test_resend_mailer_does_not_retry_a_rejected_request(monkeypatch):
    """A 422 will never succeed on retry. Retrying it just wastes the quota."""
    from sign import mailer

    calls = {"n": 0}

    def reject(req, timeout=None):
        calls["n"] += 1
        raise urllib.error.HTTPError(
            "https://api.resend.com/emails", 422, "Unprocessable",
            {}, __import__("io").BytesIO(b'{"message":"invalid from"}')
        )

    monkeypatch.setattr(mailer.urllib.request, "urlopen", reject)
    monkeypatch.setattr(mailer.time, "sleep", lambda s: None)

    m = mailer.ResendMailer("re_test_key", "Champions <notifications@sign.championsmail.com>")
    import asyncio

    email = mailer.otp_email(to="jane@acme.example", code="111111", title="NDA",
                             minutes=10, document_id="doc1", recipient_id="rec1")
    with pytest.raises(mailer.MailError):
        asyncio.run(m.send(email))
    assert calls["n"] == 1


# --------------------------------------------------------------------------
# Webhook signature verification
# --------------------------------------------------------------------------


def test_verify_accepts_a_correct_signature():
    from sign import mailer

    body = b'{"type":"email.delivered"}'
    assert mailer.verify_resend_webhook(svix_headers(body), body, SECRET) is True


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda h: {**h, "svix-id": "msg_other"}, id="wrong-message-id"),
        pytest.param(lambda h: {**h, "svix-signature": "v1,bm90YXNpZw=="}, id="forged-signature"),
        pytest.param(lambda h: {k: v for k, v in h.items() if k != "svix-signature"}, id="no-signature"),
        pytest.param(lambda h: {**h, "svix-id": ""}, id="empty-message-id"),
    ],
)
def test_verify_rejects_tampering(mutate):
    from sign import mailer

    body = b'{"type":"email.delivered"}'
    assert mailer.verify_resend_webhook(mutate(svix_headers(body)), body, SECRET) is False


def test_verify_rejects_a_tampered_body():
    from sign import mailer

    headers = svix_headers(b'{"type":"email.delivered"}')
    assert mailer.verify_resend_webhook(headers, b'{"type":"email.complained"}', SECRET) is False


def test_verify_rejects_a_stale_timestamp():
    """Replay window. A signature from an hour ago must not open a new audit write."""
    from sign import mailer

    body = b'{"type":"email.delivered"}'
    old = svix_headers(body, ts=int(time.time()) - 3600)
    assert mailer.verify_resend_webhook(old, body, SECRET) is False
    # And the tolerance is a parameter, so a caller can widen it deliberately.
    assert mailer.verify_resend_webhook(old, body, SECRET, tolerance_s=7200) is True


def test_verify_rejects_a_future_timestamp():
    from sign import mailer

    body = b'{"type":"email.delivered"}'
    assert mailer.verify_resend_webhook(svix_headers(body, ts=int(time.time()) + 3600), body, SECRET) is False


def test_verify_rejects_when_no_secret_is_configured():
    from sign import mailer

    body = b'{}'
    assert mailer.verify_resend_webhook(svix_headers(body), body, "") is False


def test_verify_is_case_insensitive_on_header_names():
    from sign import mailer

    body = b'{"type":"email.delivered"}'
    upper = {k.upper(): v for k, v in svix_headers(body).items()}
    assert mailer.verify_resend_webhook(upper, body, SECRET) is True


def test_verify_rejects_a_malformed_secret():
    from sign import mailer

    body = b"{}"
    assert mailer.verify_resend_webhook(svix_headers(body), body, "whsec_!!!not-base64!!!") is False


# --------------------------------------------------------------------------
# Endpoint behaviour
# --------------------------------------------------------------------------


@pytest.fixture()
def hook_client(tmp_path, monkeypatch):
    """A router-only app, so the webhook can be exercised without the flow fixture."""
    monkeypatch.setenv("CHAMPDF_DB_PATH", str(tmp_path / "hook.db"))
    monkeypatch.setenv("CHAMPDF_SIGN_DATA_DIR", str(tmp_path / "signdata"))
    monkeypatch.setenv("CHAMPDF_ADMIN_TOKEN", "test-admin-token")
    monkeypatch.setenv("RESEND_WEBHOOK_SECRET", SECRET)

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from sign import store

    store.init_sign_db()
    from sign.router import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _payload(document_id: str, recipient_id: str = "rec1", event: str = "email.delivered") -> bytes:
    return json.dumps(
        {
            "type": event,
            "created_at": "2026-09-10T00:00:00Z",
            "data": {
                "email_id": "em_hook_1",
                "to": ["jane@acme.example"],
                "tags": {"kind": "invitation", "document_id": document_id, "recipient_id": recipient_id},
            },
        }
    ).encode()


def _seed(store, doc_id: str) -> None:
    store.insert_document(
        {
            "id": doc_id, "title": "Hook doc", "sender_user_id": "u1", "template_id": "mutual-nda-v1",
            "template_version": 1, "template_sha256": "0" * 64, "provider": "native",
            "counterparty_entity": "Acme Technologies Private Limited", "merge_fields_json": "{}",
            "status": "sent", "expires_at": store.default_expiry(14), "created_at": store.utcnow_iso(),
        }
    )


def test_webhook_requires_a_signature(hook_client):
    body = _payload("doc-hook-unsigned")
    r = hook_client.post("/api/sign/webhooks/resend", content=body,
                         headers={"content-type": "application/json"})
    assert r.status_code == 401


def test_webhook_refuses_when_no_secret_is_configured(hook_client, monkeypatch):
    monkeypatch.setenv("RESEND_WEBHOOK_SECRET", "")
    body = _payload("doc-hook-nosecret")
    r = hook_client.post("/api/sign/webhooks/resend", content=body,
                         headers={**svix_headers(body), "content-type": "application/json"})
    # Fail closed: never accept an unverifiable event just because verification
    # is not configured.
    assert r.status_code == 503


def test_webhook_records_once_per_resend_message_id(hook_client):
    """
    Resend retries webhooks. Every retry carries the same svix-id. Without
    deduplication each retry appends another audit event, which both inflates
    the chain and makes the delivery history look like repeated failures.
    """
    from sign import store

    _seed(store, "doc-hook-dup")
    body = _payload("doc-hook-dup")
    headers = {**svix_headers(body, msg_id="msg_dup"), "content-type": "application/json"}

    first = hook_client.post("/api/sign/webhooks/resend", content=body, headers=headers)
    assert first.status_code == 200 and first.json()["recorded"] is True

    for _ in range(3):
        again = hook_client.post("/api/sign/webhooks/resend", content=body, headers=headers)
        assert again.status_code == 200
        assert again.json()["recorded"] is False
        assert again.json().get("duplicate") is True

    delivered = [
        e for e in store.list_events("doc-hook-dup") if e["event_type"] == "invitation.delivered"
    ]
    assert len(delivered) == 1


def test_webhook_records_a_different_event_for_the_same_message(hook_client):
    """A delivered then a bounced is two real facts, not a duplicate."""
    from sign import store

    _seed(store, "doc-hook-two")
    d = _payload("doc-hook-two", event="email.delivered")
    b = _payload("doc-hook-two", event="email.bounced")
    r1 = hook_client.post("/api/sign/webhooks/resend", content=d,
                          headers={**svix_headers(d, msg_id="m1"), "content-type": "application/json"})
    r2 = hook_client.post("/api/sign/webhooks/resend", content=b,
                          headers={**svix_headers(b, msg_id="m2"), "content-type": "application/json"})
    assert r1.json()["recorded"] is True and r2.json()["recorded"] is True
    types = [e["event_type"] for e in store.list_events("doc-hook-two")]
    assert "invitation.delivered" in types and "invitation.bounced" in types


def test_webhook_rejects_malformed_json(hook_client):
    body = b"{not json"
    r = hook_client.post("/api/sign/webhooks/resend", content=body,
                         headers={**svix_headers(body), "content-type": "application/json"})
    assert r.status_code == 400


def test_webhook_ignores_unrelated_event_types(hook_client):
    from sign import store

    _seed(store, "doc-hook-unrelated")
    body = _payload("doc-hook-unrelated", event="domain.dns_verified")
    r = hook_client.post("/api/sign/webhooks/resend", content=body,
                         headers={**svix_headers(body), "content-type": "application/json"})
    assert r.status_code == 200 and r.json()["ignored"] == "domain.dns_verified"
    assert store.list_events("doc-hook-unrelated") == []


def test_webhook_rejects_an_unknown_event_type_name(hook_client):
    """
    The router's event map is a closed set. A payload naming an event type that
    is not on the list must not reach the audit log under any circumstances.
    """
    from sign import store

    _seed(store, "doc-hook-inject")
    body = json.dumps(
        {
            "type": "email.delivered",
            "data": {"email_id": "x", "tags": {"kind": "invitation", "document_id": "doc-hook-inject",
                                               "recipient_id": "r", "event_type": "document.voided"}},
        }
    ).encode()
    hook_client.post("/api/sign/webhooks/resend", content=body,
                     headers={**svix_headers(body), "content-type": "application/json"})
    types = [e["event_type"] for e in store.list_events("doc-hook-inject")]
    assert types == ["invitation.delivered"]