"""
Video Logo Remover & Rebrander API
FastAPI backend for processing videos with FFmpeg
"""

import uuid
import io
import asyncio
import os
import tempfile
import time
from collections import deque
from pathlib import Path
from typing import Deque, Dict, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, UploadFile, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
import aiofiles
import logging

from config import settings
from video_processor import VideoProcessor
from image_processor import ImageProcessor
from media_downloader import (
    MediaDownloadError,
    cleanup_work_dir,
    download_media,
)

logger = logging.getLogger(__name__)

# Global semaphore to limit concurrency
# We initialize it in lifespan to ensure event loop is ready
process_semaphore: Optional[asyncio.Semaphore] = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifecycle manager for the FastAPI app.
    Handles startup (model loading, semaphore init) and shutdown.
    """
    # Startup
    global process_semaphore
    process_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_JOBS)

    logger.info(f"Starting chamPDF backend...")
    logger.info(f"Concurrency limit: {settings.MAX_CONCURRENT_JOBS} jobs")
    logger.info(f"CORS origins: {settings.ALLOWED_ORIGINS}")

    # Verify U2Net model is cached
    model_cache = Path(os.getenv("U2NET_HOME", Path.home() / ".u2net"))
    model_file = model_cache / "u2net.onnx"

    if model_file.exists():
        size_mb = model_file.stat().st_size / (1024**2)
        logger.info(f"✅ U2Net model ready: {model_file} ({size_mb:.1f}MB)")
    else:
        logger.warning(f"⚠️  U2Net model not cached at: {model_file}")
        logger.warning("Model will download on first /api/remove-background request (~176MB)")

    logger.info("Backend startup complete - ready to accept connections")

    yield

    # Shutdown
    logger.info("Shutting down...")
    # Clean up temp directory on full shutdown (optional, careful in prod)
    # shutil.rmtree(settings.BASE_TEMP_DIR, ignore_errors=True)

app = FastAPI(
    title="Video Logo Remover API",
    description="Remove AI watermarks and rebrand videos with custom logos",
    version="1.0.0",
    lifespan=lifespan
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Initialize processors
processor = VideoProcessor(logo_dir=settings.LOGO_DIR)
image_processor = ImageProcessor()

# Allowed extensions
ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".avi"}

def cleanup_files(*files: Path):
    """Cleanup temporary files after response is sent."""
    for f in files:
        try:
            f.unlink(missing_ok=True)
            logger.debug(f"Deleted temporary file: {f}")
        except Exception as e:
            logger.error(f"Failed to delete {f}: {e}")

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "ffmpeg": processor.check_ffmpeg()}


@app.get("/api/presets")
async def get_presets():
    """Get available logo presets"""
    return {
        "presets": [
            {"id": "lakeb2b", "name": "LakeB2B", "available": processor.logo_exists("lakeb2b")},
            {"id": "champions", "name": "Champions Group", "available": processor.logo_exists("champions")},
            {"id": "ampliz", "name": "Ampliz", "available": processor.logo_exists("ampliz")},
            {"id": "none", "name": "Remove Only (No Logo)", "available": True},
        ]
    }


@app.post("/api/remove-background")
async def remove_background(
    file: UploadFile = File(...),
    output_format: str = Form("png")
):
    """
    Remove background from uploaded image using ML.
    Protected by concurrency semaphore.
    """
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    # Validate file type
    allowed_types = ["image/png", "image/jpeg", "image/jpg", "image/webp"]
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type. Allowed: {', '.join(allowed_types)}"
        )

    # Read and validate file size
    contents = await file.read()
    if len(contents) > settings.MAX_IMAGE_SIZE_MB * 1024 * 1024:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Maximum size is {settings.MAX_IMAGE_SIZE_MB}MB."
        )

    try:
        # Acquire semaphore to prevent OOM
        async with process_semaphore:
            logger.info(f"Removing background from {file.filename}")
            output_bytes = await image_processor.remove_background(
                contents,
                output_format=output_format
            )

        # Return processed image
        return StreamingResponse(
            io.BytesIO(output_bytes),
            media_type=f"image/{output_format}",
            headers={
                "Content-Disposition": f"attachment; filename={file.filename.rsplit('.', 1)[0]}_no_bg.{output_format}"
            }
        )

    except Exception as e:
        logger.error(f"Background removal error: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Processing failed: {str(e)}"
        )


@app.post("/api/process-video")
async def process_video(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    logo_preset: str = Form("lakeb2b"),
    watermark_position: str = Form("bottom-right"),
):
    """
    Process a video to remove watermarks and optionally add a new logo.
    Protected by concurrency semaphore.
    """
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    # Validate file extension
    file_ext = Path(file.filename or "").suffix.lower()
    if file_ext not in ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type. Allowed: {', '.join(ALLOWED_VIDEO_EXTENSIONS)}"
        )

    # Validate logo preset
    valid_presets = {"lakeb2b", "champions", "ampliz", "none"}
    if logo_preset not in valid_presets:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid logo preset. Allowed: {', '.join(valid_presets)}"
        )

    # Validate watermark position
    valid_positions = {"bottom-right", "bottom-left", "top-right", "top-left"}
    if watermark_position not in valid_positions:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid watermark position. Allowed: {', '.join(valid_positions)}"
        )

    # Generate unique filenames
    job_id = str(uuid.uuid4())
    input_path = settings.UPLOAD_DIR / f"{job_id}{file_ext}"
    output_path = settings.OUTPUT_DIR / f"{job_id}_processed.mp4"

    try:
        # Save uploaded file
        file_size = 0
        async with aiofiles.open(input_path, 'wb') as out_file:
            while chunk := await file.read(1024 * 1024):  # 1MB chunks
                file_size += len(chunk)
                if file_size > settings.MAX_FILE_SIZE:
                    # Cleanup immediately if file too large
                    await out_file.close()
                    cleanup_files(input_path)
                    raise HTTPException(
                        status_code=413,
                        detail=f"File too large. Maximum size: {settings.MAX_VIDEO_SIZE_MB}MB"
                    )
                await out_file.write(chunk)

        # Process video with concurrency limit
        async with process_semaphore:
            success, error = await processor.process(
                input_path=str(input_path),
                output_path=str(output_path),
                logo_preset=logo_preset,
                watermark_position=watermark_position,
            )

        if not success:
            # Cleanup input on failure
            cleanup_files(input_path)
            raise HTTPException(status_code=500, detail=f"Processing failed: {error}")

        # Schedule cleanup after response
        background_tasks.add_task(cleanup_files, input_path, output_path)

        # Get original filename for download
        original_name = Path(file.filename or "video").stem
        download_name = f"{original_name}_rebranded.mp4"

        return FileResponse(
            output_path,
            media_type="video/mp4",
            headers={
                "Content-Disposition": f'attachment; filename="{download_name}"'
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        # Cleanup on unexpected error
        cleanup_files(input_path, output_path)
        raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")


# ---------------------------------------------------------------------------
# URL → MP4/MP3 downloader
# ---------------------------------------------------------------------------

# Per-IP sliding-window rate limit for the URL downloader.
DOWNLOAD_RATE_LIMIT = 5         # requests
DOWNLOAD_RATE_WINDOW = 10 * 60  # seconds
# MP3 transcode adds ~2-3 minutes for a 30-min source; MP4 muxing is faster
# but the download itself can take longer for high-bitrate sources.
DOWNLOAD_TIMEOUT_MP3 = 8 * 60
DOWNLOAD_TIMEOUT_MP4 = 12 * 60

_download_buckets: Dict[str, Deque[float]] = {}


def _check_rate_limit(client_ip: str) -> None:
    now = time.monotonic()
    window_start = now - DOWNLOAD_RATE_WINDOW
    bucket = _download_buckets.setdefault(client_ip, deque())
    while bucket and bucket[0] < window_start:
        bucket.popleft()
    if len(bucket) >= DOWNLOAD_RATE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limited",
                "message": "Too many requests. Please wait a moment.",
            },
        )
    bucket.append(now)


class DownloadRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    format: str = Field(default="mp4")


@app.post("/api/download-from-url")
async def download_from_url(
    payload: DownloadRequest,
    request: Request,
    background_tasks: BackgroundTasks,
):
    """
    Download a video URL (YouTube, Instagram) as MP4 or MP3.
    Protected by concurrency semaphore and per-IP rate limit.
    """
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    url = payload.url.strip()
    fmt = payload.format.strip().lower()

    if not (url.startswith("http://") or url.startswith("https://")):
        return JSONResponse(
            status_code=400,
            content={
                "code": "unsupported_url",
                "message": "URL must start with http:// or https://.",
            },
        )

    if fmt not in ("mp4", "mp3"):
        return JSONResponse(
            status_code=400,
            content={
                "code": "unsupported_url",
                "message": "Format must be 'mp4' or 'mp3'.",
            },
        )

    client_ip = request.client.host if request.client else "unknown"
    try:
        _check_rate_limit(client_ip)
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content=e.detail)

    work_dir = Path(tempfile.mkdtemp(prefix="champdf_dl_", dir=settings.BASE_TEMP_DIR))
    timeout = DOWNLOAD_TIMEOUT_MP4 if fmt == "mp4" else DOWNLOAD_TIMEOUT_MP3

    try:
        async with process_semaphore:
            output_path, download_filename = await asyncio.wait_for(
                download_media(url, fmt, work_dir),
                timeout=timeout,
            )

        background_tasks.add_task(cleanup_work_dir, work_dir)

        media_type = "video/mp4" if fmt == "mp4" else "audio/mpeg"
        return FileResponse(
            output_path,
            media_type=media_type,
            headers={
                "Content-Disposition": f'attachment; filename="{download_filename}"'
            },
        )

    except MediaDownloadError as e:
        cleanup_work_dir(work_dir)
        return JSONResponse(
            status_code=e.status_code,
            content={"code": e.code, "message": e.message},
        )
    except asyncio.TimeoutError:
        cleanup_work_dir(work_dir)
        return JSONResponse(
            status_code=504,
            content={
                "code": "timeout",
                "message": "Download took too long and was cancelled.",
            },
        )
    except Exception as e:
        logger.exception("Unexpected URL download error: %s", e)
        cleanup_work_dir(work_dir)
        return JSONResponse(
            status_code=500,
            content={
                "code": "download_failed",
                "message": "Something went wrong. Please try again.",
            },
        )


@app.delete("/api/cleanup")
async def cleanup_temp_files():
    """Manual cleanup of temp files (for maintenance)"""
    import shutil
    try:
        shutil.rmtree(settings.BASE_TEMP_DIR, ignore_errors=True)
        # Re-create dirs
        settings.UPLOAD_DIR
        settings.OUTPUT_DIR
        return {"status": "cleaned"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=settings.HOST, port=settings.PORT)
