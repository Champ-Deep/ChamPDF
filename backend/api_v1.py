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
        conn.commit()


def _hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _current_month_bucket() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


def create_key(label: str, monthly_quota: int = DEFAULT_MONTHLY_QUOTA) -> Dict[str, Any]:
    """Issue a new API key. Returns the raw key (only shown once) + metadata."""
    raw = API_KEY_PREFIX + secrets.token_hex(KEY_RANDOM_BYTES)
    hashed = _hash_key(raw)
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(_db_path()) as conn:
        cur = conn.execute(
            """
            INSERT INTO api_keys
                (key_hash, label, monthly_quota, month_bucket, requests_used, created_at)
            VALUES (?, ?, ?, ?, 0, ?)
            """,
            (hashed, label, monthly_quota, _current_month_bucket(), now),
        )
        conn.commit()
        key_id = cur.lastrowid
    return {
        "id": key_id,
        "key": raw,
        "label": label,
        "monthly_quota": monthly_quota,
        "created_at": now,
    }


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
                   created_at, last_used_at, disabled_at
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


def _require_admin(x_admin_token: Optional[str] = Header(None)) -> None:
    expected = os.environ.get(ADMIN_TOKEN_ENV)
    if not expected:
        raise HTTPException(
            status_code=503,
            detail=f"Admin endpoints disabled ({ADMIN_TOKEN_ENV} not set)",
        )
    if not x_admin_token or not secrets.compare_digest(x_admin_token, expected):
        raise HTTPException(status_code=401, detail="Invalid admin token")


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

router = APIRouter(prefix="/api/v1", tags=["v1"])


class CreateKeyRequest(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    monthly_quota: int = Field(default=DEFAULT_MONTHLY_QUOTA, ge=1, le=1_000_000)


class CreateKeyResponse(BaseModel):
    id: int
    key: str = Field(description="Full API key — only returned at creation")
    label: str
    monthly_quota: int
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


@router.post(
    "/admin/keys",
    response_model=CreateKeyResponse,
    summary="Issue a new API key (admin only)",
    dependencies=[Depends(_require_admin)],
)
def create_key_endpoint(req: CreateKeyRequest) -> Dict[str, Any]:
    return create_key(label=req.label, monthly_quota=req.monthly_quota)


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
    key: Dict[str, Any] = Depends(require_api_key),
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
    key: Dict[str, Any] = Depends(require_api_key),
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


@router.post(
    "/image/detect-watermarks",
    summary="Auto-detect watermarks/logos in an image (Gemini)",
    description="Returns bounding boxes for any watermarks Gemini finds. Useful as a pre-step before /image/inpaint.",
)
async def v1_detect_watermarks(
    image: UploadFile = File(...),
    key: Dict[str, Any] = Depends(require_api_key),
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
    key: Dict[str, Any] = Depends(require_api_key),
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
    key: Dict[str, Any] = Depends(require_api_key),
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
    key: Dict[str, Any] = Depends(require_api_key),
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


@router.get("/whoami", summary="Inspect the authenticated key")
async def v1_whoami(key: Dict[str, Any] = Depends(require_api_key)) -> Dict[str, Any]:
    """Useful smoke test: confirms the key works without consuming heavy quota."""
    return {
        "id": key["id"],
        "label": key["label"],
        "monthly_quota": key["monthly_quota"],
        "requests_used": key["requests_used"],
        "month_bucket": key["month_bucket"],
    }
