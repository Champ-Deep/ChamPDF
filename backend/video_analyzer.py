"""
Video Analyzer — multimodal YouTube analysis via Gemini.

Gemini natively ingests a YouTube URL and analyzes BOTH the visuals and the
audio, so we can go straight from a link to a structured summary + key learnings
+ chapters without downloading/transcribing first. Used by /api/video-insights
for the "analyze" path; the Whisper + OpenRouter transcript path is the fallback
(uploads, non-YouTube, or when no Gemini key is set).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Optional

logger = logging.getLogger(__name__)


class AnalyzeError(Exception):
    """Raised when multimodal analysis is unavailable or fails."""


def is_youtube_url(url: str) -> bool:
    u = (url or "").lower()
    return "youtube.com/" in u or "youtu.be/" in u


def analyze_available() -> bool:
    """True iff the Gemini SDK is installed and an API key is set."""
    if not os.environ.get("GEMINI_API_KEY"):
        return False
    try:
        import google.genai  # noqa: F401
        return True
    except ImportError:
        return False


_PROMPT = (
    "Analyze this video for a busy team. Respond with STRICT JSON only "
    "(no markdown, no commentary) using exactly these keys:\n"
    '  "summary": a 2-3 sentence overview string,\n'
    '  "learnings": an array of 5-8 short string bullets of the key takeaways,\n'
    '  "chapters": an array of objects {"timestamp":"M:SS","title":"..."} '
    "covering the video in order.\n"
    "Base your analysis on BOTH what is shown on screen and what is said."
)


def _extract_json(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            raise
        return json.loads(m.group(0))


def _run(url: str, model: str) -> dict:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    contents = types.Content(
        parts=[
            types.Part(file_data=types.FileData(file_uri=url)),
            types.Part(text=_PROMPT),
        ]
    )
    try:
        resp = client.models.generate_content(
            model=model,
            contents=contents,
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
    except TypeError:
        # Older SDK signature without the config kwarg.
        resp = client.models.generate_content(model=model, contents=contents)

    raw = (getattr(resp, "text", None) or "").strip()
    if not raw:
        raise AnalyzeError("Gemini returned no analysis (the video may be private or too long).")

    try:
        data = _extract_json(raw)
    except Exception:
        # Degrade gracefully: hand back the raw text as the summary.
        return {"summary": raw, "learnings": [], "chapters": []}

    return {
        "summary": data.get("summary", "") or "",
        "learnings": data.get("learnings", []) or [],
        "chapters": data.get("chapters", []) or [],
    }


async def analyze_youtube(url: str, model: Optional[str] = None) -> dict:
    """Analyze a YouTube URL with Gemini → {summary, learnings, chapters}."""
    if not analyze_available():
        raise AnalyzeError("Video analysis needs GEMINI_API_KEY set on the server.")
    model = model or os.environ.get("GEMINI_VIDEO_MODEL", "gemini-2.5-flash")
    try:
        return await asyncio.to_thread(_run, url, model)
    except AnalyzeError:
        raise
    except Exception as e:
        raise AnalyzeError(f"Gemini video analysis failed: {e}")
