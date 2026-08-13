"""
Summarizer — LLM summaries via OpenRouter (any model: GPT, Claude, Gemini, Llama…)
or Groq (fast LPU-hosted Llama models).

Both expose an OpenAI-compatible /chat/completions endpoint, so we hit either
with the stdlib (no extra dependency). Set OPENROUTER_API_KEY and/or
GROQ_API_KEY to enable; pick a default model with OPENROUTER_MODEL/GROQ_MODEL
(per-request override allowed via a "groq/..." model id, see summarize_transcript).

If only one key is set, that provider is used. If both are set, OpenRouter is
the default (wider model choice) — request a Groq model explicitly (prefix
"groq/") to route to Groq instead.
"""

import json
import os
import logging
import urllib.request
import urllib.error

import groq_client

logger = logging.getLogger(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "openai/gpt-4o-mini"

# Small allowlist surfaced to the UI; any OpenRouter model id also works, as
# does any Groq model id prefixed "groq/" (e.g. "groq/llama-3.3-70b-versatile").
SUGGESTED_MODELS = [
    "openai/gpt-4o-mini",
    "anthropic/claude-3.5-haiku",
    "google/gemini-flash-1.5",
    "meta-llama/llama-3.1-70b-instruct",
    "groq/llama-3.3-70b-versatile",
]


class SummarizeError(Exception):
    """Raised when summarization is unavailable or the LLM call fails."""


def summary_available() -> bool:
    """True iff an OpenRouter or Groq API key is configured."""
    return bool(os.environ.get("OPENROUTER_API_KEY")) or groq_client.groq_available()


def summarize_transcript(
    transcript: str,
    model: str | None = None,
    instructions: str | None = None,
    max_chars: int = 24000,
) -> str:
    """
    Summarize a transcript with an OpenRouter or Groq model. Returns markdown text.

    Truncates very long transcripts to keep latency/cost predictable. Routes to
    Groq if `model` is prefixed "groq/", or if OPENROUTER_API_KEY isn't set but
    GROQ_API_KEY is; otherwise uses OpenRouter.
    """
    openrouter_key = os.environ.get("OPENROUTER_API_KEY")
    use_groq = (model or "").startswith("groq/") or (
        not openrouter_key and groq_client.groq_available()
    )
    if not use_groq and not openrouter_key:
        raise SummarizeError("OPENROUTER_API_KEY is not set on the server.")

    text = (transcript or "").strip()
    if not text:
        raise SummarizeError("Transcript is empty — nothing to summarize.")
    if len(text) > max_chars:
        text = text[:max_chars] + "\n…[transcript truncated]"

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

    if use_groq:
        groq_model = model.removeprefix("groq/") if model else None
        try:
            return groq_client.chat_completion(
                system, user, model=groq_model, temperature=0.3
            )
        except groq_client.GroqError as e:
            raise SummarizeError(str(e))

    model = model or os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL)
    key = openrouter_key
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
