"""
GPU video watermark remover — Replicate (hosted ProPainter) offload.

Railway has no GPU and OpenCV/FFmpeg inpainting is weak on detailed backgrounds.
For the "Best" quality path we offload the heavy video inpainting to a hosted
ProPainter model and keep Railway as the orchestrator: extract audio → send
video + a static region mask → get a cleaned MP4 back → re-mux audio + overlay
the new logo locally.

Shared Replicate plumbing lives in `replicate_client`; this module only adds the
ProPainter specifics (model slug, input shape, output selection). Back-compat
names (`GpuVideoError`, `gpu_removal_available`) are re-exported so existing
callers keep working.
"""

from __future__ import annotations

import os

from replicate_client import (
    ReplicateError,
    output_ref,
    read_bytes,
    replicate_available,
    run_model_raw,
)

# Back-compat aliases for existing imports in video_processor.py / main.py.
GpuVideoError = ReplicateError
gpu_removal_available = replicate_available


def _model_slug() -> str:
    return os.environ.get("REPLICATE_PROPAINTER_MODEL", "jd7h/propainter")


def _select_output(output):
    """Pick the *inpainted* result when ProPainter returns several files.

    `jd7h/propainter` returns two videos — `masked_in.mp4` (a preview of the mask
    overlay) and `inpaint_out.mp4` (the clean result). Choose deliberately:
      - dict  → prefer an inpaint-ish key, else the last value
      - list  → an element whose URL contains "inpaint", else one NOT containing
                "mask", else the last element
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
            if "inpaint" in output_ref(o):
                return o
        for o in output:
            if "mask" not in output_ref(o):
                return o
        return output[-1]
    return output


async def remove_watermark(video_path: str, mask_png_bytes: bytes) -> bytes:
    """Offload watermark removal to ProPainter → cleaned MP4 bytes.

    Args:
        video_path: local path to the source video (audio handled by caller).
        mask_png_bytes: a PNG, white over the watermark region.

    Raises ReplicateError on any failure so the caller can fall back to CPU.
    """
    if not gpu_removal_available():
        raise ReplicateError(
            "GPU video removal needs VIDEO_GPU_PROVIDER=replicate + REPLICATE_API_TOKEN."
        )

    import tempfile
    import shutil
    from pathlib import Path

    model = _model_slug()
    work_dir = tempfile.mkdtemp(prefix="champdf_gpu_")
    mask_path = os.path.join(work_dir, "mask.png")
    try:
        Path(mask_path).write_bytes(mask_png_bytes)
        # Keep file handles open across the await — the SDK uploads them inside
        # run_model_raw's worker thread. A single static mask is applied to every
        # frame, which is right for a fixed-position watermark.
        with open(video_path, "rb") as vf, open(mask_path, "rb") as mf:
            try:
                output = await run_model_raw(
                    model, {"video": vf, "mask": mf, "mask_dilation": 8}
                )
            except ReplicateError as e:
                # Retry without the optional tuning key if the model rejects it.
                msg = str(e).lower()
                if "mask_dilation" in msg or "invalid" in msg or "unexpected" in msg:
                    vf.seek(0)
                    mf.seek(0)
                    output = await run_model_raw(model, {"video": vf, "mask": mf})
                else:
                    raise

        chosen = _select_output(output)
        if chosen is None:
            raise ReplicateError("ProPainter returned no usable output")
        data = read_bytes(chosen)
        if not data:
            raise ReplicateError("ProPainter returned no video data")
        return data
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
