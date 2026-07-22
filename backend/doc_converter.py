"""
Document conversion: Office ↔ PDF.

- Office → PDF: LibreOffice headless (`soffice --convert-to pdf`). Available
  when the `soffice` binary is installed (it is in the backend Docker image).
- PDF → DOCX: pdf2docx (PyMuPDF + python-docx). Available when the package
  imports (installed --no-deps in the Dockerfile alongside its two extra
  deps, python-docx and fonttools).

Both are env-gated soft dependencies: when missing, the endpoints report 503
and /api/v1/capabilities advertises them as off. Files are processed in a
per-request temp dir and deleted after the response.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path
from typing import Optional


class ConvertError(Exception):
    """Raised when a conversion is unavailable or fails."""


SOFFICE_TIMEOUT_S = int(os.environ.get("SOFFICE_TIMEOUT_S", "120"))

# Extensions LibreOffice reliably converts to PDF headlessly.
OFFICE_EXTENSIONS = {
    ".doc", ".docx", ".odt", ".rtf", ".txt",
    ".xls", ".xlsx", ".ods", ".csv",
    ".ppt", ".pptx", ".odp",
    ".html", ".htm",
}


def soffice_path() -> Optional[str]:
    return shutil.which("soffice") or shutil.which("libreoffice")


def office_to_pdf_available() -> bool:
    if os.environ.get("ENABLE_OFFICE_CONVERT", "true").strip().lower() == "false":
        return False
    return soffice_path() is not None


def pdf_to_docx_available() -> bool:
    if os.environ.get("ENABLE_PDF_TO_DOCX", "true").strip().lower() == "false":
        return False
    try:
        import pdf2docx  # noqa: F401
        return True
    except ImportError:
        return False


async def office_to_pdf(file_bytes: bytes, filename: str) -> bytes:
    """Convert an Office/text document to PDF via LibreOffice headless."""
    binary = soffice_path()
    if not office_to_pdf_available() or not binary:
        raise ConvertError("Office-to-PDF conversion is not enabled on this server")

    ext = Path(filename or "").suffix.lower()
    if ext not in OFFICE_EXTENSIONS:
        raise ConvertError(
            f"Unsupported input type '{ext or '(none)'}'. "
            f"Supported: {', '.join(sorted(OFFICE_EXTENSIONS))}"
        )

    work = Path(tempfile.mkdtemp(prefix="champdf_convert_"))
    try:
        in_path = work / f"input{ext}"
        in_path.write_bytes(file_bytes)
        # LibreOffice needs a writable HOME for its profile; isolate per request
        # so concurrent conversions don't fight over the profile lock.
        env = dict(os.environ, HOME=str(work))
        proc = await asyncio.create_subprocess_exec(
            binary,
            "--headless", "--norestore", "--invisible",
            f"-env:UserInstallation=file://{work}/lo-profile",
            "--convert-to", "pdf",
            "--outdir", str(work),
            str(in_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        try:
            _, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=SOFFICE_TIMEOUT_S
            )
        except asyncio.TimeoutError:
            proc.kill()
            raise ConvertError(
                f"Conversion timed out after {SOFFICE_TIMEOUT_S}s"
            )
        out_path = work / "input.pdf"
        if proc.returncode != 0 or not out_path.exists():
            detail = (stderr or b"").decode("utf-8", "replace").strip()[:500]
            raise ConvertError(f"LibreOffice conversion failed: {detail or 'no output'}")
        return out_path.read_bytes()
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _pdf_to_docx_sync(pdf_bytes: bytes) -> bytes:
    from pdf2docx import Converter

    work = Path(tempfile.mkdtemp(prefix="champdf_p2d_"))
    try:
        in_path = work / "input.pdf"
        out_path = work / "output.docx"
        in_path.write_bytes(pdf_bytes)
        cv = Converter(str(in_path))
        try:
            cv.convert(str(out_path))
        finally:
            cv.close()
        if not out_path.exists():
            raise ConvertError("PDF-to-DOCX produced no output")
        return out_path.read_bytes()
    except ConvertError:
        raise
    except Exception as e:
        raise ConvertError(f"PDF-to-DOCX conversion failed: {e}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def pdf_to_docx(pdf_bytes: bytes) -> bytes:
    """Convert a (text-based) PDF to an editable Word document."""
    if not pdf_to_docx_available():
        raise ConvertError("PDF-to-DOCX conversion is not enabled on this server")
    return await asyncio.to_thread(_pdf_to_docx_sync, pdf_bytes)
