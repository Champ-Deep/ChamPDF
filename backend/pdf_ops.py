"""
Core PDF document operations (PyMuPDF).

Server-side equivalents of the browser tools, exposed through the keyed
/api/v1 surface so external clients (Salesforce, scripts, AI agents) can
merge, split, compress, rotate, watermark, rasterize, and extract text
without a browser. Everything runs in-memory / temp files and nothing is
retained after the response is streamed.

Heavy work runs in a worker thread via asyncio.to_thread so the event loop
stays responsive.
"""

from __future__ import annotations

import asyncio
import io
import zipfile
from typing import Dict, List, Optional, Sequence, Tuple


class PdfOpsError(Exception):
    """Raised for invalid input (bad PDF, bad page spec, ...)."""


# --------------------------------------------------------------------------
# Page-spec parsing
# --------------------------------------------------------------------------


def parse_page_spec(spec: str, page_count: int) -> List[int]:
    """
    Parse a 1-based page spec like "1-3,7,9-" into 0-based indices.

    Supported: "all" / "" (every page), "N", "N-M", "N-" (to end), "-M"
    (from start). Order is preserved and duplicates are allowed.
    """
    spec = (spec or "").strip().lower()
    if spec in ("", "all"):
        return list(range(page_count))

    indices: List[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start_s, _, end_s = part.partition("-")
            try:
                start = int(start_s) if start_s.strip() else 1
                end = int(end_s) if end_s.strip() else page_count
            except ValueError:
                raise PdfOpsError(f"Invalid page range: '{part}'")
        else:
            try:
                start = end = int(part)
            except ValueError:
                raise PdfOpsError(f"Invalid page number: '{part}'")
        if start < 1 or end < start:
            raise PdfOpsError(f"Invalid page range: '{part}'")
        if start > page_count:
            raise PdfOpsError(
                f"Page {start} is out of range (document has {page_count} pages)"
            )
        end = min(end, page_count)
        indices.extend(range(start - 1, end))
    if not indices:
        raise PdfOpsError("Page spec selected no pages")
    return indices


def _open_pdf(pdf_bytes: bytes):
    import fitz  # PyMuPDF

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise PdfOpsError(f"Could not open PDF: {e}")
    # MuPDF sniffs content, so a PNG/JPEG upload still "opens" — reject it.
    if not doc.is_pdf:
        doc.close()
        raise PdfOpsError("File is not a PDF")
    if doc.page_count == 0:
        doc.close()
        raise PdfOpsError("PDF has no pages")
    if doc.needs_pass:
        doc.close()
        raise PdfOpsError("PDF is password-protected")
    return doc


def _save(doc, **kwargs) -> bytes:
    defaults = dict(garbage=3, deflate=True)
    defaults.update(kwargs)
    return doc.tobytes(**defaults)


# --------------------------------------------------------------------------
# Operations (sync cores + async wrappers)
# --------------------------------------------------------------------------


def _merge_sync(pdfs: Sequence[bytes]) -> bytes:
    import fitz

    out = fitz.open()
    try:
        for i, data in enumerate(pdfs):
            src = _open_pdf(data)
            try:
                out.insert_pdf(src)
            finally:
                src.close()
        return _save(out)
    finally:
        out.close()


async def merge_pdfs(pdfs: Sequence[bytes]) -> bytes:
    if len(pdfs) < 2:
        raise PdfOpsError("Provide at least two PDFs to merge")
    return await asyncio.to_thread(_merge_sync, pdfs)


def _extract_pages_sync(pdf_bytes: bytes, spec: str) -> bytes:
    doc = _open_pdf(pdf_bytes)
    try:
        doc.select(parse_page_spec(spec, doc.page_count))
        return _save(doc)
    finally:
        doc.close()


async def extract_pages(pdf_bytes: bytes, spec: str) -> bytes:
    """Split: keep only the pages in `spec` (also handles reordering)."""
    return await asyncio.to_thread(_extract_pages_sync, pdf_bytes, spec)


def _delete_pages_sync(pdf_bytes: bytes, spec: str) -> bytes:
    doc = _open_pdf(pdf_bytes)
    try:
        drop = set(parse_page_spec(spec, doc.page_count))
        keep = [i for i in range(doc.page_count) if i not in drop]
        if not keep:
            raise PdfOpsError("Cannot delete every page of the document")
        doc.select(keep)
        return _save(doc)
    finally:
        doc.close()


async def delete_pages(pdf_bytes: bytes, spec: str) -> bytes:
    return await asyncio.to_thread(_delete_pages_sync, pdf_bytes, spec)


def _rotate_sync(pdf_bytes: bytes, angle: int, spec: str) -> bytes:
    doc = _open_pdf(pdf_bytes)
    try:
        for i in set(parse_page_spec(spec, doc.page_count)):
            page = doc[i]
            page.set_rotation((page.rotation + angle) % 360)
        return _save(doc)
    finally:
        doc.close()


async def rotate_pages(pdf_bytes: bytes, angle: int, spec: str = "all") -> bytes:
    if angle % 90 != 0:
        raise PdfOpsError("angle must be a multiple of 90")
    return await asyncio.to_thread(_rotate_sync, pdf_bytes, angle % 360, spec)


def _compress_sync(pdf_bytes: bytes, image_dpi: int, image_quality: int) -> bytes:
    doc = _open_pdf(pdf_bytes)
    try:
        # rewrite_images (PyMuPDF >= 1.24.10) downsamples embedded images —
        # the bulk of most PDFs' weight. Older versions still get the
        # structural clean-up below.
        if hasattr(doc, "rewrite_images"):
            try:
                doc.rewrite_images(
                    dpi_threshold=image_dpi + 1,
                    dpi_target=image_dpi,
                    quality=image_quality,
                )
            except Exception:
                pass  # fall back to structural compression only
        out = doc.tobytes(garbage=4, deflate=True, clean=True, use_objstms=True)
        # Never return something bigger than the input.
        return out if len(out) < len(pdf_bytes) else pdf_bytes
    finally:
        doc.close()


async def compress_pdf(
    pdf_bytes: bytes, image_dpi: int = 150, image_quality: int = 70
) -> bytes:
    return await asyncio.to_thread(_compress_sync, pdf_bytes, image_dpi, image_quality)


def _to_text_sync(pdf_bytes: bytes, spec: str) -> List[Dict]:
    doc = _open_pdf(pdf_bytes)
    try:
        return [
            {"page": i + 1, "text": doc[i].get_text("text")}
            for i in parse_page_spec(spec, doc.page_count)
        ]
    finally:
        doc.close()


async def pdf_to_text(pdf_bytes: bytes, spec: str = "all") -> List[Dict]:
    return await asyncio.to_thread(_to_text_sync, pdf_bytes, spec)


def _to_images_sync(
    pdf_bytes: bytes, spec: str, dpi: int, fmt: str
) -> Tuple[bytes, int]:
    import fitz

    doc = _open_pdf(pdf_bytes)
    try:
        indices = parse_page_spec(spec, doc.page_count)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            for i in indices:
                pix = doc[i].get_pixmap(dpi=dpi, alpha=False)
                ext = "jpg" if fmt == "jpeg" else "png"
                zf.writestr(f"page-{i + 1:04d}.{ext}", pix.tobytes(fmt))
        return buf.getvalue(), len(indices)
    finally:
        doc.close()


async def pdf_to_images(
    pdf_bytes: bytes, spec: str = "all", dpi: int = 150, fmt: str = "png"
) -> Tuple[bytes, int]:
    """Rasterize pages → ZIP of PNG/JPEG. Returns (zip_bytes, page_count)."""
    if fmt not in ("png", "jpeg"):
        raise PdfOpsError("format must be 'png' or 'jpeg'")
    if not 30 <= dpi <= 600:
        raise PdfOpsError("dpi must be between 30 and 600")
    return await asyncio.to_thread(_to_images_sync, pdf_bytes, spec, dpi, fmt)


def _from_images_sync(images: Sequence[bytes]) -> bytes:
    import fitz

    out = fitz.open()
    try:
        for i, data in enumerate(images):
            try:
                img = fitz.open(stream=data)
                pdf_bytes = img.convert_to_pdf()
                img.close()
            except Exception as e:
                raise PdfOpsError(f"Image {i + 1} could not be read: {e}")
            src = fitz.open("pdf", pdf_bytes)
            out.insert_pdf(src)
            src.close()
        return _save(out)
    finally:
        out.close()


async def images_to_pdf(images: Sequence[bytes]) -> bytes:
    if not images:
        raise PdfOpsError("Provide at least one image")
    return await asyncio.to_thread(_from_images_sync, images)


def _hex_to_rgb(color: str) -> Tuple[float, float, float]:
    c = (color or "").lstrip("#")
    if len(c) != 6:
        raise PdfOpsError("color must be a 6-digit hex value like '888888'")
    try:
        return tuple(int(c[i : i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore
    except ValueError:
        raise PdfOpsError("color must be a 6-digit hex value like '888888'")


def _watermark_sync(
    pdf_bytes: bytes,
    text: str,
    opacity: float,
    font_size: int,
    color: str,
    angle: int,
    spec: str,
) -> bytes:
    import fitz

    doc = _open_pdf(pdf_bytes)
    try:
        rgb = _hex_to_rgb(color)
        font = fitz.Font("helv")
        for i in set(parse_page_spec(spec, doc.page_count)):
            page = doc[i]
            rect = page.rect
            tw = fitz.TextWriter(rect, opacity=opacity, color=rgb)
            width = font.text_length(text, fontsize=font_size)
            center = fitz.Point(rect.width / 2, rect.height / 2)
            origin = fitz.Point(center.x - width / 2, center.y + font_size / 3)
            tw.append(origin, text, font=font, fontsize=font_size)
            tw.write_text(page, morph=(center, fitz.Matrix(angle)))
        return _save(doc)
    finally:
        doc.close()


async def add_watermark(
    pdf_bytes: bytes,
    text: str,
    opacity: float = 0.15,
    font_size: int = 48,
    color: str = "888888",
    angle: int = 45,
    spec: str = "all",
) -> bytes:
    if not text.strip():
        raise PdfOpsError("Watermark text is required")
    if not 0.02 <= opacity <= 1.0:
        raise PdfOpsError("opacity must be between 0.02 and 1.0")
    return await asyncio.to_thread(
        _watermark_sync, pdf_bytes, text, opacity, font_size, color, angle, spec
    )


def _info_sync(pdf_bytes: bytes) -> Dict:
    doc = _open_pdf(pdf_bytes)
    try:
        first = doc[0].rect
        return {
            "page_count": doc.page_count,
            "encrypted": bool(doc.needs_pass),
            "metadata": {k: v for k, v in (doc.metadata or {}).items() if v},
            "first_page_size_pts": {"width": first.width, "height": first.height},
            "toc_entries": len(doc.get_toc(simple=True)),
        }
    finally:
        doc.close()


async def pdf_info(pdf_bytes: bytes) -> Dict:
    return await asyncio.to_thread(_info_sync, pdf_bytes)


def _form_fields_sync(pdf_bytes: bytes) -> List[Dict]:
    """List AcroForm fields: name, type, current value, page, options."""
    doc = _open_pdf(pdf_bytes)
    try:
        out: List[Dict] = []
        for pno in range(doc.page_count):
            for w in doc[pno].widgets() or []:
                entry: Dict = {
                    "name": w.field_name,
                    "type": w.field_type_string,
                    "value": w.field_value,
                    "page": pno + 1,
                    "required": bool(w.field_flags & 2),
                    "readonly": bool(w.field_flags & 1),
                }
                if w.choice_values:
                    entry["options"] = w.choice_values
                out.append(entry)
        return out
    finally:
        doc.close()


async def form_fields(pdf_bytes: bytes) -> List[Dict]:
    return await asyncio.to_thread(_form_fields_sync, pdf_bytes)


def _fill_form_sync(pdf_bytes: bytes, values: Dict, flatten: bool) -> Tuple[bytes, int]:
    """Fill AcroForm fields by name → (filled PDF, fields updated).

    Checkbox values accept true/false, "yes"/"no", "on"/"off" (any case).
    flatten=True bakes appearances into page content so values render
    everywhere and can no longer be edited — do this BEFORE signing, since
    any post-signature change (flattening included) breaks the signature.
    """
    import fitz

    truthy = {"true", "yes", "on", "1", "checked"}
    doc = _open_pdf(pdf_bytes)
    try:
        filled = 0
        unknown = dict(values)
        for pno in range(doc.page_count):
            for w in doc[pno].widgets() or []:
                if w.field_name not in values:
                    continue
                unknown.pop(w.field_name, None)
                val = values[w.field_name]
                if w.field_type == fitz.PDF_WIDGET_TYPE_CHECKBOX:
                    w.field_value = (
                        bool(val)
                        if isinstance(val, bool)
                        else str(val).strip().lower() in truthy
                    )
                elif w.field_type == fitz.PDF_WIDGET_TYPE_RADIOBUTTON:
                    w.field_value = str(val)
                else:
                    w.field_value = "" if val is None else str(val)
                w.update()
                filled += 1
        if unknown:
            raise PdfOpsError(
                f"Unknown form field(s): {', '.join(sorted(unknown))}. "
                "Use POST /pdf/form-fields to list the fields this PDF has."
            )
        if flatten:
            # bake() replaces widgets with static page content (PyMuPDF >= 1.23)
            if not hasattr(doc, "bake"):
                raise PdfOpsError(
                    "flatten=true needs a newer PyMuPDF on this server; "
                    "retry with flatten=false"
                )
            doc.bake()
        return _save(doc), filled
    finally:
        doc.close()


async def fill_form(pdf_bytes: bytes, values: Dict, flatten: bool = False) -> Tuple[bytes, int]:
    return await asyncio.to_thread(_fill_form_sync, pdf_bytes, values, flatten)
