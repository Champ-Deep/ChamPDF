"""
GPU video watermark remover — pluggable external offload.

Railway (and most CPU hosts) have no GPU, and OpenCV/FFmpeg inpainting is weak
on detailed backgrounds. For the "Best" quality path we offload the heavy
video inpainting to a hosted GPU provider and keep Railway as the orchestrator:
extract audio → send video + a static region mask to the provider → get a
cleaned MP4 back → re-mux audio + overlay the new logo locally.

Provider is selected with VIDEO_GPU_PROVIDER. Today only "replicate" (hosted
ProPainter) is wired up; the interface is deliberately small so another
provider can be dropped in. Everything is env-gated: with no token the feature
reports unavailable via /api/capabilities and the UI hides the "Best" option.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class GpuVideoError(Exception):
    """Raised when GPU offload is unavailable or the remote job fails."""


def _provider() -> str:
    return (os.environ.get("VIDEO_GPU_PROVIDER", "none") or "none").strip().lower()


def gpu_removal_available() -> bool:
    """True iff a GPU provider is configured with credentials and its SDK."""
    provider = _provider()
    if provider == "replicate":
        if not os.environ.get("REPLICATE_API_TOKEN"):
            return False
        try:
            import replicate  # noqa: F401

            return True
        except ImportError:
            return False
    return False


def _model_slug() -> str:
    return os.environ.get("REPLICATE_PROPAINTER_MODEL", "jd7h/propainter")


def _read_output(output) -> bytes:
    """Coerce the Replicate SDK's varied output shapes into raw MP4 bytes.

    Depending on SDK version / model, output may be a FileOutput object, a URL
    string, or a list containing either. Handle all of them.
    """
    # Lists / tuples: take the first element.
    if isinstance(output, (list, tuple)):
        if not output:
            raise GpuVideoError("GPU provider returned an empty result")
        output = output[0]

    # Newer SDK returns a FileOutput with .read().
    read = getattr(output, "read", None)
    if callable(read):
        data = read()
        if data:
            return data

    # Otherwise expect a URL string (or an object whose str() is a URL).
    url = getattr(output, "url", None) or (output if isinstance(output, str) else None)
    if not url:
        url = str(output)
    if not isinstance(url, str) or not url.startswith("http"):
        raise GpuVideoError("GPU provider returned an unrecognized result")

    import urllib.request

    with urllib.request.urlopen(url, timeout=120) as resp:  # noqa: S310 (trusted provider URL)
        return resp.read()


def _output_ref(o) -> str:
    """Best-effort URL/string for an output element, lowercased."""
    return (getattr(o, "url", None) or (o if isinstance(o, str) else str(o)) or "").lower()


def _select_output(output):
    """Pick the *inpainted* result when a model returns several files.

    `jd7h/propainter` returns two videos — `masked_in.mp4` (a preview of the
    mask overlay) and `inpaint_out.mp4` (the clean result). Taking the first
    element would hand back the masked preview, so choose deliberately:
      - dict  → prefer an inpaint-ish key, else the last value
      - list  → an element whose URL contains "inpaint", else one that does NOT
                contain "mask", else the last element
      - scalar → as-is
    """
    if isinstance(output, dict):
        for key in ("inpaint_out", "inpainted", "output", "video"):
            if output.get(key):
                return output[key]
        vals = [v for v in output.values() if v]
        return vals[-1] if vals else None
    if isinstance(output, (list, tuple)):
        if not output:
            return None
        for o in output:
            if "inpaint" in _output_ref(o):
                return o
        for o in output:
            if "mask" not in _output_ref(o):
                return o
        return output[-1]
    return output


def _run_replicate(video_path: str, mask_path: str) -> bytes:
    """Blocking Replicate call — run a hosted ProPainter inpainting model."""
    import replicate

    model = _model_slug()
    # ProPainter-style models take the source `video` and a `mask`. A single
    # mask image is applied to every frame, which is exactly right for a
    # fixed-position watermark. Key names follow the common ProPainter schema;
    # override the model slug if a variant expects different inputs.
    with open(video_path, "rb") as vf, open(mask_path, "rb") as mf:
        inputs = {
            "video": vf,
            "mask": mf,
            "mask_dilation": 8,
        }
        try:
            output = replicate.run(model, input=inputs)
        except Exception as e:  # noqa: BLE001 — surface a clean message
            # Retry without the optional tuning key in case the model rejects it.
            msg = str(e).lower()
            if "mask_dilation" in msg or "unexpected" in msg or "invalid" in msg:
                vf.seek(0)
                mf.seek(0)
                output = replicate.run(model, input={"video": vf, "mask": mf})
            else:
                raise GpuVideoError(f"Replicate ProPainter failed: {e}")

    chosen = _select_output(output)
    if chosen is None:
        raise GpuVideoError("GPU provider returned no usable output")
    data = _read_output(chosen)
    if not data:
        raise GpuVideoError("GPU provider returned no video data")
    return data


async def remove_watermark(video_path: str, mask_png_bytes: bytes) -> bytes:
    """Offload watermark removal to the GPU provider → cleaned MP4 bytes.

    Args:
        video_path: local path to the source video (audio is handled by caller).
        mask_png_bytes: a 1-channel-ish PNG, white over the watermark region.

    Raises GpuVideoError on any failure so the caller can fall back to CPU.
    """
    if not gpu_removal_available():
        raise GpuVideoError(
            "GPU video removal needs VIDEO_GPU_PROVIDER + provider credentials set."
        )

    timeout = int(os.environ.get("GPU_VIDEO_TIMEOUT", "600"))

    work_dir = tempfile.mkdtemp(prefix="champdf_gpu_")
    mask_path = os.path.join(work_dir, "mask.png")
    try:
        Path(mask_path).write_bytes(mask_png_bytes)
        provider = _provider()
        if provider != "replicate":
            raise GpuVideoError(f"Unknown VIDEO_GPU_PROVIDER: {provider}")
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(_run_replicate, video_path, mask_path),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            raise GpuVideoError(
                f"GPU video job timed out after {timeout}s. Try a shorter clip."
            )
    except GpuVideoError:
        raise
    except Exception as e:  # noqa: BLE001
        raise GpuVideoError(f"GPU video removal failed: {e}")
    finally:
        import shutil

        shutil.rmtree(work_dir, ignore_errors=True)
