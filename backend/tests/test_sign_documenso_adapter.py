"""
Documenso adapter, with the HTTP layer mocked.

Checks the call sequence the adapter makes against Documenso's v1 API and
that our renderer's signature anchors are translated into Documenso's
percent-based field coordinates. No live instance is involved.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture
def provider(monkeypatch):
    from sign.providers.documenso import DocumensoProvider

    calls = []

    def fake_request(self, method, path, body=None, raw=None, content_type="application/json", absolute=False):
        calls.append((method, path, body, raw is not None, absolute))
        if method == "POST" and path == "/api/v1/documents":
            return {
                "documentId": 42,
                "uploadUrl": "https://s3.example/upload?sig=1",
                "recipients": [
                    {"recipientId": 7, "email": "jane@acme.example", "signingUrl": "https://documenso.internal/sign/tok7"},
                ],
            }
        if method == "PUT" and absolute:
            return {}
        if method == "POST" and path.endswith("/fields"):
            return {"id": 99}
        if method == "POST" and path.endswith("/send"):
            return {"recipients": [{"email": "jane@acme.example", "signingUrl": "https://documenso.internal/sign/tok7"}]}
        if method == "GET" and path == "/api/v1/documents/42":
            return {"status": "COMPLETED", "recipients": [{"email": "jane@acme.example", "signingStatus": "SIGNED"}]}
        if method == "GET" and path == "/api/v1/documents/42/download":
            return {"downloadUrl": "https://s3.example/sealed.pdf"}
        if method == "GET" and absolute:
            return {"_raw": b"%PDF-1.7 sealed"}
        if method == "DELETE":
            raise_404 = getattr(fake_request, "raise_404", False)
            if raise_404:
                from sign.providers.base import ProviderError

                raise ProviderError("Documenso DELETE -> 404: gone")
            return {}
        raise AssertionError(f"unexpected call {method} {path}")

    monkeypatch.setattr(DocumensoProvider, "_request", fake_request)
    p = DocumensoProvider(base_url="http://documenso:3000", api_token="api_test")
    return p, calls, fake_request


def test_create_uploads_our_pdf_and_places_fields(provider):
    from sign import templates as tpl
    from sign.providers import RecipientSpec

    p, calls, _ = provider
    template = tpl.get_template("mutual-nda-v1")
    values = tpl.validate_merge_fields(template, {
        "counterparty_entity": "Acme", "counterparty_address": "1 MG Road", "purpose": "Testing"})
    recipients = [RecipientSpec(id="r1", role="signer", signing_order=1, name="Jane", email="jane@acme.example", designation="Director")]

    result = asyncio.run(p.create_from_template(template, values, recipients, document_id="doc-1", title="Mutual NDA", footer_label="Document doc-1"))

    assert result.provider_doc_id == "42"
    assert result.draft_pdf.startswith(b"%PDF")
    assert result.signing_urls == {"r1": "https://documenso.internal/sign/tok7"}
    assert p.hosted_signing is True

    methods = [(c[0], c[1] if not c[4] else "<absolute>") for c in calls]
    assert methods[0] == ("POST", "/api/v1/documents")
    assert methods[1] == ("PUT", "<absolute>") and calls[1][3] is True  # raw PDF bytes
    assert methods[2] == ("POST", "/api/v1/documents/42/fields")
    assert methods[3] == ("POST", "/api/v1/documents/42/send")

    create_body = calls[0][2]
    assert create_body["externalId"] == "doc-1"
    assert create_body["recipients"][0] == {"name": "Jane", "email": "jane@acme.example", "role": "SIGNER", "signingOrder": 1}
    assert create_body["meta"]["distributionMethod"] == "NONE"

    field = calls[2][2]
    assert field["recipientId"] == 7 and field["type"] == "SIGNATURE"
    assert field["pageNumber"] == result.anchors["signer"]["page"] + 1
    for k in ("pageX", "pageY", "pageWidth", "pageHeight"):
        assert 0 < field[k] < 100


def test_status_download_and_void(provider):
    p, calls, fake = provider
    status = asyncio.run(p.get_status("42"))
    assert status.status == "executed" and status.sealed_available
    assert status.recipients == {"jane@acme.example": "signed"}

    assert asyncio.run(p.get_sealed_document("42")) == b"%PDF-1.7 sealed"

    asyncio.run(p.void("42", "test"))
    fake.raise_404 = True
    asyncio.run(p.void("42", "already gone"))  # idempotent


def test_requires_config(monkeypatch):
    from sign.providers.base import ProviderError
    from sign.providers.documenso import DocumensoProvider

    monkeypatch.delenv("DOCUMENSO_BASE_URL", raising=False)
    monkeypatch.delenv("DOCUMENSO_API_TOKEN", raising=False)
    with pytest.raises(ProviderError):
        DocumensoProvider.from_env()
