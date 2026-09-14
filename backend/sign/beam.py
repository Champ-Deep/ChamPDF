"""
ChampBeam tracked links.

The URL inside the invitation button is a ChampBeam link wrapping the real
signing URL, so every send-out becomes a tracked link in the ChampBeam
analytics layer: open / click / geo per recipient, and the admin staleness
signal ("sent, not opened in five days") comes from the same place.

Beam is instrumentation, not security. The 32-byte token in the wrapped URL
and the OTP carry the security; if Beam is down or unconfigured, the raw
signing URL is used and nothing about the trust chain changes.

Real contract (ChampBeam / ChampUTM backend, app/api/v1/utm.py):

  POST {CHAMPBEAM_API_URL}/api/v1/utm/generate
  X-API-Key: cb_live_...               (integration key; creates a tracked link)
  {
    "base_url":      <long signing URL>,
    "utm_source":    "champdf-sign",
    "utm_medium":    "email",
    "utm_campaign":  <document title>,   # the send-out
    "utm_content":   "<role> <recipient email>",
    "utm_term":      <template id>,
    "project_name":  "champdf-sign"
  }
  -> {
       "link_id": "uuid", "short_code": "abc123",
       "short_url": "https://share.lakeb2b.com/s/abc123",
       "redirect_url": "...", "tracked_url": "..."
     }

The generate endpoint only records a tracked link for authenticated callers,
so this client always sends the X-API-Key header. A legacy Bearer
(CHAMPBEAM_API_TOKEN) is also accepted for deployments still using it.

Env
  CHAMPBEAM_API_URL     base URL, e.g. https://share.lakeb2b.com
  CHAMPBEAM_API_KEY     cb_live_... integration key (X-API-Key)
  CHAMPBEAM_API_TOKEN   legacy alternative: Bearer token
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def beam_configured() -> bool:
    return bool(os.environ.get("CHAMPBEAM_API_URL", "").strip())


def _api_key() -> Optional[str]:
    key = os.environ.get("CHAMPBEAM_API_KEY", "").strip()
    if key:
        return key
    return os.environ.get("CHAMPBEAM_API_TOKEN", "").strip() or None


def _wrap_sync(base_url: str, payload: Dict[str, Any]) -> Dict[str, Optional[str]]:
    api = os.environ.get("CHAMPBEAM_API_URL", "").strip().rstrip("/")
    endpoint = f"{api}/api/v1/utm/generate"
    key = _api_key()
    headers = {"Content-Type": "application/json"}
    if key:
        # Integration keys go in X-API-Key; a legacy token as Bearer.
        if os.environ.get("CHAMPBEAM_API_KEY", "").strip():
            headers["X-API-Key"] = key
        else:
            headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=8) as resp:  # nosec - operator-configured host
        data = json.loads(resp.read().decode("utf-8") or "{}")
    # Prefer the pretty /s/ short URL, then the redirect URL, then the
    # UTM-tagged original. All three are safe to hand a signer.
    url = (
        data.get("short_url")
        or data.get("redirect_url")
        or data.get("tracked_url")
    )
    if not url:
        raise ValueError(f"Beam response has no usable url: {data}")
    return {
        "id": str(data.get("link_id") or data.get("short_code") or "") or None,
        "url": str(url),
    }


def _payload(url: str, title: str, recipient_email: str, role: str, template_id: str,
             document_id: str) -> Dict[str, Any]:
    """The send-out, expressed as a ChampBeam tracked-link create payload."""
    def cut(v: Optional[str], n: int) -> Optional[str]:
        if not v:
            return None
        v = str(v).strip()
        return v[:n] if len(v) > n else v

    payload: Dict[str, Any] = {
        "base_url": url,
        "utm_source": "champdf-sign",
        "utm_medium": "email",
        "utm_campaign": cut(title, 120) or "Document",
        "utm_content": cut(f"{role} {recipient_email}", 200),
        "utm_term": cut(template_id, 60),
        "project_name": "champdf-sign",
    }
    # A stable tag is useful for auditing a send-out in Beam without needing
    # the link id: not a slug, just a query note on the destination.
    return payload


async def wrap_link(
    url: str,
    *,
    title: str,
    recipient_email: str,
    role: str,
    template_id: str,
    document_id: str,
) -> Dict[str, Optional[str]]:
    """Return {"id", "url"}; falls back to the raw URL on any failure."""
    if not beam_configured():
        return {"id": None, "url": url}
    payload = _payload(url, title, recipient_email, role, template_id, document_id)
    try:
        return await asyncio.to_thread(_wrap_sync, url, payload)
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as e:
        logger.warning("ChampBeam wrap failed (%s); using the raw signing URL", e)
        return {"id": None, "url": url}