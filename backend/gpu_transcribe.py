"""
GPU transcription — hosted Whisper large-v3 via Replicate or Groq (optional,
higher accuracy/speed than the default CPU path).

The default captions path is local faster-whisper (CPU, no key). When either
provider is configured, this offloads to a hosted Whisper for faster, more
accurate transcripts. Returns plain text + an SRT built from the model's
timestamps. Env-gated; falls back to CPU when unavailable.

Provider selection is VIDEO_GPU_PROVIDER (shared with gpu_video_remover.py /
video_matte.py for the "replicate" value) — but "groq" is valid *only* here.
Groq hosts Whisper (fast LPU inference) but has no video models, so it cannot
serve the video-pixel GPU paths those other modules use.
"""

from __future__ import annotations

import asyncio
import os
from typing import Optional

from replicate_client import ReplicateError, replicate_available, run_model_raw
import groq_client


def _provider() -> str:
    return (os.environ.get("VIDEO_GPU_PROVIDER", "none") or "none").strip().lower()


def gpu_transcribe_available() -> bool:
    return replicate_available() or (
        _provider() == "groq" and groq_client.groq_available()
    )


def _model_slug() -> str:
    return os.environ.get(
        "REPLICATE_WHISPER_MODEL", "vaibhavs10/incredibly-fast-whisper"
    )


def _fmt_ts(seconds: Optional[float]) -> str:
    """Seconds → SRT timestamp HH:MM:SS,mmm."""
    total_ms = int(round((seconds or 0.0) * 1000))
    h, total_ms = divmod(total_ms, 3_600_000)
    m, total_ms = divmod(total_ms, 60_000)
    s, ms = divmod(total_ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _to_srt(chunks) -> str:
    lines = []
    idx = 1
    for c in chunks or []:
        if not isinstance(c, dict):
            continue
        ts = c.get("timestamp") or [None, None]
        start = ts[0] if len(ts) > 0 else None
        end = ts[1] if len(ts) > 1 else None
        text = (c.get("text") or "").strip()
        if start is None or not text:
            continue
        if end is None:
            end = start + 2.0
        lines.append(f"{idx}\n{_fmt_ts(start)} --> {_fmt_ts(end)}\n{text}\n")
        idx += 1
    return "\n".join(lines)


async def transcribe(media_path: str, language: Optional[str] = None) -> dict:
    """GPU Whisper → {"text", "srt"}. Raises ReplicateError/GroqError on failure."""
    if not gpu_transcribe_available():
        raise ReplicateError(
            "GPU transcription needs VIDEO_GPU_PROVIDER=replicate + REPLICATE_API_TOKEN "
            "(or VIDEO_GPU_PROVIDER=groq + GROQ_API_KEY)."
        )
    if _provider() == "groq" and groq_client.groq_available():
        return await asyncio.to_thread(groq_client.transcribe, media_path, language)

    with open(media_path, "rb") as f:
        inputs = {
            "audio": f,
            "task": "transcribe",
            "timestamp": "chunk",
            "batch_size": 24,
        }
        if language:
            inputs["language"] = language
        out = await run_model_raw(_model_slug(), inputs)

    if isinstance(out, dict):
        text = (out.get("text") or "").strip()
        chunks = out.get("chunks") or []
    else:
        text = str(out or "").strip()
        chunks = []
    return {"text": text, "srt": _to_srt(chunks)}
