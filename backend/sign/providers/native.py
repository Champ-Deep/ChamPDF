"""
Native signing provider: PyMuPDF for rendering and stamping, pyHanko for the
seal. Everything happens in this process; the only state it keeps is what
the service stores.

This is also the DPRD's "exit path" engine. If Sign is ever productised,
this adapter is what stays and the Documenso one is what goes.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .. import templates as tpl
from ..seal import CertificateContext, append_certificate_sync, seal_info, seal_pdf_sync
from .base import (
    ProviderDocument,
    ProviderError,
    ProviderStatus,
    RecipientSpec,
    SealOutcome,
    SignatureInput,
    SigningProvider,
)

logger = logging.getLogger(__name__)

SCRIPT_FONT = Path(__file__).resolve().parents[2] / "assets" / "fonts" / "GreatVibes-Regular.ttf"
MAX_SIGNATURE_PNG_BYTES = 300 * 1024
MAX_SIGNATURE_PX = (2400, 1200)
INK = (0.08, 0.12, 0.38)


def _fmt_date(iso_ts: str) -> str:
    try:
        v = iso_ts[:-1] + "+00:00" if iso_ts.endswith("Z") else iso_ts
        return datetime.fromisoformat(v).astimezone(timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    except ValueError:
        return iso_ts


def _prepare_drawn(image_png: bytes) -> bytes:
    """Validate a drawn signature PNG, trim empty margins, normalise to RGBA PNG."""
    from PIL import Image

    if len(image_png) > MAX_SIGNATURE_PNG_BYTES:
        raise ProviderError("signature image is too large (max 300 KB)")
    try:
        img = Image.open(io.BytesIO(image_png))
        img.load()
    except Exception as e:  # noqa: BLE001
        raise ProviderError("signature image is not a valid PNG") from e
    if img.format != "PNG":
        raise ProviderError("signature image must be a PNG")
    if img.width > MAX_SIGNATURE_PX[0] or img.height > MAX_SIGNATURE_PX[1]:
        raise ProviderError("signature image dimensions are too large")
    img = img.convert("RGBA")
    bbox = img.getchannel("A").getbbox()
    if not bbox:
        raise ProviderError("signature image is empty")
    img = img.crop(bbox)
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()


def _stamp_sync(pdf: bytes, anchor: Dict[str, Any], sig: SignatureInput) -> bytes:
    import pymupdf

    doc = pymupdf.open("pdf", pdf)
    page = doc[int(anchor["page"])]
    x0, y0, x1, y1 = anchor["rect"]
    box = pymupdf.Rect(x0, y0, x1, y1)
    inner = pymupdf.Rect(box.x0 + 8, box.y0 + 14, box.x1 - 8, box.y1 - 18)

    if sig.kind == "drawn":
        if not sig.image_png:
            raise ProviderError("drawn signature requires an image")
        png = _prepare_drawn(sig.image_png)
        page.insert_image(inner, stream=png, keep_proportion=True)
    elif sig.kind == "typed":
        text = sig.name.strip()
        if not text:
            raise ProviderError("typed signature requires a name")
        font = pymupdf.Font(fontfile=str(SCRIPT_FONT)) if SCRIPT_FONT.exists() else pymupdf.Font("helv")
        size = 30.0
        while size > 10 and font.text_length(text, fontsize=size) > inner.width - 4:
            size -= 1.5
        baseline = inner.y0 + (inner.height + size * 0.6) / 2
        if SCRIPT_FONT.exists():
            page.insert_text((inner.x0 + 2, baseline), text, fontname="ChampSignScript", fontfile=str(SCRIPT_FONT),
                             fontsize=size, color=INK)
        else:
            page.insert_text((inner.x0 + 2, baseline), text, fontname="helv", fontsize=size, color=INK)
    else:
        raise ProviderError(f"unknown signature kind: {sig.kind}")

    # Attestation line inside the box, and the ink-coloured border that marks it as signed.
    page.draw_rect(box, color=INK, width=0.9)
    page.insert_text((box.x0 + 6, box.y1 - 6), f"Signed electronically via ChampPDF Sign  |  {_fmt_date(sig.signed_at)}",
                     fontname="helv", fontsize=6.5, color=(0.35, 0.37, 0.45))

    # Name / designation / date lines under the box.
    if not anchor.get("prefilled_name"):
        nx, ny = anchor["name_pos"]
        page.insert_text((nx, ny), sig.name[:60], fontname="helv", fontsize=9.5, color=(0.08, 0.1, 0.15))
    if sig.designation and not anchor.get("prefilled_designation"):
        dx, dy = anchor["designation_pos"]
        page.insert_text((dx, dy), sig.designation[:60], fontname="helv", fontsize=9.5, color=(0.08, 0.1, 0.15))
    tx, ty = anchor["date_pos"]
    page.insert_text((tx, ty), _fmt_date(sig.signed_at), fontname="helv", fontsize=9.5, color=(0.08, 0.1, 0.15))

    out = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return out


class NativeProvider(SigningProvider):
    name = "native"
    hosted_signing = False

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
        try:
            result = await tpl.render_pdf(template, merge_values, rec_dicts, footer_label=footer_label)
        except tpl.TemplateError:
            raise
        except Exception as e:  # noqa: BLE001
            raise ProviderError(f"rendering failed: {e}") from e
        return ProviderDocument(
            provider_doc_id=document_id,
            draft_pdf=result.pdf,
            anchors=result.anchors,
            page_count=result.page_count,
            source=result.source,
        )

    async def apply_signature(self, pdf: bytes, anchors: Dict[str, Dict[str, Any]], signature: SignatureInput) -> bytes:
        anchor = anchors.get(signature.role)
        if not anchor:
            raise ProviderError(f"no signature anchor for role {signature.role}")
        return await asyncio.to_thread(_stamp_sync, pdf, anchor, signature)

    async def seal(self, pdf: bytes, certificate: CertificateContext, *, reason: str, location: Optional[str]) -> SealOutcome:
        with_cert = await asyncio.to_thread(append_certificate_sync, pdf, certificate)
        tsa = os.environ.get("PDF_TSA_URL", "http://timestamp.digicert.com").strip() or None
        if os.environ.get("SIGN_SEAL_TIMESTAMP", "true").strip().lower() == "false":
            tsa = None
        sealed, meta = await asyncio.to_thread(seal_pdf_sync, with_cert, reason=reason, location=location, tsa_url=tsa)
        return SealOutcome(
            pdf=sealed,
            sha256=hashlib.sha256(sealed).hexdigest(),
            sealed=True,
            timestamped=bool(meta.get("timestamped")),
            seal_subject=meta.get("seal_subject"),
            self_signed=bool(meta.get("self_signed", True)),
            notes=list(meta.get("notes") or []),
        )

    async def get_status(self, provider_doc_id: str) -> ProviderStatus:
        # The service is the system of record; the native engine has no separate view.
        return ProviderStatus(status="unknown", recipients={}, sealed_available=False, raw=None)

    async def void(self, provider_doc_id: str, reason: str) -> None:
        return None

    def describe(self) -> Dict[str, Any]:
        info = seal_info() or {}
        return {
            **super().describe(),
            "seal_subject": info.get("subject"),
            "seal_self_signed": info.get("self_signed", True),
        }
