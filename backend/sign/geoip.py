"""
Geographic enrichment for ChampPDF Sign admin visibility.

Every signer-facing request already records a raw IP address on the audit
event and on the recipient (signer_ip). This module turns that address into
place and network context at read time for the admin portal. It never blocks
a request: if no database is configured, or the IP is private, or the lookup
fails, resolve() returns an "unknown" record and the portal simply shows the
raw address.

Primary source is a MaxMind GeoIP2 database (.mmdb) referenced by
MAXMIND_DB_PATH (City .mmdb for place context, or an ASN .mmdb for the
network owner). A single file may carry both. When the file is absent we
report provider "none" rather than falling back to a third-party HTTP
lookup, because pushing every audit IP to an external service is a privacy
decision that should be explicit, not a silent default.

No em dashes in this file. Use periods and commas.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import threading
from functools import lru_cache
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

ENV_PATH = "MAXMIND_DB_PATH"

_lock = threading.Lock()
_reader: Any = None
_reader_path: Optional[str] = None


def _g(rec: Any, *keys: Any) -> Any:
    """Safely walk a MaxMind record that may be an object or a dict."""
    cur: Any = rec
    for k in keys:
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(k)
        elif isinstance(cur, (list, tuple)):
            try:
                cur = cur[int(k)]
            except (ValueError, IndexError, TypeError):
                return None
        else:
            try:
                cur = getattr(cur, k)
            except AttributeError:
                return None
    if isinstance(cur, bool):
        return cur
    if cur is None:
        return None
    return cur


def _open_reader() -> Any:
    global _reader, _reader_path
    path = (os.environ.get(ENV_PATH) or "").strip()
    if not path:
        return None
    if _reader is not None and _reader_path == path:
        return _reader
    try:
        import maxminddb  # type: ignore
    except Exception:  # noqa: BLE001
        logger.warning("MAXMIND_DB_PATH is set but the maxminddb package is not installed")
        return None
    with _lock:
        try:
            r = maxminddb.open_database(path)
        except Exception as e:  # noqa: BLE001
            logger.warning("Failed to open MaxMind database %s: %s", path, e)
            return None
        try:
            if _reader is not None:
                _reader.close()
        except Exception:  # noqa: BLE001
            pass
        _reader, _reader_path = r, path
        return r


def provider() -> str:
    return "maxmind" if _open_reader() is not None else "none"


def reset_for_tests() -> None:
    """Drop the cached reader so tests can point MAXMIND_DB_PATH elsewhere."""
    global _reader, _reader_path
    with _lock:
        if _reader is not None:
            try:
                _reader.close()
            except Exception:  # noqa: BLE001
                pass
        _reader, _reader_path = None, None


def _private(ip: Optional[str]) -> bool:
    if not ip:
        return False
    try:
        a = ipaddress.ip_address(ip.split("%")[0])
    except ValueError:
        return False
    return (
        a.is_private
        or a.is_loopback
        or a.is_link_local
        or a.is_multicast
        or a.is_reserved
        or a.is_unspecified
    )


def resolve(ip: Optional[str]) -> Dict[str, Any]:
    """
    Resolve an IP to a compact Geo record. Never raises.

    Returns a dict with provider ("maxmind" or "none"), is_private, and the
    available fields (country_code, country, region, city, postal, latitude,
    longitude, time_zone, asn, isp). Unknown fields are omitted.
    """
    if not ip:
        return {"provider": "none", "is_private": False, "ip": None}
    if _private(ip):
        return {"provider": "none", "is_private": True, "ip": ip}
    reader = _open_reader()
    if reader is None:
        return {"provider": "none", "is_private": False, "ip": ip}
    try:
        rec = reader.get(ip)
    except Exception as e:  # noqa: BLE001
        logger.debug("MaxMind lookup failed for %s: %s", ip, e)
        return {"provider": "none", "is_private": False, "ip": ip}
    if not rec:
        return {"provider": "maxmind", "is_private": False, "ip": ip}
    out: Dict[str, Any] = {"provider": "maxmind", "is_private": False, "ip": ip}
    cc = _g(rec, "country", "iso_code") or _g(rec, "registered_country", "iso_code") or _g(rec, "country", "iso_code")
    if cc:
        out["country_code"] = cc
    country = _g(rec, "country", "names", "en")
    if country:
        out["country"] = country
    region = _g(rec, "subdivisions", 0, "names", "en")
    if region:
        out["region"] = region
    city = _g(rec, "city", "names", "en")
    if city:
        out["city"] = city
    postal = _g(rec, "postal", "code")
    if postal:
        out["postal"] = postal
    loc = _g(rec, "location")
    if isinstance(loc, dict):
        if loc.get("latitude") is not None:
            out["latitude"] = loc["latitude"]
        if loc.get("longitude") is not None:
            out["longitude"] = loc["longitude"]
        if loc.get("time_zone"):
            out["time_zone"] = loc["time_zone"]
    asn = _g(rec, "autonomous_system_number")
    if asn is not None:
        out["asn"] = asn
    isp = _g(rec, "autonomous_system_organization")
    if isp:
        out["isp"] = isp
    return out
