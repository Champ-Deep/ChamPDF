"""
Groq client — fast LLM chat + Whisper transcription via Groq's LPU-hosted models.

Groq is an inference host (LPU hardware, OpenAI-compatible API), not a video/image
GPU provider — it has no video models, so it cannot do the pixel-level work
gpu_video_remover.py / video_matte.py offload to Replicate. It only substitutes
for two things in this codebase: fast hosted Whisper transcription
(gpu_transcribe.py) and fast LLM summarization (summarizer.py). Both hit
api.groq.com's OpenAI-compatible endpoints with the stdlib (no extra dependency,
matching summarizer.py's existing OpenRouter client).
"""

from __future__ import annotations

import json
import mimetypes
import os
import uuid
import urllib.request
import urllib.error
from typing import Optional

GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions"

DEFAULT_CHAT_MODEL = "llama-3.3-70b-versatile"
DEFAULT_TRANSCRIBE_MODEL = "whisper-large-v3-turbo"


class GroqError(Exception):
    """Raised when Groq is unavailable or a request fails."""


def groq_available() -> bool:
    return bool(os.environ.get("GROQ_API_KEY"))


def _api_key() -> str:
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        raise GroqError("GROQ_API_KEY is not set on the server.")
    return key


def _post_json(url: str, key: str, body: dict, timeout: int = 120) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # Cloudflare fronts api.groq.com and 403s (error 1010) urllib's
            # default Python-urllib/x.y User-Agent — send a real one.
            "User-Agent": "ChamPDF/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:300]
        except Exception:
            detail = str(e)
        raise GroqError(f"Groq error {e.code}: {detail}")
    except Exception as e:  # noqa: BLE001
        raise GroqError(f"Groq request failed: {e}")


def chat_completion(
    system: str,
    user: str,
    model: Optional[str] = None,
    temperature: float = 0.3,
) -> str:
    """One-shot chat completion. Returns the assistant's text. Caller truncates `user`."""
    key = _api_key()
    payload = _post_json(
        GROQ_CHAT_URL,
        key,
        {
            "model": model or os.environ.get("GROQ_MODEL", DEFAULT_CHAT_MODEL),
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
        },
    )
    try:
        return payload["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as e:
        raise GroqError(f"Unexpected Groq response shape: {e}")


def _fmt_ts(seconds: Optional[float]) -> str:
    """Seconds -> SRT timestamp HH:MM:SS,mmm."""
    total_ms = int(round((seconds or 0.0) * 1000))
    h, total_ms = divmod(total_ms, 3_600_000)
    m, total_ms = divmod(total_ms, 60_000)
    s, ms = divmod(total_ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _segments_to_srt(segments) -> str:
    lines = []
    idx = 1
    for seg in segments or []:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        lines.append(
            f"{idx}\n{_fmt_ts(seg.get('start'))} --> {_fmt_ts(seg.get('end'))}\n{text}\n"
        )
        idx += 1
    return "\n".join(lines)


def _encode_multipart(fields: dict, file_field: str, filename: str, file_bytes: bytes):
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
        )
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    parts.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode()
    )
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)
    return body, f"multipart/form-data; boundary={boundary}"


def transcribe(media_path: str, language: Optional[str] = None, model: Optional[str] = None) -> dict:
    """Whisper transcription via Groq -> {"text", "srt"}. Raises GroqError on failure."""
    key = _api_key()
    with open(media_path, "rb") as f:
        file_bytes = f.read()

    fields = {
        "model": model or os.environ.get("GROQ_WHISPER_MODEL", DEFAULT_TRANSCRIBE_MODEL),
        "response_format": "verbose_json",
    }
    if language:
        fields["language"] = language

    body, content_type = _encode_multipart(
        fields, "file", os.path.basename(media_path), file_bytes
    )
    req = urllib.request.Request(
        GROQ_TRANSCRIBE_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": content_type,
            "User-Agent": "ChamPDF/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:300]
        except Exception:
            detail = str(e)
        raise GroqError(f"Groq error {e.code}: {detail}")
    except Exception as e:  # noqa: BLE001
        raise GroqError(f"Groq transcription request failed: {e}")

    text = (payload.get("text") or "").strip()
    srt = _segments_to_srt(payload.get("segments"))
    return {"text": text, "srt": srt}
