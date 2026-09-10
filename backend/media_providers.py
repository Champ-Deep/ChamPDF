"""
Media provider switch: which engine serves each image capability.

Measured on the live Coolify backend (2 GB, CPU only, 2026-09-10) with a
256x192 test image: background removal 4.7 s, LaMa inpaint 6 to 12 s, Real-ESRGAN
2x upscale 51 s, prompt editing 503 (no Gemini key). The local models work; the
CPU is the problem. This module lets each capability be pointed at a hosted
engine independently, per environment variable, with the local engine as the
fallback, and reports the resolved provider in /api/capabilities and in an
``X-ChamPDF-Provider`` response header so a test run shows what served it.

Capabilities and their providers
  edit_image          gemini (direct key) | openrouter | replicate
  inpaint             local (LaMa) | replicate | gemini | opencv (fallback)
  remove_background   local (rembg) | replicate
  upscale             local (Real-ESRGAN) | replicate

``replicate`` calls go through treg when TREG_TOKEN is set (the org's own
Replicate key, held by treg, injected server-side, audited, never metered by
treg) and directly with REPLICATE_API_TOKEN otherwise. ``openrouter`` likewise
goes through treg when OPENROUTER_VIA_TREG=true.

Env
  MEDIA_EDIT_PROVIDER       auto | gemini | openrouter | replicate | off
  MEDIA_INPAINT_PROVIDER    auto | local | replicate | gemini | opencv
  MEDIA_BG_PROVIDER         auto | local | replicate
  MEDIA_UPSCALE_PROVIDER    auto | local | replicate
  MEDIA_REPLICATE_EDIT_MODEL      default google/nano-banana
  MEDIA_REPLICATE_INPAINT_MODEL   default allenhooo/lama
  MEDIA_REPLICATE_BG_MODEL        default cjwbw/rembg
  MEDIA_REPLICATE_UPSCALE_MODEL   default nightmareai/real-esrgan
  OPENROUTER_IMAGE_MODEL          default google/gemini-2.5-flash-image
  OPENROUTER_VIA_TREG             true to route OpenRouter through treg's own-key proxy
  MEDIA_MAX_COST_USD              ceiling sent on treg-metered calls (default 0.25)
  MEDIA_HOSTED_TIMEOUT_S          per hosted job (default 300)

"auto" picks the first configured engine in the order listed above for the
capability, falling back to local, and never raises just because a key is
missing: the capability reports as unavailable instead.

Replicate model slugs are ``owner/name`` (the model's latest version) or
``owner/name:version``. They are configuration, not code, because Replicate
retires versions; pin them once a version has been tested.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DEFAULTS = {
    "MEDIA_REPLICATE_EDIT_MODEL": "google/nano-banana",
    "MEDIA_REPLICATE_INPAINT_MODEL": "allenhooo/lama",
    "MEDIA_REPLICATE_BG_MODEL": "cjwbw/rembg",
    "MEDIA_REPLICATE_UPSCALE_MODEL": "nightmareai/real-esrgan",
    "OPENROUTER_IMAGE_MODEL": "google/gemini-2.5-flash-image",
}
OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images"
REPLICATE_API = "https://api.replicate.com"


class MediaError(Exception):
    """code: not_configured | invalid_input | upstream"""

    def __init__(self, message: str, code: str = "upstream") -> None:
        super().__init__(message)
        self.code = code


@dataclass
class MediaResult:
    data: bytes
    provider: str
    model: Optional[str] = None
    cost_usd: Optional[float] = None
    call_id: Optional[str] = None
    elapsed_s: float = 0.0


# --------------------------------------------------------------------------
# Local engines are injected by main.py at startup (they are heavy objects).
# --------------------------------------------------------------------------

_local: Dict[str, Any] = {"lama": None, "upscaler": None, "image_processor": None}


def configure_local(*, lama: Any = None, upscaler: Any = None, image_processor: Any = None) -> None:
    _local.update(lama=lama, upscaler=upscaler, image_processor=image_processor)


def _env(name: str) -> str:
    return (os.environ.get(name) or DEFAULTS.get(name, "")).strip()


def _setting(name: str) -> str:
    return (os.environ.get(name) or "auto").strip().lower()


def _gemini_configured() -> bool:
    if not os.environ.get("GEMINI_API_KEY"):
        return False
    try:
        import google.genai  # noqa: F401

        return True
    except ImportError:
        return False


def _openrouter_configured() -> bool:
    return bool(os.environ.get("OPENROUTER_API_KEY")) or (_openrouter_via_treg() and _treg_configured())


def _openrouter_via_treg() -> bool:
    return os.environ.get("OPENROUTER_VIA_TREG", "").strip().lower() in ("1", "true", "yes")


def _treg_configured() -> bool:
    try:
        import treg_client

        return treg_client.treg_configured()
    except ImportError:
        return False


def _replicate_via_treg() -> bool:
    return _treg_configured() and os.environ.get("REPLICATE_VIA_TREG", "true").strip().lower() not in ("0", "false", "no")


def _replicate_configured() -> bool:
    return _replicate_via_treg() or bool(os.environ.get("REPLICATE_API_TOKEN"))


def _max_cost() -> float:
    try:
        return float(os.environ.get("MEDIA_MAX_COST_USD", "0.25"))
    except ValueError:
        return 0.25


def _timeout() -> float:
    try:
        return float(os.environ.get("MEDIA_HOSTED_TIMEOUT_S", "300"))
    except ValueError:
        return 300.0


# --------------------------------------------------------------------------
# Provider resolution
# --------------------------------------------------------------------------

_ORDER = {
    "edit_image": ["gemini", "openrouter", "replicate"],
    "inpaint": ["local", "replicate", "gemini", "opencv"],
    "remove_background": ["local", "replicate"],
    "upscale": ["local", "replicate"],
}
_ENV_FOR = {
    "edit_image": "MEDIA_EDIT_PROVIDER",
    "inpaint": "MEDIA_INPAINT_PROVIDER",
    "remove_background": "MEDIA_BG_PROVIDER",
    "upscale": "MEDIA_UPSCALE_PROVIDER",
}


def _available(capability: str, provider: str) -> bool:
    if provider == "gemini":
        return _gemini_configured()
    if provider == "openrouter":
        return capability == "edit_image" and _openrouter_configured()
    if provider == "replicate":
        return _replicate_configured()
    if provider == "opencv":
        return capability == "inpaint"
    if provider == "local":
        return {
            "inpaint": _local.get("lama") is not None,
            "remove_background": _local.get("image_processor") is not None,
            "upscale": _local.get("upscaler") is not None,
        }.get(capability, False)
    return False


def resolve(capability: str) -> Optional[str]:
    """The provider that will serve ``capability`` right now, or None."""
    wanted = _setting(_ENV_FOR[capability])
    if wanted == "off":
        return None
    if wanted != "auto":
        return wanted if _available(capability, wanted) else None
    for p in _ORDER[capability]:
        if _available(capability, p):
            return p
    return None


def describe() -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for cap in _ORDER:
        prov = resolve(cap)
        entry: Dict[str, Any] = {"provider": prov, "available": prov is not None, "setting": _setting(_ENV_FOR[cap])}
        if prov == "replicate":
            entry["model"] = _replicate_model(cap)
            entry["via"] = "treg" if _replicate_via_treg() else "direct"
        elif prov == "openrouter":
            entry["model"] = _env("OPENROUTER_IMAGE_MODEL")
            entry["via"] = "treg" if _openrouter_via_treg() else "direct"
        elif prov == "gemini":
            entry["model"] = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image-preview")
        out[cap] = entry
    out["treg_configured"] = _treg_configured()
    return out


def _replicate_model(capability: str) -> str:
    return _env({
        "edit_image": "MEDIA_REPLICATE_EDIT_MODEL",
        "inpaint": "MEDIA_REPLICATE_INPAINT_MODEL",
        "remove_background": "MEDIA_REPLICATE_BG_MODEL",
        "upscale": "MEDIA_REPLICATE_UPSCALE_MODEL",
    }[capability])


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _normalise_png(image_bytes: bytes, max_side: int = 2048) -> bytes:
    from PIL import Image

    try:
        img = Image.open(io.BytesIO(image_bytes))
        img.load()
    except Exception as e:  # noqa: BLE001
        raise MediaError(f"Could not read input image: {e}", "invalid_input") from e
    if max(img.size) > max_side:
        ratio = max_side / max(img.size)
        img = img.resize((int(img.size[0] * ratio), int(img.size[1] * ratio)), Image.LANCZOS)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _data_url(png: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64," + base64.b64encode(png).decode("ascii")


def _decode_data_url(url: str) -> bytes:
    if not url.startswith("data:"):
        raise MediaError("provider returned a non-inline image", "upstream")
    return base64.b64decode(url.split(",", 1)[1])


def _to_format(png: bytes, output_format: str) -> bytes:
    if (output_format or "png").lower() == "png":
        return png
    from PIL import Image

    img = Image.open(io.BytesIO(png))
    if img.mode == "RGBA":
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


def _fetch(url: str) -> bytes:
    import treg_client

    return treg_client.download(url)


# --------------------------------------------------------------------------
# Replicate (through treg or direct)
# --------------------------------------------------------------------------


def _replicate_direct_run(model: str, inputs: Dict[str, Any], timeout: float) -> Any:
    token = os.environ.get("REPLICATE_API_TOKEN", "")
    if ":" in model:
        slug, version = model.split(":", 1)
        url, body = f"{REPLICATE_API}/v1/predictions", {"version": version, "input": inputs}
    else:
        url, body = f"{REPLICATE_API}/v1/models/{model}/predictions", {"input": inputs}
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Prefer": "wait=60"}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:  # nosec - fixed host
            task = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise MediaError(f"Replicate rejected the job ({e.code}): {e.read()[:300].decode('utf-8', 'replace')}") from e
    started = time.time()
    while task.get("status") not in ("succeeded", "failed", "canceled"):
        if time.time() - started > timeout:
            raise MediaError(f"Replicate job {task.get('id')} timed out after {timeout:.0f}s")
        time.sleep(2)
        poll = urllib.request.Request(task["urls"]["get"], headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(poll, timeout=60) as resp:  # nosec
            task = json.loads(resp.read())
    if task.get("status") != "succeeded":
        raise MediaError(f"Replicate job {task.get('status')}: {str(task.get('error'))[:300]}")
    return task.get("output")


def _replicate(capability: str, inputs: Dict[str, Any], *, feature: str) -> MediaResult:
    model = _replicate_model(capability)
    started = time.time()
    cost = call_id = None
    if _replicate_via_treg():
        import treg_client

        try:
            res = treg_client.replicate_run(model, inputs, timeout=_timeout(), meta={"feature": feature},
                                            max_cost_usd=_max_cost())
        except treg_client.TregError as e:
            code = "not_configured" if e.treg_error and e.status in (401, 402, 403) else "upstream"
            raise MediaError(f"{model} via treg failed: {e}", code) from e
        output, cost, call_id = res.result, res.cost_usd, res.submit.call_id
    else:
        output = _replicate_direct_run(model, inputs, _timeout())
    import treg_client as _tc

    url = _tc.first_url(output)
    if not url:
        raise MediaError(f"{model} returned no image URL: {str(output)[:200]}")
    return MediaResult(_fetch(url), "replicate", model, cost, call_id, time.time() - started)


# --------------------------------------------------------------------------
# OpenRouter (prompt editing via the dedicated Image API)
# --------------------------------------------------------------------------


def _openrouter_edit(png: bytes, prompt: str) -> MediaResult:
    """POST /api/v1/images with the source as an input reference; the reply is base64 (``data[0].b64_json``)."""
    model = _env("OPENROUTER_IMAGE_MODEL")
    body = {
        "model": model,
        "prompt": prompt,
        "input_references": [{"type": "image_url", "image_url": {"url": _data_url(png)}}],
    }
    referer = os.environ.get("OPENROUTER_REFERER", "https://champdf.com")
    started = time.time()
    cost = call_id = None
    if _openrouter_via_treg():
        import treg_client

        try:
            resp = treg_client.call(OPENROUTER_IMAGES_URL, method="POST", body=body, meta={"feature": "edit-image"},
                                    timeout=_timeout(), headers={"HTTP-Referer": referer, "X-Title": "ChamPDF"})
        except treg_client.TregError as e:
            raise MediaError(f"OpenRouter via treg failed: {e}", "not_configured" if e.treg_error else "upstream") from e
        payload, cost, call_id = resp.json(), resp.cost_usd, resp.call_id
    else:
        req = urllib.request.Request(
            OPENROUTER_IMAGES_URL, data=json.dumps(body).encode(), method="POST",
            headers={"Authorization": f"Bearer {os.environ.get('OPENROUTER_API_KEY', '')}", "Content-Type": "application/json",
                     "HTTP-Referer": referer, "X-Title": "ChamPDF"},
        )
        try:
            with urllib.request.urlopen(req, timeout=_timeout()) as resp:  # nosec - fixed host
                payload = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raise MediaError(f"OpenRouter answered {e.code}: {e.read()[:300].decode('utf-8', 'replace')}") from e
        except urllib.error.URLError as e:
            raise MediaError(f"OpenRouter unreachable: {e.reason}") from e
    data = _extract_openrouter_image(payload)
    if not data:
        raise MediaError(f"OpenRouter returned no image for {model}: {str(payload)[:200]}")
    if cost is None:
        try:
            cost = float((payload.get("usage") or {}).get("cost"))
        except (TypeError, ValueError, AttributeError):
            cost = None
    return MediaResult(_normalise_png(data), "openrouter", model, cost, call_id, time.time() - started)


def _extract_openrouter_image(payload: Any) -> Optional[bytes]:
    """Image API: ``data[].b64_json``. Older chat-completions shape: an image_url on the assistant message."""
    if not isinstance(payload, dict):
        return None
    for item in payload.get("data") or []:
        if isinstance(item, dict) and item.get("b64_json"):
            return base64.b64decode(item["b64_json"])
        if isinstance(item, dict) and item.get("url"):
            return _fetch(item["url"])
    try:
        msg = payload["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return None
    candidates = list(msg.get("images") or [])
    if isinstance(msg.get("content"), list):
        candidates += [p for p in msg["content"] if isinstance(p, dict) and p.get("type") in ("image_url", "output_image")]
    for part in candidates:
        u = (part.get("image_url") or {}).get("url") or part.get("url") if isinstance(part, dict) else None
        if u:
            return _decode_data_url(u) if u.startswith("data:") else _fetch(u)
    return None


# --------------------------------------------------------------------------
# Public capability functions (async; hosted work runs in a worker thread)
# --------------------------------------------------------------------------


async def edit_image(image_bytes: bytes, prompt: str) -> MediaResult:
    import asyncio

    prompt = (prompt or "").strip()
    if not prompt:
        raise MediaError("A prompt is required for image editing.", "invalid_input")
    if len(prompt) > 2000:
        raise MediaError("Prompt is too long (max 2000 characters).", "invalid_input")
    provider = resolve("edit_image")
    if provider is None:
        raise MediaError(
            "AI image editing is not configured on this server (set GEMINI_API_KEY, OPENROUTER_API_KEY, "
            "or TREG_TOKEN with a Replicate connection).", "not_configured")
    png = _normalise_png(image_bytes)
    started = time.time()
    if provider == "gemini":
        from inpaint_processor import EditError, edit_image_with_prompt

        try:
            data = await edit_image_with_prompt(png, prompt)
        except EditError as e:
            raise MediaError(str(e), "not_configured" if "not configured" in str(e) else "upstream") from e
        return MediaResult(data, "gemini", os.environ.get("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image-preview"),
                           elapsed_s=time.time() - started)
    if provider == "openrouter":
        return await asyncio.to_thread(_openrouter_edit, png, prompt)
    if provider == "replicate":
        inputs = {"prompt": prompt, "image_input": [_data_url(png)], "output_format": "png"}
        return await asyncio.to_thread(_replicate, "edit_image", inputs, feature="edit-image")
    raise MediaError(f"unknown provider {provider}", "not_configured")


async def inpaint(image_bytes: bytes, mask_bytes: bytes, prompt: Optional[str] = None, radius: int = 5) -> MediaResult:
    """Mask-based removal. Never fails just because a hosted engine is down: falls back to OpenCV."""
    import asyncio

    provider = resolve("inpaint") or "opencv"
    started = time.time()
    try:
        if provider == "local":
            data = await _local["lama"].inpaint(image_bytes, mask_bytes)
            return MediaResult(data, "local", "lama", elapsed_s=time.time() - started)
        if provider == "replicate":
            png = _normalise_png(image_bytes)
            inputs = {"image": _data_url(png), "mask": _data_url(_normalise_png(mask_bytes))}
            return await asyncio.to_thread(_replicate, "inpaint", inputs, feature="inpaint")
        if provider == "gemini":
            from inpaint_processor import _inpaint_with_gemini

            data = await _inpaint_with_gemini(image_bytes, mask_bytes, prompt)
            return MediaResult(data, "gemini", elapsed_s=time.time() - started)
    except MediaError as e:
        if e.code == "invalid_input":
            raise
        logger.warning("[inpaint] %s failed (%s); falling back to OpenCV", provider, e)
    except Exception as e:  # noqa: BLE001
        logger.warning("[inpaint] %s failed (%s); falling back to OpenCV", provider, e)
    from inpaint_processor import _opencv_fallback

    data = await asyncio.to_thread(_opencv_fallback, image_bytes, mask_bytes, radius=radius)
    return MediaResult(data, "opencv", elapsed_s=time.time() - started)


async def remove_background(image_bytes: bytes, output_format: str = "png") -> MediaResult:
    import asyncio

    provider = resolve("remove_background")
    if provider is None:
        raise MediaError("Background removal is not available on this server.", "not_configured")
    started = time.time()
    if provider == "local":
        data = await _local["image_processor"].remove_background(image_bytes, output_format=output_format)
        return MediaResult(data, "local", "rembg", elapsed_s=time.time() - started)
    png = _normalise_png(image_bytes, max_side=4096)
    res = await asyncio.to_thread(_replicate, "remove_background", {"image": _data_url(png)}, feature="remove-background")
    res.data = _to_format(res.data, output_format)
    return res


async def upscale(image_bytes: bytes, scale: int = 2, output_format: str = "png") -> MediaResult:
    import asyncio

    provider = resolve("upscale")
    if provider is None:
        raise MediaError("Upscaling is not available on this server.", "not_configured")
    started = time.time()
    if provider == "local":
        data = await _local["upscaler"].upscale(image_bytes, scale=scale, output_format=output_format)
        return MediaResult(data, "local", "real-esrgan", elapsed_s=time.time() - started)
    png = _normalise_png(image_bytes, max_side=4096)
    res = await asyncio.to_thread(_replicate, "upscale", {"image": _data_url(png), "scale": scale, "face_enhance": False},
                                  feature="upscale")
    res.data = _to_format(res.data, output_format)
    return res
