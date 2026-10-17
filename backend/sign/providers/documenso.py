"""
Documenso adapter.

Talks to an unmodified, self-hosted Documenso over its public v1 API with a
service token. Documenso is AGPL-3.0; nothing of it is copied here, and it
runs from its published image on a private network (docs/sign/README.md and
docker-compose.sign.yml). This module is the only place that knows its URL
shapes, so an API change is a one-file fix.

Flow used (upload-our-PDF, not Documenso templates): our renderer stays the
source of truth for the instrument, and Documenso only captures signatures
and seals.

  POST /api/v1/documents                 -> {documentId, uploadUrl, recipients[{recipientId, email, token, signingUrl}]}
  PUT  <uploadUrl>                       -> the rendered PDF bytes
  POST /api/v1/documents/{id}/fields     -> one SIGNATURE field per recipient, at our anchor (percent coordinates)
  POST /api/v1/documents/{id}/send       -> {sendEmail:false}; returns recipients with signingUrl
  GET  /api/v1/documents/{id}            -> status DRAFT | PENDING | COMPLETED, recipients[].signingStatus
  GET  /api/v1/documents/{id}/download   -> {downloadUrl}
  DELETE /api/v1/documents/{id}          -> void

Documenso hosts the signing UI, so this adapter sets ``hosted_signing``. The
signer still goes through our branded landing and OTP; after verification the
page embeds the recipient's ``signingUrl``. Documenso's own certificate page
and seal are what the sealed output carries; our audit chain is recorded
independently by the service, exactly as with the native engine.

Written against the Documenso v1 API reference; not yet exercised against a
live instance (none is deployed as of this build). The unit tests mock the
HTTP layer.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from .. import templates as tpl
from .base import ProviderDocument, ProviderError, ProviderStatus, RecipientSpec, SigningProvider

logger = logging.getLogger(__name__)

PAGE_W, PAGE_H = 595.0, 842.0  # our renderer's A4 in points


class DocumensoProvider(SigningProvider):
    name = "documenso"
    hosted_signing = True

    def __init__(self, base_url: str, api_token: str, timeout: float = 30.0) -> None:
        if not base_url or not api_token:
            raise ProviderError("DOCUMENSO_BASE_URL and DOCUMENSO_API_TOKEN are required for SIGN_PROVIDER=documenso")
        self.base_url = base_url.rstrip("/")
        self.api_token = api_token
        self.timeout = timeout

    @classmethod
    def from_env(cls) -> "DocumensoProvider":
        return cls(
            base_url=os.environ.get("DOCUMENSO_BASE_URL", "").strip(),
            api_token=os.environ.get("DOCUMENSO_API_TOKEN", "").strip(),
            timeout=float(os.environ.get("DOCUMENSO_TIMEOUT_S", "30")),
        )

    # ---- HTTP -------------------------------------------------------------

    def _request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None,
                 raw: Optional[bytes] = None, content_type: str = "application/json",
                 absolute: bool = False) -> Dict[str, Any]:
        url = path if absolute else f"{self.base_url}{path}"
        data = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
        req = urllib.request.Request(url, data=data, method=method)
        if not absolute:
            req.add_header("Authorization", self.api_token)
        if data is not None:
            req.add_header("Content-Type", content_type)
        req.add_header("Accept", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # nosec - operator-configured host
                payload = resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:500]
            raise ProviderError(f"Documenso {method} {path} -> {e.code}: {detail}") from e
        except urllib.error.URLError as e:
            raise ProviderError(f"Documenso unreachable: {e.reason}") from e
        if not payload:
            return {}
        try:
            return json.loads(payload.decode("utf-8"))
        except ValueError:
            return {"_raw": payload}

    async def _call(self, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        return await asyncio.to_thread(self._request, *args, **kwargs)

    # ---- SigningProvider --------------------------------------------------

    async def create_from_template(
        self,
        template: tpl.Template,
        merge_values: Dict[str, str],
        recipients: List[RecipientSpec],
        *,
        document_id: str,
        title: str,
        footer_label: str,
    ) -> ProviderDocument:
        rec_dicts = [
            {"role": r.role, "name": r.name, "email": r.email, "designation": r.designation or ""}
            for r in recipients
        ]
        rendered = await tpl.render_pdf(template, merge_values, rec_dicts, footer_label=footer_label)

        created = await self._call(
            "POST",
            "/api/v1/documents",
            {
                "title": title,
                "externalId": document_id,
                "recipients": [
                    {
                        "name": r.name,
                        "email": r.email,
                        "role": "CC" if r.role == "cc" else "SIGNER",
                        "signingOrder": r.signing_order,
                    }
                    for r in recipients
                ],
                "meta": {
                    "subject": title,
                    "message": "Please review and sign.",
                    "signingOrder": "SEQUENTIAL",
                    "distributionMethod": "NONE",
                },
            },
        )
        doc_id = str(created.get("documentId") or created.get("id") or "")
        upload_url = created.get("uploadUrl")
        if not doc_id or not upload_url:
            raise ProviderError(f"Documenso create returned no documentId/uploadUrl: {created}")
        await self._call("PUT", upload_url, raw=rendered.pdf, content_type="application/pdf", absolute=True)

        # Map our recipients to Documenso's by email (their ids are theirs).
        theirs = {str(r.get("email", "")).lower(): r for r in created.get("recipients", [])}
        signing_urls: Dict[str, str] = {}
        for r in recipients:
            their = theirs.get(r.email.lower())
            if not their:
                continue
            anchor = rendered.anchors.get(r.role)
            if anchor and r.role != "cc":
                x0, y0, x1, y1 = anchor["rect"]
                await self._call(
                    "POST",
                    f"/api/v1/documents/{doc_id}/fields",
                    {
                        "recipientId": their.get("recipientId") or their.get("id"),
                        "type": "SIGNATURE",
                        "pageNumber": int(anchor["page"]) + 1,
                        "pageX": round(x0 / PAGE_W * 100, 3),
                        "pageY": round(y0 / PAGE_H * 100, 3),
                        "pageWidth": round((x1 - x0) / PAGE_W * 100, 3),
                        "pageHeight": round((y1 - y0) / PAGE_H * 100, 3),
                    },
                )
            if their.get("signingUrl"):
                signing_urls[r.id] = their["signingUrl"]

        sent = await self._call("POST", f"/api/v1/documents/{doc_id}/send", {"sendEmail": False})
        for their in sent.get("recipients", []) or []:
            email = str(their.get("email", "")).lower()
            for r in recipients:
                if r.email.lower() == email and their.get("signingUrl"):
                    signing_urls[r.id] = their["signingUrl"]

        return ProviderDocument(
            provider_doc_id=doc_id,
            draft_pdf=rendered.pdf,
            anchors=rendered.anchors,
            page_count=rendered.page_count,
            source=rendered.source,
            signing_urls=signing_urls,
        )

    async def get_status(self, provider_doc_id: str) -> ProviderStatus:
        data = await self._call("GET", f"/api/v1/documents/{provider_doc_id}")
        raw_status = str(data.get("status", "")).upper()
        status = {"DRAFT": "draft", "PENDING": "sent", "COMPLETED": "executed", "REJECTED": "voided"}.get(raw_status, "unknown")
        recips: Dict[str, str] = {}
        for r in data.get("recipients", []) or []:
            s = str(r.get("signingStatus", "")).upper()
            recips[str(r.get("email", "")).lower()] = "signed" if s == "SIGNED" else ("declined" if s == "REJECTED" else "pending")
        return ProviderStatus(status=status, recipients=recips, sealed_available=status == "executed", raw=data)

    async def get_sealed_document(self, provider_doc_id: str) -> bytes:
        link = await self._call("GET", f"/api/v1/documents/{provider_doc_id}/download")
        url = link.get("downloadUrl")
        if not url:
            raise ProviderError("Documenso returned no downloadUrl (document not completed?)")
        payload = await self._call("GET", url, absolute=True)
        raw = payload.get("_raw")
        if not isinstance(raw, (bytes, bytearray)):
            raise ProviderError("Documenso download did not return PDF bytes")
        return bytes(raw)

    async def void(self, provider_doc_id: str, reason: str) -> None:
        try:
            await self._call("DELETE", f"/api/v1/documents/{provider_doc_id}")
        except ProviderError as e:
            if "404" in str(e):
                return
            raise

    def describe(self) -> Dict[str, Any]:
        return {**super().describe(), "base_url": self.base_url}
