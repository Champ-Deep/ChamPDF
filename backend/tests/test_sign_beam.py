"""
ChampPDF Sign: ChampBeam tracked-link contract and the invitation email.

The invitation button must be a ChampBeam short URL created through the real
endpoint (POST /api/v1/utm/generate, X-API-Key auth) carrying the send-out
context, and the email must render it as one simple CTA with a plain-text
fallback link. Any Beam failure falls back to the raw signing URL so mail is
never blocked by instrumentation.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture
def beam_env(monkeypatch):
    monkeypatch.setenv("CHAMPBEAM_API_URL", "https://share.lakeb2b.com")
    monkeypatch.setenv("CHAMPBEAM_API_KEY", "cb_live_testkey")
    monkeypatch.delenv("CHAMPBEAM_API_TOKEN", raising=False)
    yield
    monkeypatch.delenv("CHAMPBEAM_API_URL", raising=False)
    monkeypatch.delenv("CHAMPBEAM_API_KEY", raising=False)


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *a) -> None:
        return None


def capture_urlopen(monkeypatch, payload: dict):
    """Patch urllib.request.urlopen; return the Request it received."""
    captured = {}

    def fake(req, timeout=None):
        captured["request"] = req
        captured["timeout"] = timeout
        return FakeResponse(payload)

    monkeypatch.setattr(urllib.request, "urlopen", fake)
    return captured


# ---------------------------------------------------------------------------
# Beam wrap
# ---------------------------------------------------------------------------


def test_wrap_sends_utm_generate_with_send_out_context(monkeypatch, beam_env):
    from sign import beam

    captured = capture_urlopen(
        monkeypatch, {"link_id": "11111111-2222-3333-4444-555555555555", "short_code": "abc123",
                      "short_url": "https://share.lakeb2b.com/s/abc123"}
    )
    out = {"id": "11111111-2222-3333-4444-555555555555", "url": "https://share.lakeb2b.com/s/abc123"}
    import asyncio
    result = asyncio.run(beam.wrap_link(
        "https://champdf.com/s/some32charlongsecrettokenhere",
        title="Mutual NDA - Acme Technologies", recipient_email="jane@acme.example", role="signer",
        template_id="mutual-nda-v1", document_id="doc-1234",
    ))
    assert result == out
    req = captured["request"]
    assert req.full_url == "https://share.lakeb2b.com/api/v1/utm/generate"
    assert req.method == "POST"
    # Python normalizes header casing on Request; assert on values so the
    # contract (X-API-Key integration auth) does not depend on that.
    assert any(v == "cb_live_testkey" for v in req.headers.values())
    body = json.loads(req.data.decode("utf-8"))
    assert body["base_url"].startswith("https://champdf.com/s/")
    assert body["utm_source"] == "champdf-sign"
    assert body["utm_medium"] == "email"
    assert body["utm_campaign"] == "Mutual NDA - Acme Technologies"
    assert body["utm_content"] == "signer jane@acme.example"
    assert body["utm_term"] == "mutual-nda-v1"
    assert body["project_name"] == "champdf-sign"
    assert captured["timeout"] == 8


def test_wrap_uses_redirect_url_when_short_url_missing(monkeypatch, beam_env):
    from sign import beam

    captured = capture_urlopen(
        monkeypatch,
        {"link_id": "abc", "redirect_url": "https://share.lakeb2b.com/r/abc123",
         "tracked_url": "https://champdf.com/s/tok?utm_source=champdf-sign"},
    )
    import asyncio
    result = asyncio.run(beam.wrap_link(
        "https://champdf.com/s/tok",
        title="T", recipient_email="x@y.z", role="signer", template_id="t", document_id="d",
    ))
    assert result == {"id": "abc", "url": "https://share.lakeb2b.com/r/abc123"}


def test_wrap_falls_back_to_raw_on_http_error(monkeypatch, beam_env):
    from sign import beam

    def boom(req, timeout=None):
        raise urllib.error.HTTPError("https://share.lakeb2b.com", 409, "conflict", None, None)

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    import asyncio
    result = asyncio.run(beam.wrap_link(
        "https://champdf.com/s/tok",
        title="T", recipient_email="x@y.z", role="signer", template_id="t", document_id="d",
    ))
    assert result == {"id": None, "url": "https://champdf.com/s/tok"}


def test_wrap_falls_back_to_raw_on_garbage_response(monkeypatch, beam_env):
    from sign import beam

    capture_urlopen(monkeypatch, {"tracked_url": None, "short_url": None})
    import asyncio
    result = asyncio.run(beam.wrap_link(
        "https://champdf.com/s/tok",
        title="T", recipient_email="x@y.z", role="signer", template_id="t", document_id="d",
    ))
    assert result == {"id": None, "url": "https://champdf.com/s/tok"}


def test_wrap_raw_when_beam_unconfigured(monkeypatch):
    monkeypatch.delenv("CHAMPBEAM_API_URL", raising=False)
    from sign import beam

    import asyncio
    result = asyncio.run(beam.wrap_link(
        "https://champdf.com/s/tok",
        title="T", recipient_email="x@y.z", role="signer", template_id="t", document_id="d",
    ))
    assert result == {"id": None, "url": "https://champdf.com/s/tok"}


# ---------------------------------------------------------------------------
# Invitation email: one CTA button on the standard template
# ---------------------------------------------------------------------------


def test_invitation_button_and_fallback_link():
    from sign import mailer

    link = "https://share.lakeb2b.com/s/abc123"
    email = mailer.invitation_email(
        to="jane@acme.example", recipient_name="Jane", sender_name="Deep",
        sender_email="deep@championsmail.com", entity="Champions Superior Capital",
        title="Mutual NDA", link=link, expires_at_text="28 September 2026",
        document_id="d1", recipient_id="r1",
    )
    assert "Review and sign" in email.html
    assert f'href="{link}"' in email.html
    # the CTA is the branded button; the fallback link is the plain one
    assert email.html.count(f'href="{link}"') == 2
    assert "If the button does not open" in email.html
    assert link in email.text
    assert email.tags["kind"] == "invitation"
    assert email.reply_to == "deep@championsmail.com"