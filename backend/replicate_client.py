"""
Generic Replicate offload client.

Railway has no GPU, so several "Best/GPU" features offload heavy work to hosted
Replicate models while Railway stays the orchestrator. This module is the shared
plumbing — provider availability, running a model in a worker thread with a
timeout, selecting the right element from the model's varied return shapes, and
downloading bytes. Feature modules (video watermark removal, video matting, GPU
transcription) build on top of `run_model` / `run_model_raw`.

Everything is env-gated (`VIDEO_GPU_PROVIDER=replicate` + either `REPLICATE_API_TOKEN`
or a treg token with the org's Replicate key registered in treg) so a missing key
reports unavailable via /api/capabilities rather than erroring.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


class ReplicateError(Exception):
    """Raised when the Replicate offload is unavailable or a remote job fails."""


def provider() -> str:
    return (os.environ.get("VIDEO_GPU_PROVIDER", "none") or "none").strip().lower()


def via_treg() -> bool:
    """Route SDK calls through treg (https://treg.to), which holds the org's
    Replicate key and injects it server-side. On by default whenever
    TREG_TOKEN is set; REPLICATE_VIA_TREG=false forces the direct path."""
    if not os.environ.get("TREG_TOKEN", "").strip():
        return False
    return os.environ.get("REPLICATE_VIA_TREG", "true").strip().lower() not in ("0", "false", "no")


def replicate_available() -> bool:
    """True iff Replicate is selected, credentialed (directly or via treg), and the SDK is installed."""
    if provider() != "replicate":
        return False
    if not os.environ.get("REPLICATE_API_TOKEN") and not via_treg():
        return False
    try:
        import replicate  # noqa: F401

        return True
    except ImportError:
        return False


def _client():
    """A Replicate client, pointed at treg's URL-prefix proxy when routing via treg."""
    import replicate

    if not via_treg():
        return replicate.Client()
    base = (os.environ.get("TREG_BASE_URL") or "https://treg.to").rstrip("/")
    headers = {"X-Treg-Token": os.environ["TREG_TOKEN"].strip(), "X-Treg-Meta": "app=champdf, feature=video"}
    org = os.environ.get("TREG_ORG", "").strip()
    if org:
        headers["X-Treg-Org"] = org
    # treg replaces the Authorization header with the org's real key; the SDK
    # insists on some token, so hand it a placeholder.
    return replicate.Client(api_token="treg-managed", base_url=f"{base}/call/https://api.replicate.com", headers=headers)


def output_ref(o: Any) -> str:
    """Best-effort lowercased URL/string for an output element."""
    return (getattr(o, "url", None) or (o if isinstance(o, str) else str(o)) or "").lower()


def first_output(output: Any) -> Any:
    """Default selector: first element of a list, first value of a dict, or scalar."""
    if isinstance(output, dict):
        vals = [v for v in output.values() if v]
        return vals[0] if vals else None
    if isinstance(output, (list, tuple)):
        return output[0] if output else None
    return output


def read_bytes(output: Any, *, download_timeout: int = 180) -> bytes:
    """Coerce a single Replicate output (FileOutput | URL | str) into raw bytes."""
    read = getattr(output, "read", None)
    if callable(read):
        data = read()
        if data:
            return data
    url = getattr(output, "url", None) or (output if isinstance(output, str) else None)
    if not url:
        url = str(output)
    if not isinstance(url, str) or not url.startswith("http"):
        raise ReplicateError("Replicate returned an unrecognized result")

    import urllib.request

    with urllib.request.urlopen(url, timeout=download_timeout) as resp:  # noqa: S310
        return resp.read()


def _default_timeout() -> int:
    return int(os.environ.get("GPU_VIDEO_TIMEOUT", "840"))


def _run_sync(model: str, inputs: dict) -> Any:
    return _client().run(model, input=inputs)


async def run_model_raw(model: str, inputs: dict, *, timeout: Optional[int] = None) -> Any:
    """Run a model and return its RAW output object (for JSON-returning models)."""
    if not replicate_available():
        raise ReplicateError(
            "Replicate offload needs VIDEO_GPU_PROVIDER=replicate + REPLICATE_API_TOKEN."
        )
    timeout = timeout or _default_timeout()
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_run_sync, model, inputs), timeout=timeout
        )
    except asyncio.TimeoutError:
        raise ReplicateError(f"Replicate job timed out after {timeout}s.")
    except ReplicateError:
        raise
    except Exception as e:  # noqa: BLE001
        raise ReplicateError(f"Replicate job failed: {e}")


async def run_model(
    model: str,
    inputs: dict,
    *,
    output_selector: Callable[[Any], Any] = first_output,
    timeout: Optional[int] = None,
) -> bytes:
    """Run a Replicate model and return the selected output's bytes.

    `inputs` may contain open binary file handles; the caller is responsible for
    keeping them open across the await and closing them afterwards. Blocking SDK
    work runs in a worker thread under an asyncio timeout.
    """
    output = await run_model_raw(model, inputs, timeout=timeout)
    chosen = output_selector(output)
    if chosen is None:
        raise ReplicateError("Replicate returned no usable output")
    data = read_bytes(chosen)
    if not data:
        raise ReplicateError("Replicate returned no data")
    return data
