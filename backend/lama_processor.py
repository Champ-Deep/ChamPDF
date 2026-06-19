"""
Inpaint Processor - high quality watermark / object removal using LaMa.

Uses the `simple-lama-inpainting` package (LaMa, Resolution-robust Large Mask
Inpainting with Fourier Convolutions, WACV 2022). Given an image and a 1-channel
binary mask (white = remove), LaMa reconstructs the masked region from the
surrounding content. This is dramatically cleaner than blur / content-aware fill
for NotebookLM-style logos, stamps and watermarks.

The model is heavy (~200MB) so it is loaded lazily on first use and reused.
"""

import io
import asyncio
import logging
from typing import List, Optional

import numpy as np
from PIL import Image, ImageFilter

logger = logging.getLogger(__name__)


class InpaintProcessor:
    """LaMa-based image inpainting (lazy-loaded, thread-offloaded)."""

    def __init__(self, device: Optional[str] = None):
        self._model = None
        self._device = device
        self._lock = asyncio.Lock()

    def _ensure_model(self):
        """Load the LaMa model once. Runs in a worker thread (blocking import)."""
        if self._model is None:
            from simple_lama_inpainting import SimpleLama  # heavy import

            # SimpleLama reads the LAMA device from the TORCH device automatically;
            # passing device keeps CPU/GPU selection explicit where supported.
            try:
                self._model = SimpleLama(device=self._device) if self._device else SimpleLama()
            except TypeError:
                # Older versions don't accept a device kwarg.
                self._model = SimpleLama()
            logger.info("LaMa inpainting model loaded (device=%s)", self._device or "default")
        return self._model

    @staticmethod
    def _mask_from_boxes(
        size: tuple[int, int],
        boxes: List[dict],
        feather: int = 6,
    ) -> Image.Image:
        """
        Build a 1-channel mask (white = inpaint) from a list of pixel boxes.
        Each box: {"x", "y", "w", "h"} in source-image pixels.
        `feather` softly grows + blurs the edges so the patch blends in.
        """
        width, height = size
        mask = Image.new("L", (width, height), 0)
        px = mask.load()
        for box in boxes:
            x = max(0, int(box["x"]) - feather)
            y = max(0, int(box["y"]) - feather)
            x2 = min(width, int(box["x"]) + int(box["w"]) + feather)
            y2 = min(height, int(box["y"]) + int(box["h"]) + feather)
            for yy in range(y, y2):
                for xx in range(x, x2):
                    px[xx, yy] = 255
        if feather > 0:
            mask = mask.filter(ImageFilter.GaussianBlur(radius=feather / 2))
            # Re-binarize so LaMa gets a clean mask after the blur.
            mask = mask.point(lambda v: 255 if v > 32 else 0)
        return mask

    def _run(self, image: Image.Image, mask: Image.Image) -> Image.Image:
        model = self._ensure_model()
        return model(image.convert("RGB"), mask.convert("L"))

    async def inpaint(self, image_bytes: bytes, mask_bytes: bytes) -> bytes:
        """Inpaint using an externally supplied mask (white = remove)."""
        async with self._lock:  # serialize model access; protected further by main semaphore
            image = Image.open(io.BytesIO(image_bytes))
            mask = Image.open(io.BytesIO(mask_bytes)).convert("L")
            if mask.size != image.size:
                mask = mask.resize(image.size, Image.NEAREST)
            result = await asyncio.to_thread(self._run, image, mask)
            out = io.BytesIO()
            result.save(out, format="PNG")
            logger.info("Inpaint complete: %s", image.size)
            return out.getvalue()

    async def inpaint_boxes(
        self,
        image_bytes: bytes,
        boxes: List[dict],
        feather: int = 6,
    ) -> bytes:
        """Inpaint one or more rectangular regions (e.g. a detected watermark)."""
        if not boxes:
            raise ValueError("No regions provided for inpainting")
        async with self._lock:
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            mask = self._mask_from_boxes(image.size, boxes, feather=feather)
            result = await asyncio.to_thread(self._run, image, mask)
            out = io.BytesIO()
            result.save(out, format="PNG")
            logger.info("Inpaint (boxes=%d) complete: %s", len(boxes), image.size)
            return out.getvalue()

    def inpaint_array(self, frame: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """
        Synchronous helper for per-frame video inpainting.
        `frame`: HxWx3 RGB uint8, `mask`: HxW uint8 (255 = remove). Returns RGB.
        """
        model = self._ensure_model()
        result = model(Image.fromarray(frame).convert("RGB"), Image.fromarray(mask).convert("L"))
        return np.array(result.convert("RGB"))
