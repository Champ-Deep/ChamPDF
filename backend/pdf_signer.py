"""
PDF digital signing + verification via pyHanko.

Upgrades signing from the client-side zgapdfsigner path to compliance-grade
PAdES with an optional trusted timestamp (B-T) from a TSA, plus a verification
report (integrity / signer / signing time / timestamp). Env-gated and surfaced
via /api/capabilities. The PDF and certificate are processed in memory and not
retained.

Signing flow needs the user's certificate (.p12/.pfx + password). Verification
needs only the PDF. Heavy/blocking pyHanko work runs in a worker thread.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from io import BytesIO
from pathlib import Path
from typing import Optional


class SignError(Exception):
    """Raised when signing/verification is unavailable or fails."""


def sign_available() -> bool:
    if os.environ.get("ENABLE_PDF_SIGN", "true").strip().lower() == "false":
        return False
    try:
        import pyhanko  # noqa: F401
        return True
    except ImportError:
        return False


def default_tsa_url() -> Optional[str]:
    return os.environ.get("PDF_TSA_URL", "http://timestamp.digicert.com") or None


def _sign_sync(
    pdf_bytes: bytes,
    p12_path: str,
    passphrase: str,
    field_name: str,
    reason: Optional[str],
    location: Optional[str],
    tsa_url: Optional[str],
    visible: bool = False,
    page: int = 1,
    box: Optional[tuple] = None,
) -> bytes:
    from pyhanko.sign import signers, fields, timestamps
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter

    signer = signers.SimpleSigner.load_pkcs12(
        pfx_file=p12_path,
        passphrase=passphrase.encode("utf-8") if passphrase else None,
    )
    if signer is None:
        raise SignError(
            "Could not load the certificate (.p12/.pfx). Check the file and password."
        )

    timestamper = timestamps.HTTPTimeStamper(tsa_url) if tsa_url else None
    meta = signers.PdfSignatureMetadata(
        field_name=field_name or "Signature1",
        reason=reason or None,
        location=location or None,
        subfilter=fields.SigSeedSubFilter.PADES,
    )

    w = IncrementalPdfFileWriter(BytesIO(pdf_bytes))

    stamp_style = None
    if visible:
        # DocuSign-style visible signature box: create the field at an explicit
        # rect, and render signer identity + time into it. The crypto signature
        # is identical to the invisible path; only the appearance differs.
        from pyhanko import stamp as _stamp

        try:
            page_count = int(w.root["/Pages"]["/Count"])
        except Exception:  # noqa: BLE001 — malformed page tree: let 1-page logic try
            page_count = 1
        # 1-based from the API; negative counts from the end (-1 = last page).
        idx = page_count + page if page < 0 else page - 1
        if not 0 <= idx < page_count:
            raise SignError(
                f"page {page} is out of range (document has {page_count} pages)"
            )
        x, y, bw, bh = box or (380.0, 40.0, 180.0, 70.0)
        fields.append_signature_field(
            w,
            sig_field_spec=fields.SigFieldSpec(
                sig_field_name=meta.field_name,
                on_page=idx,
                box=(x, y, x + bw, y + bh),
            ),
        )
        # stamp_text is %-interpolated by pyHanko (%(signer)s, %(ts)s) — escape
        # any literal % in user-supplied reason text.
        lines = ["Digitally signed by %(signer)s", "%(ts)s"]
        if reason:
            lines.append(reason.replace("%", "%%")[:80])
        stamp_style = _stamp.TextStampStyle(
            stamp_text="\n".join(lines),
            border_width=1,
        )

    pdf_signer = signers.PdfSigner(
        meta, signer=signer, timestamper=timestamper, stamp_style=stamp_style
    )
    out = BytesIO()
    pdf_signer.sign_pdf(w, output=out, existing_fields_only=visible)
    return out.getvalue()


def _verify_sync(pdf_bytes: bytes) -> dict:
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    reader = PdfFileReader(BytesIO(pdf_bytes))
    # No external fetching / no trust roots: we report cryptographic integrity
    # and signer identity, not chain trust (which needs a configured trust store).
    vc = ValidationContext(allow_fetching=False)

    out = []
    sigs = list(getattr(reader, "embedded_signatures", []) or [])
    for sig in sigs:
        entry: dict = {"field": getattr(sig, "field_name", "?")}
        try:
            status = validate_pdf_signature(sig, signer_validation_context=vc)
            entry["intact"] = bool(getattr(status, "intact", False))
            entry["valid"] = bool(getattr(status, "valid", False))
            entry["coverage"] = str(getattr(status, "coverage", ""))
            cert = getattr(status, "signing_cert", None)
            if cert is not None:
                try:
                    entry["signer"] = cert.subject.human_friendly
                except Exception:
                    entry["signer"] = str(getattr(cert, "subject", ""))
            ts = getattr(sig, "self_reported_timestamp", None)
            if ts is not None:
                entry["signing_time"] = str(ts)
            entry["timestamped"] = bool(getattr(status, "timestamp_validity", None))
        except Exception as e:  # noqa: BLE001 — never let one bad sig 500 the report
            entry["error"] = str(e)
        out.append(entry)

    return {"signature_count": len(out), "signatures": out}


async def sign_pdf(
    pdf_bytes: bytes,
    p12_bytes: bytes,
    passphrase: str = "",
    field_name: str = "Signature1",
    reason: Optional[str] = None,
    location: Optional[str] = None,
    tsa_url: Optional[str] = None,
    visible: bool = False,
    page: int = 1,
    box: Optional[tuple] = None,
) -> bytes:
    """Sign a PDF (PAdES, optional TSA timestamp) → signed PDF bytes.

    visible=True renders a DocuSign-style signature box (signer name + time +
    reason) at `box` = (x, y, width, height) in PDF points (origin bottom-left)
    on `page` (1-based; -1 = last page). Crypto is identical either way.
    """
    if not sign_available():
        raise SignError("PDF signing is not enabled on this server.")
    work = tempfile.mkdtemp(prefix="champdf_sign_")
    p12_path = os.path.join(work, "cert.p12")
    try:
        Path(p12_path).write_bytes(p12_bytes)
        try:
            return await asyncio.to_thread(
                _sign_sync,
                pdf_bytes,
                p12_path,
                passphrase,
                field_name,
                reason,
                location,
                tsa_url,
                visible,
                page,
                box,
            )
        except SignError:
            raise
        except Exception as e:  # noqa: BLE001
            raise SignError(f"Signing failed: {e}")
    finally:
        import shutil

        shutil.rmtree(work, ignore_errors=True)


async def verify_pdf(pdf_bytes: bytes) -> dict:
    """Verify signatures in a PDF → integrity/signer report."""
    if not sign_available():
        raise SignError("Signature verification is not enabled on this server.")
    try:
        return await asyncio.to_thread(_verify_sync, pdf_bytes)
    except Exception as e:  # noqa: BLE001
        raise SignError(f"Verification failed: {e}")
