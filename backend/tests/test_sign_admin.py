"""
ChampPDF Sign admin portal: visibility, template access control, and geo.

The admin portal is read-only over the system of record plus two switches:
- template activate / deactivate: controls whether a template may be used for
  a send-out. Legal and admin bypass the switch so they can manage and test;
  members are capped to the active set.
- IP geo enrichment (MaxMind): resolved at read time and never blocks a
  request when no database, or only a private IP, is present.

Runs against the same minimal app as test_sign_flow.py (log mailer, native
provider, local storage, self-signed seal). No network.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

ADMIN_TOKEN = "test-admin-token"
BASE = "https://champdf.test"
_ip_counter = [200]


def ip() -> dict:
    _ip_counter[0] += 1
    return {"X-Forwarded-For": f"198.51.100.{_ip_counter[0] % 200}"}


ADMIN = {"X-Admin-Token": ADMIN_TOKEN}


@pytest.fixture(scope="session")
def client(tmp_path_factory):
    d = tmp_path_factory.mktemp("sign-admin")
    os.environ["CHAMPDF_DB_PATH"] = str(d / "champdf.db")
    os.environ["CHAMPDF_SIGN_DATA_DIR"] = str(d / "signdata")
    os.environ["CHAMPDF_ADMIN_TOKEN"] = ADMIN_TOKEN
    os.environ["SIGN_ADMIN_EMAIL"] = "admin@championsmail.com"
    os.environ["SIGN_ADMIN_NAME"] = "Admin"
    os.environ["SIGN_SEAL_TIMESTAMP"] = "false"
    os.environ["SIGN_PUBLIC_BASE_URL"] = BASE
    os.environ["SIGN_PROVIDER"] = "native"
    for k in ("RESEND_API_KEY", "SIGN_STORAGE_BUCKET", "CHAMPBEAM_API_URL", "CLERK_ISSUER", "MAXMIND_DB_PATH"):
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


# ---------------------------------------------------------------------------
# Admin visibility
# ---------------------------------------------------------------------------


def test_admin_summary_reports_counts(client):
    create_doc(client)
    create_doc(client)
    r = client.get("/api/sign/admin/summary", headers=ADMIN)
    assert r.status_code == 200
    s = r.json()
    assert s["role"] == "admin"
    assert s["documents"]["total"] >= 2
    assert s["documents"]["by_status"]["sent"] >= 2
    assert s["recipients"]["pending"] >= 2
    assert s["templates"]["total"] >= 1
    assert s["geo"]["provider"] in ("maxmind", "none")
    assert "now" in s


def test_admin_documents_lists_with_recipients_and_geo(client):
    d = create_doc(client)
    r = client.get("/api/sign/admin/documents", headers=ADMIN)
    assert r.status_code == 200
    docs = r.json()["documents"]
    mine = next(x for x in docs if x["id"] == d["id"])
    assert mine["needs_resend"] is True
    assert mine["days_to_expiry"] is not None
    rec = mine["recipients"][0]
    assert rec["role"] == "signer"
    assert "geo" in rec


def test_admin_events_and_detail(client):
    d = create_doc(client)
    r = client.get(f"/api/sign/admin/documents/{d['id']}", headers=ADMIN)
    assert r.status_code == 200
    body = r.json()
    assert body["chain"]["ok"] is True
    assert any(e["event_type"] == "document.created" for e in body["events"])
    # every event carries an IP and a geo record
    for e in body["events"]:
        assert "geo" in e

    r = client.get("/api/sign/admin/events?limit=50", headers=ADMIN)
    assert r.status_code == 200
    assert isinstance(r.json()["events"], list)


def test_admin_requires_admin_token(client):
    # no auth at all -> the sender dependency rejects it
    r = client.get("/api/sign/admin/summary")
    assert r.status_code in (401, 503)


# ---------------------------------------------------------------------------
# Template access control
# ---------------------------------------------------------------------------


def test_template_activate_deactivate_round_trip(client):
    r = client.post("/api/sign/admin/templates/mutual-nda-v1/deactivate", headers=ADMIN)
    assert r.status_code == 200
    assert r.json()["is_active"] is False
    assert r.json()["approved_by"] == "admin@championsmail.com"

    # admin listing shows the flag
    r = client.get("/api/sign/admin/templates", headers=ADMIN)
    assert r.status_code == 200
    t = next(x for x in r.json()["templates"] if x["id"] == "mutual-nda-v1")
    assert t["is_active"] is False

    # reactivate
    r = client.post("/api/sign/admin/templates/mutual-nda-v1/activate", headers=ADMIN)
    assert r.status_code == 200
    assert r.json()["is_active"] is True


def test_member_blocked_from_inactive_template():
    """Service-level check: a member cannot send an inactive template, and an
    admin can (bypass for management/testing)."""
    from sign import service, store
    from sign.auth import Sender

    service._require_enabled()
    template = service._template("mutual-nda-v1")
    store.set_template_available(template.id, template.version, False, by=None)
    try:
        member = Sender(user_id="u1", email="u1@championsmail.com", name="U", org_id=None, role="member")
        with pytest.raises(Exception) as ei:
            service._ensure_sendable(member, template)
        assert getattr(ei.value, "status_code", None) == 403
        assert getattr(ei.value, "detail", {}).get("code") == "template_inactive"

        admin = Sender(user_id="admin", email="a@championsmail.com", name="A", org_id=None, role="admin")
        service._ensure_sendable(admin, template)  # must not raise
    finally:
        store.set_template_available(template.id, template.version, True, by=None)


def test_public_templates_list_respects_flags(client):
    from sign import store

    store.set_template_available("mutual-nda-v1", 1, False, by="admin")
    try:
        # admin sees all templates with flags
        r = client.get("/api/sign/templates", headers=ADMIN)
        assert r.status_code == 200
        body = r.json()
        assert "flags" in body
        assert body["flags"]["mutual-nda-v1"]["is_active"] == 0
    finally:
        store.set_template_available("mutual-nda-v1", 1, True, by="admin")


# ---------------------------------------------------------------------------
# Needs resend tracking
# ---------------------------------------------------------------------------


def test_needs_resend_lists_pending_and_resend(client, outbox):
    d = create_doc(client)
    r = client.get("/api/sign/admin/needs-resend", headers=ADMIN)
    assert r.status_code == 200
    items = r.json()["items"]
    mine = next(x for x in items if x["id"] == d["id"])
    assert mine["status"] == "sent"
    assert mine["days_since_sent"] == 0
    assert mine["overdue"] is False
    assert any(p["status"] == "pending" for p in mine["pending"])

    # admin resend rotates the token and re-emails
    r = client.post(f"/api/sign/documents/{d['id']}/resend", json={}, headers={**ADMIN, **ip()})
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# GeoIP
# ---------------------------------------------------------------------------


def test_geoip_without_database_is_graceful():
    from sign import geoip

    geoip.reset_for_tests()
    assert geoip.provider() == "none"
    assert geoip.resolve(None)["provider"] == "none"
    got = geoip.resolve("93.184.216.34")
    assert got["provider"] == "none"
    assert got["is_private"] is False
    assert geoip.resolve("10.1.2.3")["is_private"] is True
    assert geoip.resolve("127.0.0.1")["is_private"] is True
    assert geoip.resolve("fe80::1")["is_private"] is True


def test_geoip_missing_maxminddb_package():
    """With MAXMIND_DB_PATH set but the package absent, resolution falls back
    to none rather than raising."""
    import importlib
    import os
    from unittest import mock

    from sign import geoip

    geoip.reset_for_tests()
    with mock.patch.dict(os.environ, {"MAXMIND_DB_PATH": "/nonexistent/city.mmdb"}):
        with mock.patch.object(importlib, "import_module") as im:
            import builtins

            real_import = builtins.__import__

            def fake_import(name, *a, **k):
                if name == "maxminddb":
                    raise ImportError("not installed")
                return real_import(name, *a, **k)

            builtins.__import__ = fake_import
            try:
                geoip.reset_for_tests()
                assert geoip.resolve("8.8.8.8")["provider"] == "none"
            finally:
                builtins.__import__ = real_import
    geoip.reset_for_tests()


def test_geoip_maxmind_record_mapping(monkeypatch):
    """A MaxMind City record maps to the compact geo record the portal renders."""
    from sign import geoip

    class Stub:
        def get(self, ip):  # pragma: no cover - trivial
            return {
                "country": {"iso_code": "IN", "names": {"en": "India"}},
                "city": {"names": {"en": "Bengaluru"}},
                "subdivisions": [{"names": {"en": "Karnataka"}}],
                "location": {"latitude": 12.97, "longitude": 77.59, "time_zone": "Asia/Kolkata"},
                "autonomous_system_number": 131268,
                "autonomous_system_organization": "Champions Network",
            }

    geoip.reset_for_tests()
    monkeypatch.setattr(geoip, "_open_reader", lambda: Stub())
    got = geoip.resolve("1.1.1.1")
    assert got["provider"] == "maxmind"
    assert got["is_private"] is False
    assert got["country_code"] == "IN"
    assert got["country"] == "India"
    assert got["region"] == "Karnataka"
    assert got["city"] == "Bengaluru"
    assert got["latitude"] == 12.97
    assert got["asn"] == 131268
    assert got["isp"] == "Champions Network"

    # a lookup that returns nothing yields provider maxmind, is_private false, ip only
    monkeypatch.setattr(geoip, "_open_reader", lambda: type("R", (), {"get": lambda self, ip: None})())
    empty = geoip.resolve("1.1.1.1")
    assert empty["provider"] == "maxmind"
    assert "country" not in empty
    geoip.reset_for_tests()
