"""
ChamPDF Public API (v1).

A versioned API surface separate from the un-versioned `/api/*` paths the
ChamPDF frontend uses. v1 endpoints require an API key; the frontend's
endpoints continue to work cookie-/origin-bound.

Phase 1 scope:
- API-key auth (Bearer token)
- SQLite-backed key store with monthly quotas
- Per-key sliding-window rate limit (in-memory)
- Admin endpoint to issue / revoke keys (gated by CHAMPDF_ADMIN_TOKEN env var)
- 4 endpoints exposed:
    POST /api/v1/image/remove-bg
    POST /api/v1/image/edit          (Gemini "Edit Banana", prompt-based)
    POST /api/v1/image/inpaint       (Gemini, mask-based)
    POST /api/v1/video/download

Phase 2 will add the MCP server (separate npm package) that talks to v1.
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
import secrets
import sqlite3
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque, Dict, Optional

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

API_KEY_PREFIX = "champdf_live_"
KEY_RANDOM_BYTES = 24  # -> 32 hex chars after .hex()
ADMIN_TOKEN_ENV = "CHAMPDF_ADMIN_TOKEN"
DB_PATH_ENV = "CHAMPDF_DB_PATH"

# Per-key burst limit: requests allowed per minute (in-memory sliding window).
# Monthly quota is enforced via DB. Burst stops abuse spikes; quota stops
# overall over-use.
DEFAULT_BURST_PER_MINUTE = 30
DEFAULT_MONTHLY_QUOTA = 1000


def _db_path() -> Path:
    """SQLite path (Railway volume by default; overridable for tests)."""
    raw = os.environ.get(DB_PATH_ENV) or "/app/data/champdf.db"
    p = Path(raw)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


# --------------------------------------------------------------------------
# Storage
# --------------------------------------------------------------------------


def init_db() -> None:
    """Create the keys table on startup if missing."""
    with sqlite3.connect(_db_path()) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS api_keys (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                key_hash      TEXT NOT NULL UNIQUE,
                label         TEXT NOT NULL,
                monthly_quota INTEGER NOT NULL DEFAULT 1000,
                month_bucket  TEXT NOT NULL,
                requests_used INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL,
                last_used_at  TEXT,
                disabled_at   TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS request_log (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                key_id      INTEGER NOT NULL,
                ts          TEXT NOT NULL,
                endpoint    TEXT NOT NULL,
                status      INTEGER NOT NULL,
                latency_ms  INTEGER,
                FOREIGN KEY (key_id) REFERENCES api_keys(id)
            )
            """
        )
        # Migration: bind keys to a Clerk user for self-serve issuance. Guarded
        # so existing databases upgrade in place without a separate migration.
        cols = {row[1] for row in conn.execute("PRAGMA table_info(api_keys)")}
        if "clerk_user_id" not in cols:
            conn.execute("ALTER TABLE api_keys ADD COLUMN clerk_user_id TEXT")
        # Migration: RBAC scopes. Existing keys default to '*' (full access)
        # so upgrades don't break anything already issued.
        if "scopes" not in cols:
            conn.execute("ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '*'")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_api_keys_clerk_user "
            "ON api_keys(clerk_user_id)"
        )
        conn.commit()


def _hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _current_month_bucket() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


# --------------------------------------------------------------------------
# RBAC scopes
#
# A key's `scopes` field is a comma-separated list. '*' (the default) grants
# everything. A scope grants itself plus any dotted children: 'pdf' covers
# 'pdf.sign', 'pdf.read', 'pdf.write'. Taxonomy:
#
#   pdf.read   info / to-text / to-images / extract-tables / verify-signature
#   pdf.write  merge / split / delete-pages / rotate / compress / watermark /
#              from-images / ocr / remove-watermark
#   pdf.sign   sign (compliance signatures)
#   convert    Office <-> PDF conversion
#   image      remove-bg / edit / inpaint / detect-watermarks
#   video      download / remove-logo
# --------------------------------------------------------------------------

KNOWN_SCOPES = {"*", "pdf", "pdf.read", "pdf.write", "pdf.sign", "convert", "image", "video"}


def normalize_scopes(scopes: Optional[list]) -> str:
    """Validate and canonicalize a scope list into the stored string form."""
    if not scopes:
        return "*"
    cleaned = []
    for s in scopes:
        s = str(s).strip().lower()
        if s not in KNOWN_SCOPES:
            raise ValueError(
                f"Unknown scope '{s}'. Valid: {', '.join(sorted(KNOWN_SCOPES))}"
            )
        if s not in cleaned:
            cleaned.append(s)
    return "*" if "*" in cleaned else ",".join(cleaned)


def key_scopes(key: Dict[str, Any]) -> list:
    raw = (key.get("scopes") or "*").strip()
    return [s for s in raw.split(",") if s]


def key_has_scope(key: Dict[str, Any], required: str) -> bool:
    for s in key_scopes(key):
        if s == "*" or s == required or required.startswith(s + "."):
            return True
    return False


def create_key(
    label: str,
    monthly_quota: int = DEFAULT_MONTHLY_QUOTA,
    clerk_user_id: Optional[str] = None,
    scopes: Optional[list] = None,
) -> Dict[str, Any]:
    """Issue a new API key. Returns the raw key (only shown once) + metadata.

    clerk_user_id binds the key to a signed-in Clerk user (self-serve flow);
    None for admin-issued keys. scopes=None grants full access ('*').
    """
    scopes_str = normalize_scopes(scopes)
    raw = API_KEY_PREFIX + secrets.token_hex(KEY_RANDOM_BYTES)
    hashed = _hash_key(raw)
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(_db_path()) as conn:
        cur = conn.execute(
            """
            INSERT INTO api_keys
                (key_hash, label, monthly_quota, month_bucket, requests_used,
                 created_at, clerk_user_id, scopes)
            VALUES (?, ?, ?, ?, 0, ?, ?, ?)
            """,
            (hashed, label, monthly_quota, _current_month_bucket(), now,
             clerk_user_id, scopes_str),
        )
        conn.commit()
        key_id = cur.lastrowid
    return {
        "id": key_id,
        "key": raw,
        "label": label,
        "monthly_quota": monthly_quota,
        "scopes": scopes_str.split(","),
        "created_at": now,
    }


def get_active_key_for_clerk_user(clerk_user_id: str) -> Optional[Dict[str, Any]]:
    """Return the user's current (non-revoked) key record, or None."""
    with sqlite3.connect(_db_path()) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            """
            SELECT * FROM api_keys
            WHERE clerk_user_id = ? AND disabled_at IS NULL
            ORDER BY id DESC LIMIT 1
            """,
            (clerk_user_id,),
        ).fetchone()
        return dict(row) if row else None


def get_key_by_hash(hashed: str) -> Optional[Dict[str, Any]]:
    with sqlite3.connect(_db_path()) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM api_keys WHERE key_hash = ? LIMIT 1",
            (hashed,),
        ).fetchone()
        return dict(row) if row else None


def revoke_key(key_id: int) -> bool:
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(_db_path()) as conn:
        cur = conn.execute(
            "UPDATE api_keys SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL",
            (now, key_id),
        )
        conn.commit()
        return cur.rowcount > 0


def list_keys() -> list:
    with sqlite3.connect(_db_path()) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT id, label, monthly_quota, month_bucket, requests_used,
                   created_at, last_used_at, disabled_at, scopes
            FROM api_keys
            ORDER BY id DESC
            """
        ).fetchall()
        return [dict(r) for r in rows]


def _record_request(key_id: int, endpoint: str, status: int, latency_ms: int) -> None:
    """Log + increment monthly usage. Safe to call after the response is sent."""
    now = datetime.now(timezone.utc).isoformat()
    bucket = _current_month_bucket()
    with sqlite3.connect(_db_path()) as conn:
        conn.execute(
            "INSERT INTO request_log (key_id, ts, endpoint, status, latency_ms) VALUES (?, ?, ?, ?, ?)",
            (key_id, now, endpoint, status, latency_ms),
        )
        # Roll the monthly counter when the bucket changes
        conn.execute(
            """
            UPDATE api_keys
            SET requests_used = CASE
                  WHEN month_bucket = ? THEN requests_used + 1
                  ELSE 1 END,
                month_bucket = ?,
                last_used_at = ?
            WHERE id = ?
            """,
            (bucket, bucket, now, key_id),
        )
        conn.commit()


# --------------------------------------------------------------------------
# Rate limiter (per-key burst window)
# --------------------------------------------------------------------------

_burst_window: Dict[int, Deque[float]] = defaultdict(deque)


def _check_burst(key_id: int, limit_per_minute: int = DEFAULT_BURST_PER_MINUTE) -> bool:
    """Return True if this request is within the burst limit."""
    now = time.monotonic()
    window = _burst_window[key_id]
    while window and window[0] < now - 60.0:
        window.popleft()
    if len(window) >= limit_per_minute:
        return False
    window.append(now)
    return True


# --------------------------------------------------------------------------
# Auth dependency
# --------------------------------------------------------------------------


async def require_api_key(
    authorization: Optional[str] = Header(None),
) -> Dict[str, Any]:
    """
    Validate Bearer token, enforce burst limit + monthly quota, return the
    key record. Raises HTTPException on any failure.

    The endpoint handler is expected to call _record_request(...) on its
    way out so usage gets logged.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing Authorization: Bearer <api_key> header",
        )
    raw = authorization[7:].strip()
    if not raw.startswith(API_KEY_PREFIX):
        raise HTTPException(status_code=401, detail="Invalid API key format")

    key = get_key_by_hash(_hash_key(raw))
    if not key:
        raise HTTPException(status_code=401, detail="Invalid API key")
    if key.get("disabled_at"):
        raise HTTPException(status_code=401, detail="API key has been revoked")

    # Roll quota bucket if the month changed
    used = key["requests_used"] if key["month_bucket"] == _current_month_bucket() else 0
    if used >= key["monthly_quota"]:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "quota_exceeded",
                "message": (
                    f"Monthly quota of {key['monthly_quota']} requests reached. "
                    "Resets at the start of next UTC month."
                ),
            },
        )

    if not _check_burst(key["id"]):
        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limited",
                "message": f"Burst limit of {DEFAULT_BURST_PER_MINUTE} req/min reached",
            },
        )

    return key


def scoped(required_scope: str):
    """Dependency factory: authenticate the key AND require an RBAC scope.

    403 (insufficient_scope) when the key is valid but not permitted — so a
    sign-only key can call /pdf/sign and nothing else.
    """

    async def dependency(
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        key = await require_api_key(authorization)
        if not key_has_scope(key, required_scope):
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "insufficient_scope",
                    "message": (
                        f"This API key does not have the '{required_scope}' scope. "
                        f"Key scopes: {', '.join(key_scopes(key))}"
                    ),
                    "required_scope": required_scope,
                },
            )
        return key

    return dependency


def _require_admin(x_admin_token: Optional[str] = Header(None)) -> None:
    expected = os.environ.get(ADMIN_TOKEN_ENV)
    if not expected:
        raise HTTPException(
            status_code=503,
            detail=f"Admin endpoints disabled ({ADMIN_TOKEN_ENV} not set)",
        )
    if not x_admin_token or not secrets.compare_digest(x_admin_token, expected):
        raise HTTPException(status_code=401, detail="Invalid admin token")


def self_serve_keys_available() -> bool:
    """True iff signed-in users can mint their own keys (Clerk configured)."""
    from clerk_auth import clerk_configured

    return clerk_configured()


async def require_clerk_user(
    authorization: Optional[str] = Header(None),
) -> Dict[str, Any]:
    """
    Authenticate the caller via their Clerk session JWT (Authorization: Bearer
    <clerk_token>) and enforce the optional email-domain allowlist. Returns
    {"sub": <clerk_user_id>, "email": <str|None>, "claims": {...}}.

    Distinct from require_api_key: this gate is for the browser self-serve key
    UI, not for calling tool endpoints.
    """
    from clerk_auth import (
        ClerkAuthError,
        check_domain_allowed,
        clerk_configured,
        resolve_email,
        verify_clerk_token,
    )

    if not clerk_configured():
        raise HTTPException(
            status_code=503,
            detail=(
                "Self-serve API keys are not enabled on this server "
                "(CLERK_ISSUER not set)."
            ),
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing Authorization: Bearer <clerk_session_token> header",
        )
    token = authorization[7:].strip()
    try:
        claims = verify_clerk_token(token)
        check_domain_allowed(claims)
    except ClerkAuthError as e:
        # 403 for the domain gate (authenticated but not permitted), 401 otherwise.
        status = 403 if "not permitted" in str(e) or "restricted" in str(e) else 401
        raise HTTPException(status_code=status, detail=str(e))

    return {"sub": claims["sub"], "email": resolve_email(claims), "claims": claims}


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

router = APIRouter(prefix="/api/v1", tags=["v1"])


class CreateKeyRequest(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    monthly_quota: int = Field(default=DEFAULT_MONTHLY_QUOTA, ge=1, le=1_000_000)
    scopes: Optional[list[str]] = Field(
        default=None,
        description=(
            "RBAC scopes for this key. Omit for full access ('*'). "
            "Valid: pdf, pdf.read, pdf.write, pdf.sign, convert, image, video. "
            "Example: ['pdf.sign'] mints a sign-only key."
        ),
    )


class CreateKeyResponse(BaseModel):
    id: int
    key: str = Field(description="Full API key — only returned at creation")
    label: str
    monthly_quota: int
    scopes: list[str]
    created_at: str


class KeySummary(BaseModel):
    id: int
    label: str
    monthly_quota: int
    requests_used: int
    month_bucket: str
    created_at: str
    last_used_at: Optional[str]
    disabled_at: Optional[str]
    scopes: Optional[str] = "*"


@router.post(
    "/admin/keys",
    response_model=CreateKeyResponse,
    summary="Issue a new API key (admin only)",
    dependencies=[Depends(_require_admin)],
)
def create_key_endpoint(req: CreateKeyRequest) -> Dict[str, Any]:
    try:
        return create_key(
            label=req.label, monthly_quota=req.monthly_quota, scopes=req.scopes
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get(
    "/admin/keys",
    response_model=list[KeySummary],
    summary="List all API keys (admin only)",
    dependencies=[Depends(_require_admin)],
)
def list_keys_endpoint() -> list:
    return list_keys()


@router.delete(
    "/admin/keys/{key_id}",
    summary="Revoke an API key (admin only)",
    dependencies=[Depends(_require_admin)],
)
def revoke_key_endpoint(key_id: int) -> Dict[str, Any]:
    if not revoke_key(key_id):
        raise HTTPException(status_code=404, detail="Key not found or already revoked")
    return {"id": key_id, "revoked": True}


# --------------------------------------------------------------------------
# Self-serve keys — a signed-in Clerk user manages their own API key.
# Authenticated by the Clerk session JWT (not the admin token). Dormant until
# CLERK_ISSUER is configured; see clerk_auth.py.
# --------------------------------------------------------------------------


class SelfKeyStatus(BaseModel):
    has_key: bool
    label: Optional[str] = None
    monthly_quota: Optional[int] = None
    requests_used: Optional[int] = None
    created_at: Optional[str] = None
    last_used_at: Optional[str] = None
    email: Optional[str] = None


class SelfKeyCreated(BaseModel):
    key: str = Field(description="Full API key — shown only once, store it now.")
    label: str
    monthly_quota: int
    created_at: str


def _self_key_label(user: Dict[str, Any]) -> str:
    """Human-friendly label for a self-serve key (email if known, else user id)."""
    email = user.get("email")
    if email:
        return email
    return f"clerk:{user['sub'][:16]}"


@router.get(
    "/keys/me",
    response_model=SelfKeyStatus,
    summary="Get the signed-in user's API key status",
)
async def get_my_key(user: Dict[str, Any] = Depends(require_clerk_user)) -> Dict[str, Any]:
    """Return metadata about the user's active key. Never returns the raw key
    (it's hashed at rest — only shown once at creation/rotation)."""
    rec = get_active_key_for_clerk_user(user["sub"])
    if not rec:
        return {"has_key": False, "email": user.get("email")}
    used = rec["requests_used"] if rec["month_bucket"] == _current_month_bucket() else 0
    return {
        "has_key": True,
        "label": rec["label"],
        "monthly_quota": rec["monthly_quota"],
        "requests_used": used,
        "created_at": rec["created_at"],
        "last_used_at": rec["last_used_at"],
        "email": user.get("email"),
    }


@router.post(
    "/keys/me",
    response_model=SelfKeyCreated,
    summary="Create the signed-in user's API key",
)
async def create_my_key(user: Dict[str, Any] = Depends(require_clerk_user)) -> Dict[str, Any]:
    """Mint a key for the user. 409 if one already exists (use rotate)."""
    if get_active_key_for_clerk_user(user["sub"]):
        raise HTTPException(
            status_code=409,
            detail="You already have an active API key. Rotate it to get a new one.",
        )
    return create_key(
        label=_self_key_label(user),
        monthly_quota=DEFAULT_MONTHLY_QUOTA,
        clerk_user_id=user["sub"],
    )


@router.post(
    "/keys/me/rotate",
    response_model=SelfKeyCreated,
    summary="Rotate (revoke + reissue) the signed-in user's API key",
)
async def rotate_my_key(user: Dict[str, Any] = Depends(require_clerk_user)) -> Dict[str, Any]:
    """Revoke the existing key (if any) and issue a fresh one."""
    existing = get_active_key_for_clerk_user(user["sub"])
    if existing:
        revoke_key(existing["id"])
    return create_key(
        label=_self_key_label(user),
        monthly_quota=DEFAULT_MONTHLY_QUOTA,
        clerk_user_id=user["sub"],
    )


@router.delete(
    "/keys/me",
    summary="Revoke the signed-in user's API key",
)
async def delete_my_key(user: Dict[str, Any] = Depends(require_clerk_user)) -> Dict[str, Any]:
    existing = get_active_key_for_clerk_user(user["sub"])
    if not existing:
        raise HTTPException(status_code=404, detail="No active API key to revoke")
    revoke_key(existing["id"])
    return {"revoked": True}


# --------------------------------------------------------------------------
# Tool endpoints — thin wrappers around the existing processors
# --------------------------------------------------------------------------


def _stream_png(data: bytes, filename: str = "output.png") -> StreamingResponse:
    return StreamingResponse(
        io.BytesIO(data),
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post(
    "/image/remove-bg",
    summary="Remove background from an image",
    description="Returns a PNG with the background replaced by transparency. Backed by rembg / U²-Net.",
)
async def v1_remove_bg(
    image: UploadFile = File(..., description="PNG, JPEG, or WebP, up to 10MB"),
    key: Dict[str, Any] = Depends(scoped("image")),
):
    from image_processor import ImageProcessor  # local import to avoid cycles

    started = time.monotonic()
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="image is required")
    if len(image_bytes) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (10MB max)")

    proc = ImageProcessor()
    output = await proc.remove_background(image_bytes, output_format="png")

    _record_request(
        key_id=key["id"],
        endpoint="image/remove-bg",
        status=200,
        latency_ms=int((time.monotonic() - started) * 1000),
    )
    return _stream_png(output, filename="no-bg.png")


@router.post(
    "/image/edit",
    summary="Edit an image with a natural-language prompt (Gemini)",
    description="Prompt-based image editing via Gemini's image-editing model. Returns PNG.",
)
async def v1_edit_image(
    image: UploadFile = File(..., description="PNG, JPEG, or WebP, up to 20MB"),
    prompt: str = Form(..., description="What to change", min_length=3, max_length=2000),
    key: Dict[str, Any] = Depends(scoped("image")),
):
    from inpaint_processor import EditError, edit_image_with_prompt

    started = time.monotonic()
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="image is required")
    if len(image_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (20MB max)")

    try:
        out = await edit_image_with_prompt(image_bytes=image_bytes, prompt=prompt)
    except EditError as e:
        msg = str(e)
        status = 503 if "not configured" in msg else 502
        _record_request(key["id"], "image/edit", status, int((time.monotonic() - started) * 1000))
        raise HTTPException(status_code=status, detail=msg)

    _record_request(
        key_id=key["id"],
        endpoint="image/edit",
        status=200,
        latency_ms=int((time.monotonic() - started) * 1000),
    )
    return _stream_png(out, filename="edited.png")


class PdfRemoveWatermarkRegion(BaseModel):
    page: int = Field(ge=1, description="1-indexed page number.")
    x: float = Field(description="Left edge in PDF points (1pt = 1/72 in).")
    y: float = Field(description="Top edge in PDF points.")
    w: float = Field(gt=0)
    h: float = Field(gt=0)


@router.post(
    "/pdf/remove-watermark",
    summary="Remove watermarks from a PDF",
    description=(
        "Server-side equivalent of the browser PDF Watermark Remover. Pass "
        "the source PDF and a JSON list of region rectangles in PDF-point "
        "coordinates. Affected pages are rendered, inpainted, and re-embedded; "
        "untouched pages pass through unchanged."
    ),
)
async def v1_pdf_remove_watermark(
    file: UploadFile = File(..., description="Source PDF (up to 50MB)"),
    regions: str = Form(
        ...,
        description=(
            'JSON array of {"page": int (1-indexed), "x": float, "y": float, '
            '"w": float, "h": float}, all in PDF points.'
        ),
    ),
    method: str = Form(
        "telea",
        description="Inpainting method: 'telea' / 'ns' (OpenCV, local) or 'gemini' (AI, server).",
    ),
    radius: int = Form(5, ge=1, le=30),
    key: Dict[str, Any] = Depends(scoped("pdf.write")),
):
    import json as _json

    from pdf_processor import PdfWatermarkError, remove_watermarks_from_pdf

    started = time.monotonic()
    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="file is required")
    if len(pdf_bytes) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="PDF too large (50MB max)")

    try:
        parsed_regions = _json.loads(regions)
        if not isinstance(parsed_regions, list) or not parsed_regions:
            raise ValueError("regions must be a non-empty array")
        for r in parsed_regions:
            for k in ("page", "x", "y", "w", "h"):
                if k not in r:
                    raise ValueError(f"each region needs {k}")
    except (ValueError, _json.JSONDecodeError) as e:
        raise HTTPException(status_code=422, detail=f"invalid regions: {e}")

    if method not in {"telea", "ns", "gemini"}:
        raise HTTPException(
            status_code=422, detail="method must be 'telea', 'ns', or 'gemini'"
        )

    try:
        out_pdf = await remove_watermarks_from_pdf(
            pdf_bytes=pdf_bytes,
            regions=parsed_regions,
            method=method,
            radius=radius,
        )
    except PdfWatermarkError as e:
        _record_request(
            key["id"], "pdf/remove-watermark", 422, int((time.monotonic() - started) * 1000)
        )
        raise HTTPException(status_code=422, detail=str(e))

    _record_request(
        key_id=key["id"],
        endpoint="pdf/remove-watermark",
        status=200,
        latency_ms=int((time.monotonic() - started) * 1000),
    )
    return StreamingResponse(
        io.BytesIO(out_pdf),
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'attachment; filename="watermark-removed.pdf"',
        },
    )


@router.post(
    "/image/detect-watermarks",
    summary="Auto-detect watermarks/logos in an image (Gemini)",
    description="Returns bounding boxes for any watermarks Gemini finds. Useful as a pre-step before /image/inpaint.",
)
async def v1_detect_watermarks(
    image: UploadFile = File(...),
    key: Dict[str, Any] = Depends(scoped("image")),
):
    from inpaint_processor import DetectError, detect_watermarks

    started = time.monotonic()
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="image is required")
    if len(image_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (20MB max)")

    try:
        boxes = await detect_watermarks(image_bytes)
    except DetectError as e:
        msg = str(e)
        status = 503 if "not set" in msg or "not configured" in msg else 502
        _record_request(
            key["id"], "image/detect-watermarks", status, int((time.monotonic() - started) * 1000)
        )
        raise HTTPException(status_code=status, detail=msg)

    _record_request(
        key_id=key["id"],
        endpoint="image/detect-watermarks",
        status=200,
        latency_ms=int((time.monotonic() - started) * 1000),
    )
    return {"watermarks": boxes}


@router.post(
    "/image/inpaint",
    summary="Inpaint masked regions of an image (Gemini, OpenCV fallback)",
    description="Mask-based inpainting. Provide an image and a binary mask (white=inpaint).",
)
async def v1_inpaint(
    image: UploadFile = File(...),
    mask: UploadFile = File(...),
    prompt: Optional[str] = Form(None),
    radius: int = Form(5),
    key: Dict[str, Any] = Depends(scoped("image")),
):
    from inpaint_processor import InpaintError, inpaint_image

    started = time.monotonic()
    image_bytes = await image.read()
    mask_bytes = await mask.read()
    if not image_bytes or not mask_bytes:
        raise HTTPException(status_code=400, detail="image and mask are required")
    if len(image_bytes) > 20 * 1024 * 1024 or len(mask_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image or mask too large (20MB max)")

    try:
        out = await inpaint_image(
            image_bytes=image_bytes,
            mask_bytes=mask_bytes,
            prompt=prompt,
            radius=radius,
        )
    except InpaintError as e:
        _record_request(key["id"], "image/inpaint", 502, int((time.monotonic() - started) * 1000))
        raise HTTPException(status_code=502, detail=str(e))

    _record_request(
        key_id=key["id"],
        endpoint="image/inpaint",
        status=200,
        latency_ms=int((time.monotonic() - started) * 1000),
    )
    return _stream_png(out, filename="inpainted.png")


class VideoDownloadRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    format: str = Field(default="mp4", pattern="^(mp3|mp4)$")


@router.post(
    "/video/download",
    summary="Download a YouTube/Instagram video as MP4 or extract MP3",
)
async def v1_video_download(
    payload: VideoDownloadRequest,
    key: Dict[str, Any] = Depends(scoped("video")),
):
    """
    Returns the file as a binary stream with Content-Type set to video/mp4
    or audio/mpeg.
    """
    import tempfile

    from media_downloader import MediaDownloadError, cleanup_work_dir, download_media

    started = time.monotonic()
    work_dir = Path(tempfile.mkdtemp(prefix="champdf_v1_dl_"))
    try:
        result_path = await download_media(
            url=payload.url, fmt=payload.format, work_dir=work_dir
        )
    except MediaDownloadError as e:
        cleanup_work_dir(work_dir)
        _record_request(
            key["id"], "video/download", 400, int((time.monotonic() - started) * 1000)
        )
        raise HTTPException(status_code=400, detail={"code": e.code, "message": str(e)})

    media_type = "audio/mpeg" if payload.format == "mp3" else "video/mp4"

    def file_iter():
        try:
            with open(result_path, "rb") as f:
                while chunk := f.read(64 * 1024):
                    yield chunk
        finally:
            cleanup_work_dir(work_dir)

    _record_request(
        key_id=key["id"],
        endpoint="video/download",
        status=200,
        latency_ms=int((time.monotonic() - started) * 1000),
    )
    return StreamingResponse(
        file_iter(),
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{result_path.name}"',
        },
    )


_VALID_LOGO_PRESETS = {"lakeb2b", "champions", "ampliz", "none"}
_VALID_WATERMARK_POSITIONS = {
    "bottom-right",
    "bottom-left",
    "top-right",
    "top-left",
}
_VALID_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".avi"}


@router.post(
    "/video/remove-logo",
    summary="Remove a watermark/logo from a video and optionally rebrand",
    description=(
        "Strips an AI watermark (e.g. NotebookLM-style corner logos) from a "
        "video using OpenCV inpainting (FFmpeg-delogo fallback) and optionally "
        "overlays a replacement logo. Returns MP4."
    ),
)
async def v1_video_remove_logo(
    file: UploadFile = File(..., description="Source video (mp4/mov/webm/avi, up to 100MB)"),
    logo_preset: str = Form(
        "lakeb2b",
        description="Replacement logo preset. One of: lakeb2b, champions, ampliz, none.",
    ),
    watermark_position: str = Form(
        "bottom-right",
        description="Where the original watermark sits — also where the new logo lands.",
    ),
    logo_scale: float = Form(
        1.0,
        description="Replacement logo size multiplier (0.5–2.0; 1.0 = ~120px wide).",
    ),
    key: Dict[str, Any] = Depends(scoped("video")),
):
    import tempfile

    from video_processor import VideoProcessor
    from config import settings as v_settings

    started = time.monotonic()

    file_ext = Path(file.filename or "").suffix.lower()
    if file_ext not in _VALID_VIDEO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type. Allowed: {', '.join(_VALID_VIDEO_EXTENSIONS)}",
        )
    if logo_preset not in _VALID_LOGO_PRESETS:
        raise HTTPException(
            status_code=400, detail=f"logo_preset must be one of {_VALID_LOGO_PRESETS}"
        )
    if watermark_position not in _VALID_WATERMARK_POSITIONS:
        raise HTTPException(
            status_code=400,
            detail=f"watermark_position must be one of {_VALID_WATERMARK_POSITIONS}",
        )
    if not 0.5 <= logo_scale <= 2.0:
        raise HTTPException(
            status_code=400, detail="logo_scale must be between 0.5 and 2.0"
        )

    work_dir = Path(tempfile.mkdtemp(prefix="champdf_v1_video_"))
    input_path = work_dir / f"input{file_ext}"
    output_path = work_dir / "output.mp4"

    try:
        # Stream upload to disk with a size cap
        total = 0
        async with __import__("aiofiles").open(input_path, "wb") as out_file:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > v_settings.MAX_FILE_SIZE:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File too large. Max: {v_settings.MAX_VIDEO_SIZE_MB}MB",
                    )
                await out_file.write(chunk)

        proc = VideoProcessor(logo_dir=v_settings.LOGO_DIR)
        success, error = await proc.process(
            input_path=str(input_path),
            output_path=str(output_path),
            logo_preset=logo_preset,
            watermark_position=watermark_position,
            logo_scale=logo_scale,
        )
        if not success:
            raise HTTPException(status_code=500, detail=f"Processing failed: {error}")

        # Stream result and clean up the work_dir afterwards.
        def file_iter():
            try:
                with open(output_path, "rb") as f:
                    while chunk := f.read(64 * 1024):
                        yield chunk
            finally:
                import shutil
                shutil.rmtree(work_dir, ignore_errors=True)

        _record_request(
            key_id=key["id"],
            endpoint="video/remove-logo",
            status=200,
            latency_ms=int((time.monotonic() - started) * 1000),
        )
        return StreamingResponse(
            file_iter(),
            media_type="video/mp4",
            headers={
                "Content-Disposition": 'attachment; filename="rebranded.mp4"',
            },
        )
    except HTTPException:
        import shutil
        shutil.rmtree(work_dir, ignore_errors=True)
        raise
    except Exception as e:
        import shutil
        shutil.rmtree(work_dir, ignore_errors=True)
        _record_request(
            key_id=key["id"],
            endpoint="video/remove-logo",
            status=500,
            latency_ms=int((time.monotonic() - started) * 1000),
        )
        raise HTTPException(status_code=500, detail=str(e))


# --------------------------------------------------------------------------
# Document endpoints — the enterprise surface (Salesforce & co).
# Merge / split / compress / rotate / watermark / rasterize / text, plus
# compliance signing (pyHanko), OCR (OCRmyPDF), table extraction, and
# Office ↔ PDF conversion (LibreOffice / pdf2docx).
# --------------------------------------------------------------------------

MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_OFFICE_BYTES = 50 * 1024 * 1024


def _meter(key: Dict[str, Any], endpoint: str, started: float, status: int = 200) -> None:
    _record_request(
        key_id=key["id"],
        endpoint=endpoint,
        status=status,
        latency_ms=int((time.monotonic() - started) * 1000),
    )


def _stream_pdf(data: bytes, filename: str = "output.pdf") -> StreamingResponse:
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def _read_pdf_upload(file: UploadFile, max_bytes: int = MAX_PDF_BYTES) -> bytes:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="file is required")
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=413, detail=f"File too large ({max_bytes // (1024 * 1024)}MB max)"
        )
    return data


@router.get(
    "/capabilities",
    summary="Which optional features are enabled on this server",
)
async def v1_capabilities(key: Dict[str, Any] = Depends(require_api_key)) -> Dict[str, Any]:
    from doc_converter import office_to_pdf_available, pdf_to_docx_available
    from ocr_processor import ocr_available
    from pdf_signer import sign_available
    from table_extractor import table_extraction_available

    return {
        "pdf_core": True,  # merge/split/compress/rotate/watermark/images/text
        "pdf_sign": sign_available(),
        "pdf_ocr": ocr_available(),
        "pdf_tables": table_extraction_available(),
        "office_to_pdf": office_to_pdf_available(),
        "pdf_to_docx": pdf_to_docx_available(),
        "gemini_image_tools": bool(os.environ.get("GEMINI_API_KEY")),
    }


@router.post("/pdf/merge", summary="Merge multiple PDFs into one")
async def v1_pdf_merge(
    files: list[UploadFile] = File(..., description="Two or more PDFs, in merge order"),
    key: Dict[str, Any] = Depends(scoped("pdf.write")),
):
    from pdf_ops import PdfOpsError, merge_pdfs

    started = time.monotonic()
    pdfs = [await _read_pdf_upload(f) for f in files]
    try:
        out = await merge_pdfs(pdfs)
    except PdfOpsError as e:
        _meter(key, "pdf/merge", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/merge", started)
    return _stream_pdf(out, "merged.pdf")


@router.post(
    "/pdf/split",
    summary="Extract a page range into a new PDF",
    description=(
        "Keeps only the pages in `pages` (1-based spec like '1-3,7,9-'; "
        "order is preserved, so this also reorders). Use /pdf/delete-pages "
        "for the inverse."
    ),
)
async def v1_pdf_split(
    file: UploadFile = File(...),
    pages: str = Form(..., description="Page spec, e.g. '1-3,7' or '2-'"),
    key: Dict[str, Any] = Depends(scoped("pdf.write")),
):
    from pdf_ops import PdfOpsError, extract_pages

    started = time.monotonic()
    data = await _read_pdf_upload(file)
    try:
        out = await extract_pages(data, pages)
    except PdfOpsError as e:
        _meter(key, "pdf/split", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/split", started)
    return _stream_pdf(out, "split.pdf")


@router.post("/pdf/delete-pages", summary="Delete pages from a PDF")
async def v1_pdf_delete_pages(
    file: UploadFile = File(...),
    pages: str = Form(..., description="Pages to remove, e.g. '2,5-6'"),
    key: Dict[str, Any] = Depends(scoped("pdf.write")),
):
    from pdf_ops import PdfOpsError, delete_pages

    started = time.monotonic()
    data = await _read_pdf_upload(file)
    try:
        out = await delete_pages(data, pages)
    except PdfOpsError as e:
        _meter(key, "pdf/delete-pages", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/delete-pages", started)
    return _stream_pdf(out, "pages-deleted.pdf")


@router.post("/pdf/rotate", summary="Rotate pages")
async def v1_pdf_rotate(
    file: UploadFile = File(...),
    angle: int = Form(..., description="90, 180, or 270 (clockwise)"),
    pages: str = Form("all", description="Page spec, default all"),
    key: Dict[str, Any] = Depends(scoped("pdf.write")),
):
    from pdf_ops import PdfOpsError, rotate_pages

    started = time.monotonic()
    data = await _read_pdf_upload(file)
    try:
        out = await rotate_pages(data, angle, pages)
    except PdfOpsError as e:
        _meter(key, "pdf/rotate", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/rotate", started)
    return _stream_pdf(out, "rotated.pdf")


@router.post(
    "/pdf/compress",
    summary="Compress a PDF",
    description="Structural clean-up plus embedded-image downsampling. Never returns a file larger than the input.",
)
async def v1_pdf_compress(
    file: UploadFile = File(...),
    image_dpi: int = Form(150, ge=50, le=300, description="Target DPI for embedded images"),
    image_quality: int = Form(70, ge=10, le=95, description="JPEG quality for recompressed images"),
    key: Dict[str, Any] = Depends(scoped("pdf.write")),
):
    from pdf_ops import PdfOpsError, compress_pdf

    started = time.monotonic()
    data = await _read_pdf_upload(file)
    try:
        out = await compress_pdf(data, image_dpi=image_dpi, image_quality=image_quality)
    except PdfOpsError as e:
        _meter(key, "pdf/compress", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/compress", started)
    return _stream_pdf(out, "compressed.pdf")


@router.post("/pdf/watermark", summary="Stamp a text watermark on pages")
async def v1_pdf_watermark(
    file: UploadFile = File(...),
    text: str = Form(..., min_length=1, max_length=200),
    opacity: float = Form(0.15, ge=0.02, le=1.0),
    font_size: int = Form(48, ge=8, le=144),
    color: str = Form("888888", description="6-digit hex, no '#'"),
    angle: int = Form(45, ge=-90, le=90),
    pages: str = Form("all"),
    key: Dict[str, Any] = Depends(scoped("pdf.write")),
):
    from pdf_ops import PdfOpsError, add_watermark

    started = time.monotonic()
    data = await _read_pdf_upload(file)
    try:
        out = await add_watermark(
            data, text, opacity=opacity, font_size=font_size,
            color=color, angle=angle, spec=pages,
        )
    except PdfOpsError as e:
        _meter(key, "pdf/watermark", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/watermark", started)
    return _stream_pdf(out, "watermarked.pdf")


@router.post("/pdf/info", summary="Inspect a PDF (page count, metadata, size)")
async def v1_pdf_info(
    file: UploadFile = File(...),
    key: Dict[str, Any] = Depends(scoped("pdf.read")),
):
    from pdf_ops import PdfOpsError, pdf_info

    started = time.monotonic()
    data = await _read_pdf_upload(file)
    try:
        info = await pdf_info(data)
    except PdfOpsError as e:
        _meter(key, "pdf/info", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/info", started)
    return info


@router.post("/pdf/to-text", summary="Extract text per page (JSON)")
async def v1_pdf_to_text(
    file: UploadFile = File(...),
    pages: str = Form("all"),
    key: Dict[str, Any] = Depends(scoped("pdf.read")),
):
    from pdf_ops import PdfOpsError, pdf_to_text

    started = time.monotonic()
    data = await _read_pdf_upload(file)
    try:
        result = await pdf_to_text(data, pages)
    except PdfOpsError as e:
        _meter(key, "pdf/to-text", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/to-text", started)
    return {"pages": result}


@router.post(
    "/pdf/to-images",
    summary="Rasterize pages to PNG/JPEG (returns a ZIP)",
)
async def v1_pdf_to_images(
    file: UploadFile = File(...),
    pages: str = Form("all"),
    dpi: int = Form(150, ge=30, le=600),
    format: str = Form("png", pattern="^(png|jpeg)$"),
    key: Dict[str, Any] = Depends(scoped("pdf.read")),
):
    from pdf_ops import PdfOpsError, pdf_to_images

    started = time.monotonic()
    data = await _read_pdf_upload(file)
    try:
        zip_bytes, n = await pdf_to_images(data, spec=pages, dpi=dpi, fmt=format)
    except PdfOpsError as e:
        _meter(key, "pdf/to-images", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/to-images", started)
    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="pages.zip"',
            "X-Page-Count": str(n),
        },
    )


@router.post("/pdf/from-images", summary="Combine images into a PDF")
async def v1_pdf_from_images(
    files: list[UploadFile] = File(..., description="PNG/JPEG/WebP images, in page order"),
    key: Dict[str, Any] = Depends(scoped("pdf.write")),
):
    from pdf_ops import PdfOpsError, images_to_pdf

    started = time.monotonic()
    images = []
    for f in files:
        data = await f.read()
        if not data:
            raise HTTPException(status_code=400, detail="Empty image upload")
        if len(data) > 20 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Image too large (20MB max)")
        images.append(data)
    try:
        out = await images_to_pdf(images)
    except PdfOpsError as e:
        _meter(key, "pdf/from-images", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/from-images", started)
    return _stream_pdf(out, "images.pdf")


@router.post(
    "/pdf/sign",
    summary="Digitally sign a PDF (PAdES via pyHanko)",
    description=(
        "Compliance-grade digital signature. Provide the PDF and the signer's "
        ".p12/.pfx certificate + password. `timestamp=true` adds a trusted "
        "timestamp (PAdES B-T) from the configured TSA."
    ),
)
async def v1_pdf_sign(
    file: UploadFile = File(..., description="PDF to sign"),
    cert: UploadFile = File(..., description="Signer certificate (.p12/.pfx)"),
    passphrase: str = Form("", description="Certificate password"),
    reason: Optional[str] = Form(None, max_length=200),
    location: Optional[str] = Form(None, max_length=200),
    field_name: str = Form("Signature1", max_length=100),
    timestamp: bool = Form(True),
    key: Dict[str, Any] = Depends(scoped("pdf.sign")),
):
    from pdf_signer import SignError, default_tsa_url, sign_available, sign_pdf

    started = time.monotonic()
    if not sign_available():
        raise HTTPException(status_code=503, detail="PDF signing is not enabled on this server")
    pdf_bytes = await _read_pdf_upload(file)
    p12_bytes = await cert.read()
    if not p12_bytes:
        raise HTTPException(status_code=400, detail="cert is required")

    tsa = default_tsa_url() if timestamp else None
    try:
        out = await sign_pdf(
            pdf_bytes, p12_bytes, passphrase,
            field_name=field_name, reason=reason, location=location, tsa_url=tsa,
        )
    except SignError as e:
        _meter(key, "pdf/sign", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/sign", started)
    return _stream_pdf(out, "signed.pdf")


@router.post(
    "/pdf/verify-signature",
    summary="Verify digital signatures in a PDF (JSON report)",
)
async def v1_pdf_verify(
    file: UploadFile = File(...),
    key: Dict[str, Any] = Depends(scoped("pdf.read")),
):
    from pdf_signer import SignError, sign_available, verify_pdf

    started = time.monotonic()
    if not sign_available():
        raise HTTPException(
            status_code=503, detail="Signature verification is not enabled on this server"
        )
    pdf_bytes = await _read_pdf_upload(file)
    try:
        report = await verify_pdf(pdf_bytes)
    except SignError as e:
        _meter(key, "pdf/verify-signature", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/verify-signature", started)
    return report


@router.post(
    "/pdf/ocr",
    summary="OCR a scanned PDF → searchable PDF / PDF-A (OCRmyPDF)",
)
async def v1_pdf_ocr(
    file: UploadFile = File(...),
    language: str = Form("eng", max_length=20),
    pdfa: bool = Form(True, description="Also convert to archival PDF/A"),
    key: Dict[str, Any] = Depends(scoped("pdf.write")),
):
    from ocr_processor import OcrError, ocr_available, ocr_pdf

    started = time.monotonic()
    if not ocr_available():
        raise HTTPException(status_code=503, detail="Server OCR is not enabled on this server")
    pdf_bytes = await _read_pdf_upload(file)
    try:
        out = await ocr_pdf(pdf_bytes, language=language, pdfa=pdfa)
    except OcrError as e:
        _meter(key, "pdf/ocr", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/ocr", started)
    return _stream_pdf(out, "ocr.pdf")


@router.post(
    "/pdf/extract-tables",
    summary="Extract tables from a PDF (JSON rows)",
)
async def v1_pdf_extract_tables(
    file: UploadFile = File(...),
    key: Dict[str, Any] = Depends(scoped("pdf.read")),
):
    from table_extractor import TableExtractionError, extract_tables, table_extraction_available

    started = time.monotonic()
    if not table_extraction_available():
        raise HTTPException(
            status_code=503, detail="Table extraction is not enabled on this server"
        )
    pdf_bytes = await _read_pdf_upload(file)
    try:
        tables = await extract_tables(pdf_bytes)
    except TableExtractionError as e:
        _meter(key, "pdf/extract-tables", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "pdf/extract-tables", started)
    return {"tables": tables}


@router.post(
    "/convert/to-pdf",
    summary="Convert an Office document to PDF (LibreOffice)",
    description=(
        "Accepts doc/docx/odt/rtf/txt, xls/xlsx/ods/csv, ppt/pptx/odp, html. "
        "503 when LibreOffice is not installed on the server."
    ),
)
async def v1_convert_to_pdf(
    file: UploadFile = File(...),
    key: Dict[str, Any] = Depends(scoped("convert")),
):
    from doc_converter import ConvertError, office_to_pdf, office_to_pdf_available

    started = time.monotonic()
    if not office_to_pdf_available():
        raise HTTPException(
            status_code=503, detail="Office-to-PDF conversion is not enabled on this server"
        )
    data = await _read_pdf_upload(file, MAX_OFFICE_BYTES)
    try:
        out = await office_to_pdf(data, file.filename or "")
    except ConvertError as e:
        _meter(key, "convert/to-pdf", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "convert/to-pdf", started)
    base = (file.filename or "document").rsplit(".", 1)[0]
    return _stream_pdf(out, f"{base}.pdf")


@router.post(
    "/convert/pdf-to-docx",
    summary="Convert a PDF to an editable Word document (pdf2docx)",
)
async def v1_convert_pdf_to_docx(
    file: UploadFile = File(...),
    key: Dict[str, Any] = Depends(scoped("convert")),
):
    from doc_converter import ConvertError, pdf_to_docx, pdf_to_docx_available

    started = time.monotonic()
    if not pdf_to_docx_available():
        raise HTTPException(
            status_code=503, detail="PDF-to-DOCX conversion is not enabled on this server"
        )
    data = await _read_pdf_upload(file)
    try:
        out = await pdf_to_docx(data)
    except ConvertError as e:
        _meter(key, "convert/pdf-to-docx", started, 422)
        raise HTTPException(status_code=422, detail=str(e))
    _meter(key, "convert/pdf-to-docx", started)
    base = (file.filename or "document").rsplit(".", 1)[0]
    return StreamingResponse(
        io.BytesIO(out),
        media_type=(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ),
        headers={"Content-Disposition": f'attachment; filename="{base}.docx"'},
    )


@router.get("/whoami", summary="Inspect the authenticated key")
async def v1_whoami(key: Dict[str, Any] = Depends(require_api_key)) -> Dict[str, Any]:
    """Useful smoke test: confirms the key works without consuming heavy quota."""
    return {
        "id": key["id"],
        "label": key["label"],
        "monthly_quota": key["monthly_quota"],
        "requests_used": key["requests_used"],
        "month_bucket": key["month_bucket"],
        "scopes": key_scopes(key),
    }
