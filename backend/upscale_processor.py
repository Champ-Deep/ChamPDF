"""
Upscale Processor - image super-resolution using Real-ESRGAN.

Uses the ai-forever Real-ESRGAN implementation, which exposes a minimal
load_weights(download=True) / predict() API and auto-downloads weights for
2x / 4x / 8x scale factors. Great for sharpening rebranded thumbnails, logos
and exported video frames.
"""

import io
import asyncio
import logging
from pathlib import Path
from typing import Optional

from PIL import Image

logger = logging.getLogger(__name__)

_WEIGHT_FILES = {
    2: "RealESRGAN_x2.pth",
    4: "RealESRGAN_x4.pth",
    8: "RealESRGAN_x8.pth",
}


class UpscaleProcessor:
    """Lazy-loaded Real-ESRGAN upscaler. One model instance per scale factor."""

    def __init__(self, device: Optional[str] = None, weights_dir: Optional[Path] = None):
        self._device = device
        self._weights_dir = Path(weights_dir) if weights_dir else Path.home() / ".realesrgan"
        self._models: dict[int, object] = {}
        self._lock = asyncio.Lock()

    def _ensure_model(self, scale: int):
        if scale not in _WEIGHT_FILES:
            raise ValueError(f"Unsupported scale {scale}. Choose one of {sorted(_WEIGHT_FILES)}.")
        if scale not in self._models:
            import torch
            from RealESRGAN import RealESRGAN  # heavy import (ai-forever fork)

            device = torch.device(self._device or ("cuda" if torch.cuda.is_available() else "cpu"))
            model = RealESRGAN(device, scale=scale)
            self._weights_dir.mkdir(parents=True, exist_ok=True)
            weights_path = str(self._weights_dir / _WEIGHT_FILES[scale])
            model.load_weights(weights_path, download=True)
            self._models[scale] = model
            logger.info("Real-ESRGAN x%d loaded on %s", scale, device)
        return self._models[scale]

    def _run(self, image: Image.Image, scale: int) -> Image.Image:
        model = self._ensure_model(scale)
        return model.predict(image.convert("RGB"))

    async def upscale(self, image_bytes: bytes, scale: int = 4, output_format: str = "png") -> bytes:
        async with self._lock:
            image = Image.open(io.BytesIO(image_bytes))
            result = await asyncio.to_thread(self._run, image, scale)
            out = io.BytesIO()
            save_fmt = "PNG" if output_format.lower() == "png" else "JPEG"
            if save_fmt == "JPEG":
                result = result.convert("RGB")
            result.save(out, format=save_fmt)
            logger.info("Upscaled %s -> %s (x%d)", image.size, result.size, scale)
            return out.getvalue()
