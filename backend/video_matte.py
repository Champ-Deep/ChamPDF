"""
Video Background Remover — Robust Video Matting via Replicate.

Mirrors the image background remover (rembg) for video: temporally-consistent
matting so a moving subject is cut out without per-frame flicker. Offloaded to a
hosted GPU model (Railway has no GPU); env-gated like the other Replicate
features and reported via /api/capabilities.
"""

from __future__ import annotations

import os

from replicate_client import ReplicateError, first_output, replicate_available, run_model

# Back-compat / clarity alias.
MatteError = ReplicateError


def matte_available() -> bool:
    return replicate_available()


def _model_slug() -> str:
    return os.environ.get(
        "REPLICATE_RVM_MODEL", "arielreplicate/robust_video_matting"
    )


# UI mode → the model's output_type option.
_MODE_TO_OUTPUT = {
    "green": "green-screen",
    "alpha": "alpha-mask",
    "foreground": "foreground-mask",
}


async def matte_video(video_path: str, mode: str = "green") -> bytes:
    """Run video matting → bytes of the resulting video.

    mode: "green" (green-screen composite), "alpha" (grayscale alpha matte),
    or "foreground" (subject on black). Raises ReplicateError on failure.
    """
    if not matte_available():
        raise ReplicateError(
            "Video background removal needs VIDEO_GPU_PROVIDER=replicate + REPLICATE_API_TOKEN."
        )
    output_type = _MODE_TO_OUTPUT.get(mode, "green-screen")
    with open(video_path, "rb") as vf:
        return await run_model(
            _model_slug(),
            {"input_video": vf, "output_type": output_type},
            output_selector=first_output,
        )
