"""
Summarizer — LLM summaries via OpenRouter (any model: GPT, Claude, Gemini, Llama…).

OpenRouter exposes an OpenAI-compatible /chat/completions endpoint, so we hit it
with the stdlib (no extra dependency). Set OPENROUTER_API_KEY to enable; pick a
default model with OPENROUTER_MODEL (per-request override allowed).
"""

import json
import os
import logging
import urllib.request
import urllib.error

logger = logging.getLogger(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "openai/gpt-4o-mini"

# Small allowlist surfaced to the UI; any OpenRouter model id also works.
SUGGESTED_MODELS = [
    "openai/gpt-4o-mini",
    "anthropic/claude-3.5-haiku",
    "google/gemini-flash-1.5",
    "meta-llama/llama-3.1-70b-instruct",
]


class SummarizeError(Exception):
    """Raised when summarization is unavailable or the LLM call fails."""


def summary_available() -> bool:
    """True iff an OpenRouter API key is configured."""
    return bool(os.environ.get("OPENROUTER_API_KEY"))


def summarize_transcript(
    transcript: str,
    model: str | None = None,
    instructions: str | None = None,
    max_chars: int = 24000,
) -> str:
    """
    Summarize a transcript with an OpenRouter model. Returns markdown text.

    Truncates very long transcripts to keep latency/cost predictable.
    """
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise SummarizeError("OPENROUTER_API_KEY is not set on the server.")

    text = (transcript or "").strip()
    if not text:
        raise SummarizeError("Transcript is empty — nothing to summarize.")
    if len(text) > max_chars:
        text = text[:max_chars] + "\n…[transcript truncated]"

    model = model or os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL)
    system = (
        "You are a precise assistant that summarizes video transcripts for a "
        "busy team. Be faithful to the transcript; do not invent facts."
    )
    user = (
        instructions
        or (
            "Summarize this video transcript. Respond in markdown with:\n"
            "1. A 2–3 sentence overview.\n"
            "2. '**Key points:**' as 5–8 concise bullets.\n"
            "3. '**Action items:**' as bullets if any are implied (else omit)."
        )
    ) + "\n\nTRANSCRIPT:\n" + text

    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.3,
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        OPENROUTER_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # OpenRouter attribution headers (optional but recommended).
            "HTTP-Referer": os.environ.get("OPENROUTER_REFERER", "https://champdf.com"),
            "X-Title": "ChamPDF",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:300]
        except Exception:
            detail = str(e)
        raise SummarizeError(f"OpenRouter error {e.code}: {detail}")
    except Exception as e:
        raise SummarizeError(f"OpenRouter request failed: {e}")

    try:
        return payload["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as e:
        raise SummarizeError(f"Unexpected OpenRouter response shape: {e}")
