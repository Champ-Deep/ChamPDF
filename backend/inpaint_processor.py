"""
Gemini-backed image inpainter ("Nano Banana") for the PDF Watermark Remover.

Takes an image (a rendered PDF page) and a binary mask of watermark regions,
asks Gemini's image-editing model to inpaint those regions, and returns the
result as PNG bytes. Falls back to OpenCV inpainting if Gemini is not
configured (no GEMINI_API_KEY) or fails.

The frontend renders each page to a canvas, builds the same mask it would have
fed to OpenCV.js, and POSTs both to /api/inpaint-image instead of running
cv.inpaint client-side. The inpainted PNG is then embedded into the PDF via
pdf-lib (frontend-side).
"""

from __future__ import annotations

import io
import logging
import os
from typing import Optional

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)


class InpaintError(Exception):
    """Raised when Gemini inpainting fails."""


def _gemini_available() -> bool:
    """True iff the SDK is installed and an API key is set."""
    if not os.environ.get("GEMINI_API_KEY"):
        return False
    try:
        import google.genai  # noqa: F401
        return True
    except ImportError:
        return False


def _composite_mask_overlay(image: Image.Image, mask: Image.Image) -> Image.Image:
    """
    Overlay the masked regions with a semi-transparent magenta tint so Gemini
    can see exactly which pixels need to be inpainted while still seeing the
    surrounding context. Returns an RGB image suitable for upload.
    """
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    if mask.mode != "L":
        mask = mask.convert("L")
    if mask.size != image.size:
        mask = mask.resize(image.size, Image.LANCZOS)

    overlay = Image.new("RGBA", image.size, (255, 0, 255, 0))
    overlay_alpha = mask.point(lambda v: int(v * 0.6))  # 60% opacity where masked
    overlay.putalpha(overlay_alpha)
    composited = Image.alpha_composite(image, overlay)
    return composited.convert("RGB")


def _opencv_fallback(
    image_bytes: bytes,
    mask_bytes: bytes,
    radius: int = 5,
) -> bytes:
    """OpenCV Telea inpaint as a fallback when Gemini is unavailable or errors."""
    try:
        import cv2
    except ImportError as e:
        raise InpaintError("OpenCV not installed and Gemini unavailable") from e

    img = np.array(Image.open(io.BytesIO(image_bytes)).convert("RGB"))
    msk = np.array(Image.open(io.BytesIO(mask_bytes)).convert("L"))
    if msk.shape[:2] != img.shape[:2]:
        msk = np.array(
            Image.fromarray(msk).resize((img.shape[1], img.shape[0]), Image.LANCZOS)
        )
    bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    inpainted = cv2.inpaint(bgr, msk, radius, cv2.INPAINT_TELEA)
    rgb = cv2.cvtColor(inpainted, cv2.COLOR_BGR2RGB)
    out = io.BytesIO()
    Image.fromarray(rgb).save(out, format="PNG", optimize=True)
    return out.getvalue()


async def inpaint_image(
    image_bytes: bytes,
    mask_bytes: bytes,
    prompt: Optional[str] = None,
    radius: int = 5,
) -> bytes:
    """
    Inpaint masked regions in an image. Returns PNG bytes.

    Tries Gemini first; falls back to OpenCV Telea on any error so the
    endpoint never returns 500 just because Gemini is rate-limited or down.
    """
    if not _gemini_available():
        logger.info("[inpaint] Gemini unavailable; using OpenCV fallback")
        return _opencv_fallback(image_bytes, mask_bytes, radius=radius)

    try:
        return await _inpaint_with_gemini(image_bytes, mask_bytes, prompt)
    except Exception as e:
        logger.warning("[inpaint] Gemini call failed (%s); falling back to OpenCV", e)
        return _opencv_fallback(image_bytes, mask_bytes, radius=radius)


async def _inpaint_with_gemini(
    image_bytes: bytes,
    mask_bytes: bytes,
    user_prompt: Optional[str] = None,
) -> bytes:
    """
    Call Gemini's image-editing model with the masked image. The mask is
    composited onto the original as a magenta overlay so the model can see
    exactly which pixels to replace.
    """
    from google import genai
    from google.genai import types

    image = Image.open(io.BytesIO(image_bytes))
    mask = Image.open(io.BytesIO(mask_bytes))
    composite = _composite_mask_overlay(image, mask)

    composite_buf = io.BytesIO()
    composite.save(composite_buf, format="PNG", optimize=True)
    composite_bytes = composite_buf.getvalue()

    default_prompt = (
        "This is a document page with a watermark or logo highlighted in "
        "semi-transparent magenta. Remove the highlighted region completely and "
        "inpaint the underlying area to match the surrounding background "
        "(page color, text alignment, table lines, etc.). Preserve every other "
        "pixel of the document exactly as-is. Return only the cleaned image, "
        "no text overlay, no annotations."
    )
    prompt = user_prompt or default_prompt

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    model = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image-preview")

    response = client.models.generate_content(
        model=model,
        contents=[
            prompt,
            types.Part.from_bytes(data=composite_bytes, mime_type="image/png"),
        ],
    )

    for candidate in response.candidates or []:
        for part in candidate.content.parts or []:
            inline = getattr(part, "inline_data", None)
            if inline and inline.data:
                # google-genai may return raw bytes or base64; normalize to bytes
                data = inline.data
                if isinstance(data, str):
                    import base64
                    data = base64.b64decode(data)
                return _ensure_png(data)

    raise InpaintError("Gemini returned no image data")


def _ensure_png(data: bytes) -> bytes:
    """Re-encode whatever Gemini returned as PNG so the frontend gets a stable type."""
    img = Image.open(io.BytesIO(data))
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()
