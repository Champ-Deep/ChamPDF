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


class EditError(Exception):
    """Raised when prompt-based image editing fails."""


class DetectError(Exception):
    """Raised when watermark auto-detection fails."""


async def detect_watermarks(image_bytes: bytes) -> list[dict]:
    """
    Ask Gemini to find watermarks/logos in an image and return their
    bounding boxes as a list of {x, y, w, h, label, confidence} dicts in
    pixel coordinates of the input image.

    Returns an empty list if Gemini finds nothing. Raises DetectError if
    Gemini is not configured or returns malformed output.
    """
    if not _gemini_available():
        raise DetectError(
            "Auto-detect requires Gemini (GEMINI_API_KEY not set on the server)."
        )

    try:
        img = Image.open(io.BytesIO(image_bytes))
        img.load()
    except Exception as e:
        raise DetectError(f"Could not read input image: {e}") from e

    width, height = img.size
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")

    # Cap dimensions for predictable latency / cost.
    max_side = 1536
    if max(img.size) > max_side:
        ratio = max_side / max(img.size)
        new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
        img = img.resize(new_size, Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    normalized_bytes = buf.getvalue()
    sent_w, sent_h = img.size

    detect_prompt = (
        "You are a vision model. Find every watermark, AI-generated logo, "
        "or stamped overlay (e.g. NotebookLM corner logos, brand watermarks, "
        '"PROOF"/"DRAFT" stamps, software trial overlays) in this document '
        "page image. Return ONLY a JSON object with this exact shape:\n"
        '{"watermarks": [{"x": int, "y": int, "w": int, "h": int, '
        '"label": string, "confidence": float}]}\n'
        f"Coordinates must be pixel offsets from the top-left of an image "
        f"that is {sent_w}x{sent_h} pixels. Boxes should snugly fit the "
        "watermark with ~5px margin. If no watermark is present, return "
        '{"watermarks": []}. Do NOT include any text outside the JSON.'
    )

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        # Use a Gemini model that does well on structured output. The image
        # editing model is overkill for detection; default to a vision-capable
        # text model if GEMINI_DETECT_MODEL is set.
        model = os.environ.get("GEMINI_DETECT_MODEL", "gemini-2.5-flash")

        response = client.models.generate_content(
            model=model,
            contents=[
                detect_prompt,
                types.Part.from_bytes(data=normalized_bytes, mime_type="image/png"),
            ],
        )

        # Pull the first text part out of the response
        text_out = ""
        for candidate in response.candidates or []:
            for part in candidate.content.parts or []:
                if getattr(part, "text", None):
                    text_out = part.text
                    break
            if text_out:
                break

        if not text_out:
            raise DetectError("Model returned no text response.")

        import json
        import re

        # Tolerate Markdown code-fences around the JSON
        m = re.search(r"\{.*\}", text_out, re.DOTALL)
        if not m:
            raise DetectError(f"Model output was not JSON: {text_out[:200]}")
        parsed = json.loads(m.group(0))
        boxes = parsed.get("watermarks") or []

        # Scale coords back to the ORIGINAL image dimensions if we resized.
        sx = width / sent_w
        sy = height / sent_h
        out: list[dict] = []
        for b in boxes:
            try:
                x = int(round(float(b["x"]) * sx))
                y = int(round(float(b["y"]) * sy))
                w = int(round(float(b["w"]) * sx))
                h = int(round(float(b["h"]) * sy))
            except (KeyError, TypeError, ValueError):
                continue
            # Clamp to image bounds and skip degenerate boxes
            x = max(0, min(width - 1, x))
            y = max(0, min(height - 1, y))
            w = max(1, min(width - x, w))
            h = max(1, min(height - y, h))
            out.append(
                {
                    "x": x,
                    "y": y,
                    "w": w,
                    "h": h,
                    "label": str(b.get("label", "watermark"))[:80],
                    "confidence": float(b.get("confidence", 0.0)),
                }
            )
        return out
    except DetectError:
        raise
    except Exception as e:
        logger.warning("[detect] Gemini call failed: %s", e)
        raise DetectError(f"Watermark detection failed: {e}") from e


async def edit_image_with_prompt(
    image_bytes: bytes,
    prompt: str,
) -> bytes:
    """
    Prompt-based image editing via Gemini's image-editing model
    (the user-facing "Edit Banana" tool — separate from mask-based
    watermark inpainting). Returns PNG bytes.

    Unlike inpaint_image(), this does not silently fall back to OpenCV
    on failure: prompt-based edits have no classical equivalent, so a
    Gemini-unavailable error is surfaced to the caller as an EditError
    and the caller (the API endpoint) returns a 503/502.
    """
    if not _gemini_available():
        raise EditError(
            "AI image editing is not configured on this server "
            "(GEMINI_API_KEY is not set)."
        )

    if not prompt or not prompt.strip():
        raise EditError("A prompt is required for image editing.")
    if len(prompt) > 2000:
        raise EditError("Prompt is too long (max 2000 characters).")

    # Re-encode incoming bytes through PIL so we (a) reject malformed images
    # before the API call, (b) normalize to PNG, (c) cap dimensions.
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img.load()
    except Exception as e:
        raise EditError(f"Could not read input image: {e}") from e

    # Cap longest side at 2048px — Gemini handles this well and keeps
    # latency / per-request cost predictable. Preserve aspect.
    max_side = 2048
    if max(img.size) > max_side:
        ratio = max_side / max(img.size)
        new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
        img = img.resize(new_size, Image.LANCZOS)

    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    normalized_bytes = buf.getvalue()

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        model = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image-preview")

        response = client.models.generate_content(
            model=model,
            contents=[
                prompt.strip(),
                types.Part.from_bytes(data=normalized_bytes, mime_type="image/png"),
            ],
        )

        for candidate in response.candidates or []:
            for part in candidate.content.parts or []:
                inline = getattr(part, "inline_data", None)
                if inline and inline.data:
                    data = inline.data
                    if isinstance(data, str):
                        import base64
                        data = base64.b64decode(data)
                    return _ensure_png(data)

        # Surface any safety / refusal text from Gemini back to the user
        for candidate in response.candidates or []:
            for part in candidate.content.parts or []:
                if getattr(part, "text", None):
                    raise EditError(f"Model declined: {part.text[:300]}")

        raise EditError("Model returned no image and no text.")
    except EditError:
        raise
    except Exception as e:
        logger.warning("[edit] Gemini call failed: %s", e)
        raise EditError(f"Image edit failed: {e}") from e
