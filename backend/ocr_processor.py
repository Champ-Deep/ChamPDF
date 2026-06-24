"""
Server-side OCR via OCRmyPDF (optional, higher quality + PDF/A).

The default OCR path is client-side tesseract.js (private, no upload). When the
server has OCRmyPDF + tesseract + ghostscript installed, this offers a
higher-quality alternative that also deskews/rotates and can emit PDF/A. Runs
the blocking ocrmypdf call in a worker thread. Env-gated and reported via
/api/capabilities so a server without the binaries degrades gracefully.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path


class OcrError(Exception):
    """Raised when server OCR is unavailable or fails."""


def ocr_available() -> bool:
    """True iff ocrmypdf + the tesseract/ghostscript binaries are present."""
    try:
        import ocrmypdf  # noqa: F401
    except ImportError:
        return False
    return shutil.which("tesseract") is not None and shutil.which("gs") is not None


def _run(in_path: str, out_path: str, language: str, pdfa: bool) -> None:
    import ocrmypdf

    ocrmypdf.ocr(
        in_path,
        out_path,
        language=language or "eng",
        output_type="pdfa" if pdfa else "pdf",
        skip_text=True,        # leave pages that already have a text layer
        rotate_pages=True,
        deskew=True,
        optimize=0,            # avoid pngquant/jbig2 system deps
        progress_bar=False,
    )


async def ocr_pdf(pdf_bytes: bytes, language: str = "eng", pdfa: bool = True) -> bytes:
    """OCR a PDF → searchable (optionally PDF/A) PDF bytes.

    language: tesseract code(s), e.g. "eng" or "eng+deu". Raises OcrError on
    failure (including the "already has text" case when skip_text can't help).
    """
    if not ocr_available():
        raise OcrError(
            "Server OCR is not configured (needs ocrmypdf + tesseract + ghostscript)."
        )
    work = tempfile.mkdtemp(prefix="champdf_ocr_")
    in_path = os.path.join(work, "in.pdf")
    out_path = os.path.join(work, "out.pdf")
    try:
        Path(in_path).write_bytes(pdf_bytes)
        try:
            await asyncio.to_thread(_run, in_path, out_path, language, pdfa)
        except Exception as e:  # noqa: BLE001 — surface a clean message
            raise OcrError(f"OCR failed: {e}")
        return Path(out_path).read_bytes()
    finally:
        shutil.rmtree(work, ignore_errors=True)
