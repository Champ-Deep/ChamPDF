"""
treg gateway client (https://treg.to).

treg is "OpenRouter for tools": one base URL, one token, and either a
catalogue endpoint served on treg's own key (metered per call from the team's
prepaid balance) or one of the team's own registered keys injected
server-side (never metered, always audited). ChamPDF uses it two ways:

  Catalogue id     POST https://treg.to/call/replicate.image-gen.flux-schnell
                   priced by treg, e.g. text-to-image at $0.003 to $0.012.
  Upstream URL     POST https://treg.to/call/https://api.replicate.com/v1/models/<m>/predictions
                   the org's own Replicate (or OpenRouter) key, held by treg,
                   injected on the way through. No key on this box.

Everything here is stdlib HTTP so the backend gains no dependency. Blocking
calls run in a worker thread through the ``a*`` wrappers.

Env
  TREG_TOKEN        per-org token (bare) or an identity token
  TREG_ORG          team slug, required with an identity token (X-Treg-Org)
  TREG_BASE_URL     default https://treg.to
  TREG_META_APP     value for the ``app`` tag on every call (default champdf)

Money facts this module enforces or exposes:
  - ``X-Treg-Cost-Micro`` (integer micro-USD) is what a call actually cost;
    absent means it ran on the team's own key. Surfaced as ``cost_usd``.
  - ``X-Treg-Call-Id`` joins our logs to treg's ledger. Always logged.
  - ``X-Treg-Route-Max-Cost`` is the only hard ceiling on a direct call; the
    client sends it whenever a max is given (402 ``route_max_cost`` = refused,
    nothing charged).
  - ``X-Treg-Error: 1`` marks treg's own refusal; anything else is the
    provider's verbatim answer.
  - Async generation tasks reserve at submission and settle on success; a
    failed task refunds the hold.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

DEFAULT_BASE = "https://treg.to"
_META_VALUE_RE = re.compile(r"[^A-Za-z0-9._:\-]")


class TregError(Exception):
    """A failed call. ``treg_error`` is True when treg itself refused (not the provider)."""

    def __init__(self, message: str, *, status: Optional[int] = None, call_id: Optional[str] = None,
                 treg_error: bool = False, body: Optional[bytes] = None) -> None:
        super().__init__(message)
        self.status = status
        self.call_id = call_id
        self.treg_error = treg_error
        self.body = body

    def detail(self) -> Any:
        try:
            return json.loads((self.body or b"").decode("utf-8"))
        except ValueError:
            return (self.body or b"")[:300].decode("utf-8", "replace")


def base_url() -> str:
    return (os.environ.get("TREG_BASE_URL") or DEFAULT_BASE).rstrip("/")


def treg_configured() -> bool:
    return bool(os.environ.get("TREG_TOKEN", "").strip())


def _meta_header(meta: Optional[Dict[str, str]]) -> Optional[str]:
    """Up to 5 key=value tags; values restricted to what treg's ledger accepts."""
    tags = {"app": os.environ.get("TREG_META_APP", "champdf")}
    tags.update({k: str(v) for k, v in (meta or {}).items() if v is not None})
    parts = []
    for k, v in list(tags.items())[:5]:
        clean = _META_VALUE_RE.sub("_", v)[:128]
        if clean and "@" not in clean:
            parts.append(f"{k}={clean}")
    return ", ".join(parts) if parts else None


def _headers(extra: Optional[Dict[str, str]] = None, meta: Optional[Dict[str, str]] = None,
             max_cost_usd: Optional[float] = None, idempotency_key: Optional[str] = None) -> Dict[str, str]:
    token = os.environ.get("TREG_TOKEN", "").strip()
    if not token:
        raise TregError("TREG_TOKEN is not set", treg_error=True)
    h: Dict[str, str] = {"X-Treg-Token": token, "Accept": "application/json"}
    org = os.environ.get("TREG_ORG", "").strip()
    if org:
        h["X-Treg-Org"] = org
    m = _meta_header(meta)
    if m:
        h["X-Treg-Meta"] = m
    if max_cost_usd is not None:
        h["X-Treg-Route-Max-Cost"] = f"{max_cost_usd:.4f}"
    if idempotency_key:
        h["Idempotency-Key"] = idempotency_key
    if extra:
        h.update(extra)
    return h


@dataclass
class TregResponse:
    status: int
    headers: Dict[str, str]  # lower-cased names
    body: bytes
    url: str

    @property
    def call_id(self) -> Optional[str]:
        return self.headers.get("x-treg-call-id")

    @property
    def cost_micro(self) -> Optional[int]:
        v = self.headers.get("x-treg-cost-micro")
        try:
            return int(v) if v is not None else None
        except ValueError:
            return None

    @property
    def cost_usd(self) -> Optional[float]:
        m = self.cost_micro
        return m / 1_000_000 if m is not None else None

    @property
    def treg_error(self) -> bool:
        return self.headers.get("x-treg-error") == "1"

    @property
    def served_via(self) -> Optional[str]:
        return self.headers.get("x-treg-served-via") or self.headers.get("x-treg-served-by")

    @property
    def async_descriptor(self) -> Optional[Dict[str, Any]]:
        raw = self.headers.get("x-treg-async")
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            return None

    def json(self) -> Any:
        if not self.body:
            return None
        return json.loads(self.body.decode("utf-8"))


def _target_url(target: str, params: Optional[Dict[str, Any]] = None) -> str:
    url = f"{base_url()}/call/{target}"
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    return url


def call(
    target: str,
    *,
    method: str = "GET",
    params: Optional[Dict[str, Any]] = None,
    body: Optional[Any] = None,
    raw: Optional[bytes] = None,
    content_type: str = "application/json",
    meta: Optional[Dict[str, str]] = None,
    max_cost_usd: Optional[float] = None,
    idempotency_key: Optional[str] = None,
    timeout: float = 90.0,
    headers: Optional[Dict[str, str]] = None,
    retry_saturated: bool = True,
) -> TregResponse:
    """
    One /call/ request. ``target`` is a catalogue id or an absolute upstream URL.
    Raises TregError on any non-2xx (``treg_error`` tells you whose answer it is).
    """
    url = _target_url(target, params)
    data = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
    h = _headers(headers, meta, max_cost_usd, idempotency_key)
    if data is not None:
        h["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, method=method.upper(), headers=h)
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec - fixed gateway host
            out = TregResponse(resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read(), url)
    except urllib.error.HTTPError as e:
        hdrs = {k.lower(): v for k, v in e.headers.items()}
        payload = e.read()
        if e.code == 503 and retry_saturated and b"treg_saturated" in payload:
            wait = min(int(hdrs.get("retry-after") or "5"), 30)
            logger.warning("treg saturated; retrying %s in %ss", target, wait)
            time.sleep(wait)
            return call(target, method=method, params=params, body=body, raw=raw, content_type=content_type, meta=meta,
                        max_cost_usd=max_cost_usd, idempotency_key=idempotency_key, timeout=timeout, headers=headers,
                        retry_saturated=False)
        err = TregError(
            f"{'treg' if hdrs.get('x-treg-error') == '1' else 'provider'} answered {e.code} for {target}: "
            f"{payload[:300].decode('utf-8', 'replace')}",
            status=e.code, call_id=hdrs.get("x-treg-call-id"), treg_error=hdrs.get("x-treg-error") == "1", body=payload,
        )
        logger.warning("treg call failed: %s (call id %s)", err, err.call_id)
        raise err
    except urllib.error.URLError as e:
        raise TregError(f"treg unreachable: {e.reason}") from e
    logger.info("treg %s %s -> %s in %.1fs cost=%s call_id=%s", method.upper(), target[:80], out.status,
                time.time() - started, out.cost_usd, out.call_id)
    return out


# --------------------------------------------------------------------------
# Catalogue and account helpers
# --------------------------------------------------------------------------


def _get_json(path: str, timeout: float = 60.0) -> Any:
    req = urllib.request.Request(f"{base_url()}{path}", headers=_headers() if treg_configured() else {"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec - fixed gateway host
        return json.loads(resp.read().decode("utf-8"))


def catalog_search(query: str, limit: int = 10) -> Dict[str, Any]:
    return _get_json(f"/catalog/search?{urllib.parse.urlencode({'q': query, 'limit': limit})}")


def catalog_get(endpoint_id: str) -> Dict[str, Any]:
    return _get_json(f"/catalog/endpoints/{urllib.parse.quote(endpoint_id)}")


def catalog_access(endpoint_id: str) -> Dict[str, Any]:
    return _get_json(f"/catalog/endpoints/{urllib.parse.quote(endpoint_id)}/access")


def orgs() -> Any:
    return _get_json("/orgs")


def balance() -> Dict[str, Any]:
    """Team balance. Resolves the org id from /orgs (identity tokens carry the slug, not the id)."""
    org_id = os.environ.get("TREG_ORG_ID", "").strip()
    if not org_id:
        slug = os.environ.get("TREG_ORG", "").strip()
        listing = orgs()
        for o in listing if isinstance(listing, list) else []:
            if not slug or o.get("slug") == slug:
                org_id = str(o.get("org_id"))
                break
    if not org_id:
        raise TregError("could not resolve the treg org id (set TREG_ORG_ID)", treg_error=True)
    return _get_json(f"/orgs/{org_id}/balance")


def own_tools() -> Any:
    return _get_json("/tools")


# --------------------------------------------------------------------------
# Async generation tasks
# --------------------------------------------------------------------------


def _dig(obj: Any, path: str) -> Any:
    cur = obj
    for part in (path or "").split("."):
        if not part:
            continue
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.isdigit():
            cur = cur[int(part)] if int(part) < len(cur) else None
        else:
            return None
    return cur


@dataclass
class TaskResult:
    result: Any
    task_id: str
    submit: TregResponse
    final: Dict[str, Any]
    polls: int = 0
    cost_usd: Optional[float] = None
    elapsed_s: float = 0.0
    call_ids: list = field(default_factory=list)


def run_task(
    target: str,
    body: Any,
    *,
    descriptor: Optional[Dict[str, Any]] = None,
    poll_target: Optional[str] = None,
    poll_param: str = "id",
    id_from: str = "id",
    status_path: str = "status",
    success: Sequence[str] = ("succeeded",),
    failure: Sequence[str] = ("failed", "canceled"),
    result_path: str = "output",
    interval: float = 2.0,
    timeout: float = 600.0,
    meta: Optional[Dict[str, str]] = None,
    max_cost_usd: Optional[float] = None,
    idempotency_key: Optional[str] = None,
) -> TaskResult:
    """
    Submit an async generation call and poll it to completion.

    Polling follows, in order of preference: an explicit ``poll_target`` catalogue
    id (with the task id as ``poll_param``), the catalogue descriptor's
    ``poll.endpoint`` / ``poll.url_from``, or the ``X-Treg-Async`` header.
    """
    submit = call(target, method="POST", body=body, meta=meta, max_cost_usd=max_cost_usd,
                  idempotency_key=idempotency_key, timeout=120)
    task = submit.json() or {}
    desc = descriptor or submit.async_descriptor or {}
    id_key = desc.get("id_from", id_from)
    task_id = str(_dig(task, id_key) or "")
    if not task_id:
        raise TregError(f"submission to {target} returned no task id: {str(task)[:200]}", call_id=submit.call_id)
    status_path = desc.get("status", {}).get("path", status_path)
    success = tuple(desc.get("status", {}).get("success", success))
    failure = tuple(desc.get("status", {}).get("failure", failure))
    result_path = desc.get("result", {}).get("path", result_path)
    interval = float(desc.get("interval", interval))
    poll = desc.get("poll", {})

    def poll_once() -> TregResponse:
        if poll_target:
            return call(poll_target, params={poll_param: task_id}, meta=meta, timeout=60)
        if poll.get("endpoint"):
            pname = (poll.get("param") or {}).get("name", "id")
            return call(poll["endpoint"], params={pname: task_id}, meta=meta, timeout=60)
        if poll.get("url_from"):
            url = _dig(task, poll["url_from"])
            if not url:
                raise TregError(f"task has no poll URL at {poll['url_from']}")
            return call(url, meta=meta, timeout=60)
        raise TregError(f"no polling route known for {target}; pass poll_target", treg_error=True)

    # The submission may already be terminal (synchronous providers).
    final = task
    polls = 0
    call_ids = [submit.call_id] if submit.call_id else []
    started = time.time()
    state = _dig(final, status_path)
    while state not in success and state not in failure:
        if time.time() - started > timeout:
            raise TregError(f"task {task_id} on {target} still '{state}' after {timeout:.0f}s", call_id=submit.call_id)
        time.sleep(interval if polls else max(interval, 2.0))
        resp = poll_once()
        polls += 1
        if resp.call_id:
            call_ids.append(resp.call_id)
        final = resp.json() or {}
        state = _dig(final, status_path)
    if state in failure:
        raise TregError(f"task {task_id} on {target} {state}: {str(final.get('error') or final)[:300]}", call_id=submit.call_id)
    return TaskResult(result=_dig(final, result_path), task_id=task_id, submit=submit, final=final, polls=polls,
                      cost_usd=submit.cost_usd, elapsed_s=time.time() - started, call_ids=call_ids)


def download(url: str, timeout: float = 180.0, max_bytes: int = 200 * 1024 * 1024) -> bytes:
    """Fetch a result URL directly (generated media is served by the provider's CDN, not treg)."""
    req = urllib.request.Request(url, headers={"User-Agent": "ChamPDF/treg-client"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec - provider result URL
        data = resp.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise TregError("result is larger than the configured limit")
    return data


def first_url(output: Any) -> Optional[str]:
    """First http(s) URL in a provider output (string, list, or dict of them)."""
    if isinstance(output, str):
        return output if output.startswith("http") else None
    if isinstance(output, dict):
        for v in output.values():
            u = first_url(v)
            if u:
                return u
        return None
    if isinstance(output, (list, tuple)):
        for v in output:
            u = first_url(v)
            if u:
                return u
    return None


# --------------------------------------------------------------------------
# Replicate through treg (the org's own key, injected server-side)
# --------------------------------------------------------------------------

REPLICATE_API = "https://api.replicate.com"


def replicate_run(model: str, inputs: Dict[str, Any], *, timeout: float = 600.0, meta: Optional[Dict[str, str]] = None,
                  max_cost_usd: Optional[float] = None) -> TaskResult:
    """
    Run any Replicate model through treg. ``model`` is ``owner/name`` (official
    model endpoint) or ``owner/name:version`` (explicit version). Requires a
    Replicate credential registered in the treg org (``treg connections
    connect --provider replicate``); the call is then unmetered by treg and
    billed by Replicate on your account.
    """
    if ":" in model:
        slug, version = model.split(":", 1)
        target = f"{REPLICATE_API}/v1/predictions"
        body: Dict[str, Any] = {"version": version, "input": inputs}
    else:
        target = f"{REPLICATE_API}/v1/models/{model}/predictions"
        body = {"input": inputs}
    descriptor = {"id_from": "id", "poll": {"url_from": "urls.get"},
                  "status": {"path": "status", "success": ["succeeded"], "failure": ["failed", "canceled"]},
                  "result": {"path": "output"}, "interval": 2}
    return run_task(target, body, descriptor=descriptor, timeout=timeout, meta={**(meta or {}), "model": model.split(":")[0]},
                    max_cost_usd=max_cost_usd, poll_target=None)


# --------------------------------------------------------------------------
# asyncio wrappers
# --------------------------------------------------------------------------


async def acall(*args: Any, **kwargs: Any) -> TregResponse:
    return await asyncio.to_thread(call, *args, **kwargs)


async def arun_task(*args: Any, **kwargs: Any) -> TaskResult:
    return await asyncio.to_thread(run_task, *args, **kwargs)


async def areplicate_run(*args: Any, **kwargs: Any) -> TaskResult:
    return await asyncio.to_thread(replicate_run, *args, **kwargs)


async def adownload(url: str, **kwargs: Any) -> bytes:
    return await asyncio.to_thread(download, url, **kwargs)


def describe() -> Dict[str, Any]:
    """For /api/capabilities: configured, org, and (cheaply) nothing else."""
    return {"configured": treg_configured(), "org": os.environ.get("TREG_ORG") or None, "base_url": base_url()}
