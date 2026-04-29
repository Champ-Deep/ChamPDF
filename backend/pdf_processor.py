"""
Server-side PDF watermark remover. Used by /api/v1/pdf/remove-watermark.

Takes a PDF + a list of region rectangles in PDF-point coordinates, renders
the affected pages to images at 2x scale, builds a mask, runs the existing
inpaint pipeline (Gemini or OpenCV), and embeds the cleaned page image back
into the PDF.

The frontend tool /remove-watermark.html does the same thing client-side
via OpenCV.js + pdf-lib. This server-side path exists so AI agents (via
the v1 API + MCP) and external scripts can run the same operation
without a browser.

Coordinate convention:
- Regions arrive as a JSON list of {page: 1-indexed, x, y, w, h} where
  x/y/w/h are in PDF points (1 pt = 1/72 in). Origin is top-left of the
  page (matches what most callers expect).
- We render each page at 2x scale (144 DPI) to image, scale the regions
  to pixel coordinates, build a binary mask, inpaint, embed.
"""

from __future__ import annotations

import asyncio
import io
import logging
from pathlib import Path
from typing import List, Optional, TypedDict

logger = logging.getLogger(__name__)


class PdfRegion(TypedDict):
    page: int  # 1-indexed
    x: float
    y: float
    w: float
    h: float


class PdfWatermarkError(Exception):
    """Raised when PDF watermark removal fails."""


async def remove_watermarks_from_pdf(
    pdf_bytes: bytes,
    regions: List[PdfRegion],
    method: str = "telea",
    radius: int = 5,
) -> bytes:
    """
    Render → mask → inpaint → re-embed → return PDF bytes.

    `method` is one of {"telea", "ns", "gemini"}. The first two run
    OpenCV locally; the third routes through Gemini and falls back to
    OpenCV if Gemini is unavailable.
    """
    if not pdf_bytes:
        raise PdfWatermarkError("Empty PDF input.")
    if not regions:
        raise PdfWatermarkError("No regions provided.")
    if method not in {"telea", "ns", "gemini"}:
        raise PdfWatermarkError(f"Unknown method '{method}'.")

    # Lazy imports keep startup time reasonable for non-PDF endpoints.
    try:
        import fitz  # PyMuPDF
    except ImportError as e:
        raise PdfWatermarkError(
            "PyMuPDF is not installed on the server."
        ) from e

    try:
        from PIL import Image, ImageDraw
        import numpy as np  # noqa: F401  (used indirectly via inpaint_image)
    except ImportError as e:
        raise PdfWatermarkError("Pillow / numpy not available.") from e

    from inpaint_processor import inpaint_image, _opencv_fallback

    src = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        pages_with_regions: dict[int, List[PdfRegion]] = {}
        for r in regions:
            pages_with_regions.setdefault(int(r["page"]), []).append(r)

        for page_idx_1based, page_regions in pages_with_regions.items():
            if page_idx_1based < 1 or page_idx_1based > src.page_count:
                raise PdfWatermarkError(
                    f"Region references page {page_idx_1based} but PDF has {src.page_count} pages."
                )

            page = src[page_idx_1based - 1]
            page_w_pt = page.rect.width
            page_h_pt = page.rect.height

            # Render at 2x scale (144 DPI). Higher = better fidelity, costlier.
            zoom = 2.0
            mat = fitz.Matrix(zoom, zoom)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            img_bytes = pix.tobytes("png")

            # Build the binary mask at the same pixel size.
            px_w, px_h = pix.width, pix.height
            mask = Image.new("L", (px_w, px_h), 0)
            draw = ImageDraw.Draw(mask)
            sx = px_w / page_w_pt
            sy = px_h / page_h_pt
            for r in page_regions:
                x0 = max(0, int(round(float(r["x"]) * sx)))
                y0 = max(0, int(round(float(r["y"]) * sy)))
                x1 = min(px_w, int(round((float(r["x"]) + float(r["w"])) * sx)))
                y1 = min(px_h, int(round((float(r["y"]) + float(r["h"])) * sy)))
                if x1 > x0 and y1 > y0:
                    draw.rectangle([x0, y0, x1, y1], fill=255)

            mask_buf = io.BytesIO()
            mask.save(mask_buf, format="PNG")
            mask_bytes = mask_buf.getvalue()

            # Inpaint
            if method == "gemini":
                inpainted_png = await inpaint_image(
                    image_bytes=img_bytes,
                    mask_bytes=mask_bytes,
                    radius=radius,
                )
            else:
                # Run blocking OpenCV in a thread so the event loop stays free
                inpainted_png = await asyncio.to_thread(
                    _opencv_fallback, img_bytes, mask_bytes, radius
                )

            # Replace the page with a raster of the inpainted result. Delete
            # the original first, then create a fresh page at the same 0-based
            # index (PyMuPDF's new_page(pno=N) inserts at index N when N <
            # page_count, or appends when N == page_count).
            target_idx = page_idx_1based - 1
            src.delete_page(target_idx)
            new_page = src.new_page(
                pno=target_idx,
                width=page_w_pt,
                height=page_h_pt,
            )
            new_page.insert_image(
                fitz.Rect(0, 0, page_w_pt, page_h_pt),
                stream=inpainted_png,
            )

        out_buf = io.BytesIO()
        src.save(out_buf, garbage=4, deflate=True, clean=True)
        return out_buf.getvalue()
    finally:
        src.close()
