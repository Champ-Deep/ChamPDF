"""
ChampBeam tracked links.

The URL inside the invitation button is a ChampBeam link wrapping the real
signing URL, so the sender gets open / view tracking in the analytics layer
we already run and the admin staleness signal ("sent, not opened in five
days") comes for free.

Beam is instrumentation, not security. The 32-byte token in the wrapped URL
and the OTP carry the security; if Beam is down or unconfigured, the raw
signing URL is used and nothing about the trust chain changes.

Env
  CHAMPBEAM_API_URL     e.g. https://beam.champions.example/api/links
  CHAMPBEAM_API_TOKEN   bearer token

Request / response shape assumed (adjust here if Beam's API differs):
  POST {CHAMPBEAM_API_URL}  {"url": ..., "label": ..., "tags": [...]}
  -> {"id": "...", "short_url": "https://..."}   ("url" also accepted)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.error
import urllib.request
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


def beam_configured() -> bool:
    return bool(os.environ.get("CHAMPBEAM_API_URL", "").strip())


def _wrap_sync(url: str, label: str, tags: List[str]) -> Dict[str, Optional[str]]:
    api = os.environ.get("CHAMPBEAM_API_URL", "").strip()
    token = os.environ.get("CHAMPBEAM_API_TOKEN", "").strip()
    req = urllib.request.Request(
        api,
        data=json.dumps({"url": url, "label": label, "tags": tags}).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    with urllib.request.urlopen(req, timeout=8) as resp:  # nosec - operator-configured host
        data = json.loads(resp.read().decode("utf-8") or "{}")
    short = data.get("short_url") or data.get("url")
    if not short:
        raise ValueError(f"Beam response has no short_url: {data}")
    return {"id": str(data.get("id") or "") or None, "url": short}


async def wrap_link(url: str, *, label: str, tags: List[str]) -> Dict[str, Optional[str]]:
    """Return {"id", "url"}; falls back to the raw URL on any failure."""
    if not beam_configured():
        return {"id": None, "url": url}
    try:
        return await asyncio.to_thread(_wrap_sync, url, label, tags)
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as e:
        logger.warning("ChampBeam wrap failed (%s); using the raw signing URL", e)
        return {"id": None, "url": url}
