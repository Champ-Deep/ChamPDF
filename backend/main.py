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
from inpaint_processor import (
    DetectError,
    EditError,
    InpaintError,
    detect_watermarks,
    edit_image_with_prompt,
    inpaint_image,
)
from api_v1 import (
    init_db as init_v1_db,
    router as api_v1_router,
    self_serve_keys_available,
)

# Self-hosted AI engine (our branch): LaMa inpainting, OpenCV template watermark
# detection, faster-whisper captions, Real-ESRGAN upscaling. These run locally and
# require no API key (Gemini above stays optional, e.g. for Edit Banana).
from lama_processor import InpaintProcessor
from caption_processor import CaptionProcessor
from upscale_processor import UpscaleProcessor
from watermark_detector import WatermarkDetector
from summarizer import (
    summarize_transcript,
    summary_available,
    SUGGESTED_MODELS,
    SummarizeError,
)
from video_analyzer import analyze_youtube, analyze_available, is_youtube_url, AnalyzeError
from gpu_video_remover import gpu_removal_available
from video_matte import matte_video, matte_available
from gpu_transcribe import transcribe as gpu_transcribe, gpu_transcribe_available
from replicate_client import ReplicateError
from ocr_processor import ocr_pdf, ocr_available, OcrError
from pdf_signer import sign_pdf, verify_pdf, sign_available, default_tsa_url, SignError
from table_extractor import extract_tables, table_extraction_available, TableExtractionError

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

    # v1 public API key store
    try:
        init_v1_db()
        logger.info("✅ v1 API key store initialized")
    except Exception as e:
        logger.warning(f"v1 API key store init failed: {e}")

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

# Public versioned API (API-key auth)
app.include_router(api_v1_router)

# Initialize processors
processor = VideoProcessor(logo_dir=settings.LOGO_DIR)
image_processor = ImageProcessor()

# Self-hosted AI engines (heavy models load lazily on first use, so this is cheap).
_device = settings.torch_device
watermark_detector = WatermarkDetector(
    template_dir=settings.WATERMARK_TEMPLATE_DIR,
    threshold=settings.WATERMARK_MATCH_THRESHOLD,
)
lama_processor = InpaintProcessor(device=_device) if settings.ENABLE_INPAINT else None
upscale_processor = UpscaleProcessor(device=_device) if settings.ENABLE_UPSCALE else None
caption_processor = (
    CaptionProcessor(
        model_size=settings.WHISPER_MODEL_SIZE,
        compute_type=settings.WHISPER_COMPUTE_TYPE,
        device=_device,
    )
    if settings.ENABLE_CAPTIONS
    else None
)

# Allowed extensions
ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".avi"}
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/webp"}

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
    try:
        import cv2
        opencv_available = True
    except ImportError:
        opencv_available = False

    try:
        from propainter_wrapper import is_available as pp_available, get_status as pp_status
        propainter_info = {"available": pp_available(), "status": pp_status()}
    except Exception:
        propainter_info = {"available": False, "status": "module not loaded"}

    return {
        "status": "healthy",
        "ffmpeg": processor.check_ffmpeg(),
        "opencv_inpaint": opencv_available,
        "propainter": propainter_info,
    }


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
    logo_scale: float = Form(1.0),
    quality: str = Form("fast"),
):
    """
    Process a video to remove watermarks and optionally add a new logo.
    Protected by concurrency semaphore.

    quality: "fast" (local CPU inpaint) or "best" (external GPU offload via
    ProPainter, with automatic fallback to CPU when unavailable).
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

    # Clamp logo_scale to a sane range; 0.5x to 2.0x of default size.
    if not 0.5 <= logo_scale <= 2.0:
        raise HTTPException(
            status_code=400,
            detail="logo_scale must be between 0.5 and 2.0"
        )

    # Validate removal quality
    if quality not in {"fast", "best"}:
        raise HTTPException(
            status_code=400,
            detail="quality must be 'fast' or 'best'"
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
                logo_scale=logo_scale,
                quality=quality,
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


@app.post("/api/inpaint-image")
async def inpaint_image_endpoint(
    image: UploadFile = File(...),
    mask: UploadFile = File(...),
    prompt: Optional[str] = Form(None),
    radius: int = Form(5),
):
    """
    Inpaint masked regions of an image using Gemini's image-editing model
    (with an OpenCV Telea fallback if Gemini is unavailable). Used by the
    PDF Watermark Remover for higher-quality results than client-side OpenCV.
    """
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    image_bytes = await image.read()
    mask_bytes = await mask.read()

    if not image_bytes or not mask_bytes:
        raise HTTPException(status_code=400, detail="image and mask are required")

    # Sanity: cap image size at 20MB to avoid abusive uploads
    if len(image_bytes) > 20 * 1024 * 1024 or len(mask_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image or mask too large (20MB max)")

    try:
        async with process_semaphore:
            result_png = await inpaint_image(
                image_bytes=image_bytes,
                mask_bytes=mask_bytes,
                prompt=prompt,
                radius=radius,
            )
    except InpaintError as e:
        raise HTTPException(status_code=502, detail=str(e))

    return StreamingResponse(
        io.BytesIO(result_png),
        media_type="image/png",
        headers={"Content-Disposition": 'inline; filename="inpainted.png"'},
    )


@app.post("/api/detect-watermarks")
async def detect_watermarks_endpoint(
    image: UploadFile = File(...),
):
    """
    Auto-detect watermarks/logos in an image. Returns a JSON array of
    bounding boxes the frontend can pre-populate the selection state
    with. Used by the PDF Watermark Remover's "Auto-detect" button.
    """
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="image is required")
    if len(image_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (20MB max)")

    try:
        async with process_semaphore:
            boxes = await detect_watermarks(image_bytes)
    except DetectError as e:
        msg = str(e)
        status = 503 if "not set" in msg or "not configured" in msg else 502
        raise HTTPException(status_code=status, detail=msg)

    return {"watermarks": boxes}


@app.post("/api/edit-image")
async def edit_image_endpoint(
    image: UploadFile = File(...),
    prompt: str = Form(...),
):
    """
    Prompt-based image editor backed by Gemini's image-editing model
    (the "Edit Banana" tool). Multipart form: `image` (PNG/JPEG) +
    `prompt` (text). Returns PNG.
    """
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="image is required")
    if len(image_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (20MB max)")

    try:
        async with process_semaphore:
            result_png = await edit_image_with_prompt(
                image_bytes=image_bytes, prompt=prompt
            )
    except EditError as e:
        # 503 if the server is just not configured; 422 if the user input
        # was the problem; 502 for an actual upstream failure.
        msg = str(e)
        if "not configured" in msg:
            raise HTTPException(status_code=503, detail=msg)
        if "Prompt" in msg or "prompt is required" in msg.lower():
            raise HTTPException(status_code=422, detail=msg)
        raise HTTPException(status_code=502, detail=msg)

    return StreamingResponse(
        io.BytesIO(result_png),
        media_type="image/png",
        headers={"Content-Disposition": 'inline; filename="edited.png"'},
    )


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


# ─────────────────────────────────────────────────────────────────────────────
# Self-hosted AI engine endpoints (LaMa inpainting, template detection,
# Whisper captions, Real-ESRGAN upscaling). No API key required.
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/capabilities")
async def get_capabilities():
    """Report which self-hosted AI features are enabled (frontend show/hide)."""
    return {
        "background_removal": True,
        "video_rebrand": True,
        "inpaint": lama_processor is not None,
        "upscale": upscale_processor is not None,
        "captions": caption_processor is not None,
        "watermark_autodetect": watermark_detector.has_templates(),
        "gemini_inpaint": bool(os.environ.get("GEMINI_API_KEY")),
        "video_transcript": caption_processor is not None,
        "video_summary": summary_available(),
        "video_analyze": analyze_available(),
        "gpu_video": gpu_removal_available(),
        "video_matte": matte_available(),
        "captions_gpu": gpu_transcribe_available(),
        "ocr_server": ocr_available(),
        "pdf_sign_advanced": sign_available(),
        "pdf_verify": sign_available(),
        "table_extraction": table_extraction_available(),
        "api_self_serve_keys": self_serve_keys_available(),
        "summary_models": SUGGESTED_MODELS,
    }


async def _read_image_upload(file: UploadFile) -> bytes:
    """Validate + read an uploaded image within the configured size limit."""
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type. Allowed: {', '.join(sorted(ALLOWED_IMAGE_TYPES))}",
        )
    contents = await file.read()
    if len(contents) > settings.MAX_IMAGE_SIZE_MB * 1024 * 1024:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Maximum size is {settings.MAX_IMAGE_SIZE_MB}MB.",
        )
    return contents


@app.post("/api/detect-watermark")
async def detect_watermark_template(file: UploadFile = File(...)):
    """Locate watermark boxes via OpenCV template matching (self-hosted, no key)."""
    import numpy as np
    import cv2

    contents = await _read_image_upload(file)
    arr = cv2.imdecode(np.frombuffer(contents, np.uint8), cv2.IMREAD_COLOR)
    if arr is None:
        raise HTTPException(status_code=400, detail="Could not decode image")
    boxes = await asyncio.to_thread(watermark_detector.detect, arr)
    return {"detections": boxes, "has_templates": watermark_detector.has_templates()}


@app.post("/api/remove-image-watermark")
async def remove_image_watermark(
    file: UploadFile = File(...),
    regions: Optional[str] = Form(None),
    auto_detect: bool = Form(False),
):
    """Remove an image watermark with LaMa inpainting (self-hosted)."""
    import json
    import numpy as np
    import cv2

    if not lama_processor:
        raise HTTPException(status_code=400, detail="AI inpainting is disabled on this server")
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    contents = await _read_image_upload(file)

    boxes: list = []
    if regions:
        try:
            boxes = [
                {"x": int(b["x"]), "y": int(b["y"]), "w": int(b["w"]), "h": int(b["h"])}
                for b in json.loads(regions)
            ]
        except (ValueError, KeyError, TypeError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid regions JSON: {e}")
    elif auto_detect:
        arr = cv2.imdecode(np.frombuffer(contents, np.uint8), cv2.IMREAD_COLOR)
        if arr is None:
            raise HTTPException(status_code=400, detail="Could not decode image")
        detections = await asyncio.to_thread(watermark_detector.detect, arr)
        boxes = [{"x": d["x"], "y": d["y"], "w": d["w"], "h": d["h"]} for d in detections]

    if not boxes:
        raise HTTPException(
            status_code=400,
            detail="No watermark region. Draw a selection or enable auto-detect with a template installed.",
        )

    try:
        async with process_semaphore:
            output = await lama_processor.inpaint_boxes(contents, boxes)
    except Exception as e:
        logger.error(f"Inpaint error: {e}")
        raise HTTPException(status_code=500, detail=f"Processing failed: {e}")

    base = (file.filename or "image").rsplit(".", 1)[0]
    return StreamingResponse(
        io.BytesIO(output),
        media_type="image/png",
        headers={"Content-Disposition": f"attachment; filename={base}_no_watermark.png"},
    )


@app.post("/api/inpaint")
async def inpaint_with_mask(file: UploadFile = File(...), mask: UploadFile = File(...)):
    """Generic LaMa inpainting: image + 1-channel mask (white = remove)."""
    if not lama_processor:
        raise HTTPException(status_code=400, detail="AI inpainting is disabled on this server")
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    image_bytes = await _read_image_upload(file)
    mask_bytes = await mask.read()
    try:
        async with process_semaphore:
            output = await lama_processor.inpaint(image_bytes, mask_bytes)
    except Exception as e:
        logger.error(f"Inpaint error: {e}")
        raise HTTPException(status_code=500, detail=f"Processing failed: {e}")

    base = (file.filename or "image").rsplit(".", 1)[0]
    return StreamingResponse(
        io.BytesIO(output),
        media_type="image/png",
        headers={"Content-Disposition": f"attachment; filename={base}_inpainted.png"},
    )


@app.post("/api/ocr-pdf")
async def ocr_pdf_endpoint(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    language: str = Form("eng"),
    pdfa: bool = Form(True),
):
    """Server-side OCR (OCRmyPDF) → searchable / PDF-A PDF."""
    if not ocr_available():
        raise HTTPException(status_code=400, detail="Server OCR is not configured on this server")
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    contents = await file.read()
    if len(contents) > settings.MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large")
    try:
        async with process_semaphore:
            output = await ocr_pdf(contents, language=language, pdfa=pdfa)
    except OcrError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"OCR error: {e}")
        raise HTTPException(status_code=500, detail=f"OCR failed: {e}")

    base = (file.filename or "document").rsplit(".", 1)[0]
    return StreamingResponse(
        io.BytesIO(output),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{base}_ocr.pdf"'},
    )


@app.post("/api/sign-pdf")
async def sign_pdf_endpoint(
    file: UploadFile = File(...),
    cert: UploadFile = File(...),
    passphrase: str = Form(""),
    reason: Optional[str] = Form(None),
    location: Optional[str] = Form(None),
    field_name: str = Form("Signature1"),
    timestamp: bool = Form(True),
):
    """Cryptographically sign a PDF (PAdES, optional TSA timestamp) via pyHanko."""
    if not sign_available():
        raise HTTPException(status_code=400, detail="PDF signing is not enabled on this server")
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    pdf_bytes = await file.read()
    p12_bytes = await cert.read()
    if len(pdf_bytes) > settings.MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large")

    tsa = default_tsa_url() if timestamp else None
    try:
        async with process_semaphore:
            output = await sign_pdf(
                pdf_bytes, p12_bytes, passphrase,
                field_name=field_name, reason=reason, location=location, tsa_url=tsa,
            )
    except SignError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Sign error: {e}")
        raise HTTPException(status_code=500, detail=f"Signing failed: {e}")

    base = (file.filename or "document").rsplit(".", 1)[0]
    return StreamingResponse(
        io.BytesIO(output),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{base}_signed.pdf"'},
    )


@app.post("/api/verify-signature")
async def verify_signature_endpoint(file: UploadFile = File(...)):
    """Verify the signatures in a PDF → integrity / signer report (pyHanko)."""
    if not sign_available():
        raise HTTPException(status_code=400, detail="Signature verification is not enabled on this server")
    pdf_bytes = await file.read()
    try:
        return await verify_pdf(pdf_bytes)
    except SignError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Verify error: {e}")
        raise HTTPException(status_code=500, detail=f"Verification failed: {e}")


@app.post("/api/upscale-image")
async def upscale_image(
    file: UploadFile = File(...),
    scale: int = Form(4),
    output_format: str = Form("png"),
):
    """Upscale an image with Real-ESRGAN (2x / 4x)."""
    if not upscale_processor:
        raise HTTPException(status_code=400, detail="Upscaling is disabled on this server")
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")
    if scale > settings.UPSCALE_MAX_SCALE:
        raise HTTPException(status_code=400, detail=f"Max scale is {settings.UPSCALE_MAX_SCALE}x")

    contents = await _read_image_upload(file)
    from PIL import Image
    with Image.open(io.BytesIO(contents)) as probe:
        if probe.width * probe.height > settings.UPSCALE_MAX_PIXELS:
            raise HTTPException(
                status_code=400,
                detail=f"Image too large to upscale (>{settings.UPSCALE_MAX_PIXELS // 1_000_000}MP).",
            )

    try:
        async with process_semaphore:
            output = await upscale_processor.upscale(contents, scale=scale, output_format=output_format)
    except Exception as e:
        logger.error(f"Upscale error: {e}")
        raise HTTPException(status_code=500, detail=f"Processing failed: {e}")

    base = (file.filename or "image").rsplit(".", 1)[0]
    ext = "png" if output_format.lower() == "png" else "jpg"
    return StreamingResponse(
        io.BytesIO(output),
        media_type=f"image/{ext}",
        headers={"Content-Disposition": f"attachment; filename={base}_upscaled_{scale}x.{ext}"},
    )


@app.post("/api/transcribe-video")
async def transcribe_video(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    engine: str = Form("auto"),
):
    """Transcribe a video's speech to an .srt subtitle file.

    engine: "cpu" (local faster-whisper), "gpu" (hosted Whisper large-v3 via
    Replicate or Groq, per VIDEO_GPU_PROVIDER), or "auto" (GPU when configured,
    else CPU).
    """
    if engine not in {"auto", "cpu", "gpu"}:
        raise HTTPException(status_code=400, detail="engine must be auto, cpu, or gpu")
    use_gpu = engine in ("auto", "gpu") and gpu_transcribe_available()
    if engine == "gpu" and not use_gpu:
        raise HTTPException(status_code=400, detail="GPU transcription is not configured on this server")
    if not use_gpu and not caption_processor:
        raise HTTPException(status_code=400, detail="Captions are disabled on this server")
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    file_ext = Path(file.filename or "").suffix.lower()
    if file_ext not in ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type. Allowed: {', '.join(ALLOWED_VIDEO_EXTENSIONS)}",
        )

    job_id = str(uuid.uuid4())
    input_path = settings.UPLOAD_DIR / f"{job_id}{file_ext}"
    file_size = 0
    async with aiofiles.open(input_path, "wb") as out_file:
        while chunk := await file.read(1024 * 1024):
            file_size += len(chunk)
            if file_size > settings.MAX_FILE_SIZE:
                await out_file.close()
                cleanup_files(input_path)
                raise HTTPException(status_code=413, detail="File too large")
            await out_file.write(chunk)

    try:
        async with process_semaphore:
            if use_gpu:
                try:
                    result = await gpu_transcribe(str(input_path), language=language)
                    srt_text = result["srt"]
                except ReplicateError as ge:
                    if engine == "gpu" or not caption_processor:
                        raise
                    logger.warning("GPU transcription failed, falling back to CPU: %s", ge)
                    srt_text = await caption_processor.transcribe_video_to_srt(str(input_path), language=language)
            else:
                srt_text = await caption_processor.transcribe_video_to_srt(str(input_path), language=language)
    except HTTPException:
        raise
    except Exception as e:
        cleanup_files(input_path)
        logger.error(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

    background_tasks.add_task(cleanup_files, input_path)
    base = Path(file.filename or "video").stem
    return StreamingResponse(
        io.BytesIO(srt_text.encode("utf-8")),
        media_type="application/x-subrip",
        headers={"Content-Disposition": f'attachment; filename="{base}.srt"'},
    )


@app.post("/api/video-matte")
async def video_matte_endpoint(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    mode: str = Form("green"),
):
    """Remove a video's background via Robust Video Matting (GPU, Replicate).

    mode: green (green-screen), alpha (grayscale matte), foreground (on black).
    """
    if not matte_available():
        raise HTTPException(
            status_code=400,
            detail="Video background removal is not configured on this server",
        )
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")
    if mode not in {"green", "alpha", "foreground"}:
        raise HTTPException(status_code=400, detail="mode must be green, alpha, or foreground")

    file_ext = Path(file.filename or "").suffix.lower()
    if file_ext not in ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type. Allowed: {', '.join(ALLOWED_VIDEO_EXTENSIONS)}",
        )

    job_id = str(uuid.uuid4())
    input_path = settings.UPLOAD_DIR / f"{job_id}{file_ext}"
    file_size = 0
    async with aiofiles.open(input_path, "wb") as out_file:
        while chunk := await file.read(1024 * 1024):
            file_size += len(chunk)
            if file_size > settings.MAX_FILE_SIZE:
                await out_file.close()
                cleanup_files(input_path)
                raise HTTPException(status_code=413, detail="File too large")
            await out_file.write(chunk)

    try:
        async with process_semaphore:
            output = await matte_video(str(input_path), mode=mode)
    except ReplicateError as e:
        cleanup_files(input_path)
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        cleanup_files(input_path)
        logger.error(f"Video matte error: {e}")
        raise HTTPException(status_code=500, detail=f"Background removal failed: {e}")

    background_tasks.add_task(cleanup_files, input_path)
    base = Path(file.filename or "video").stem
    return StreamingResponse(
        io.BytesIO(output),
        media_type="video/mp4",
        headers={"Content-Disposition": f'attachment; filename="{base}_no_bg.mp4"'},
    )


class VideoInsightsRequest(BaseModel):
    url: str
    transcript: bool = True
    summary: bool = False
    multimodal: bool = False  # analyze the video itself (Gemini) for YouTube links
    language: Optional[str] = None
    model: Optional[str] = None


def _srt_to_text(srt: str) -> str:
    """Strip SRT indices + timestamps down to plain transcript text."""
    out = []
    for block in (srt or "").strip().split("\n\n"):
        rows = [
            r.strip()
            for r in block.splitlines()
            if "-->" not in r and not r.strip().isdigit() and r.strip()
        ]
        if rows:
            out.append(" ".join(rows))
    return "\n".join(out)


@app.post("/api/video-insights")
async def video_insights(
    payload: VideoInsightsRequest,
    request: Request,
    background_tasks: BackgroundTasks,
):
    """
    Take a video URL → download audio → transcribe (Whisper) → optional AI
    summary (OpenRouter). Returns JSON { transcript, srt, summary?, model? }.
    """
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    url = payload.url.strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        return JSONResponse(
            status_code=400,
            content={"code": "unsupported_url", "message": "URL must start with http:// or https://."},
        )

    client_ip = request.client.host if request.client else "unknown"
    try:
        _check_rate_limit(client_ip)
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content=e.detail)

    # Multimodal path: hand the YouTube URL straight to Gemini (no download).
    if payload.multimodal and is_youtube_url(url) and analyze_available():
        try:
            async with process_semaphore:
                analysis = await analyze_youtube(url, payload.model)
            return {
                "source": "gemini",
                "summary": analysis["summary"],
                "learnings": analysis["learnings"],
                "chapters": analysis["chapters"],
            }
        except AnalyzeError as e:
            # Fall through to the Whisper path so the user still gets something.
            logger.warning("Gemini analyze failed, falling back to Whisper: %s", e)

    # Whisper path needs the caption processor.
    if not caption_processor:
        return JSONResponse(
            status_code=400,
            content={"code": "disabled", "message": "Transcription is disabled on this server."},
        )
    # When summary/learnings were requested, we still want a text summary here.
    want_summary = payload.summary or payload.multimodal
    if want_summary and not summary_available():
        if payload.multimodal:
            # Multimodal asked but neither Gemini nor OpenRouter is configured.
            return JSONResponse(
                status_code=400,
                content={
                    "code": "analyze_unavailable",
                    "message": "Video analysis needs GEMINI_API_KEY (or OPENROUTER_API_KEY/GROQ_API_KEY for a text summary).",
                },
            )
        return JSONResponse(
            status_code=400,
            content={
                "code": "summary_unavailable",
                "message": "AI summary needs OPENROUTER_API_KEY or GROQ_API_KEY set on the server.",
            },
        )

    work_dir = Path(tempfile.mkdtemp(prefix="champdf_ins_", dir=settings.BASE_TEMP_DIR))
    background_tasks.add_task(cleanup_work_dir, work_dir)
    try:
        async with process_semaphore:
            # Audio-only download is faster than full video for transcription.
            audio_path, _ = await asyncio.wait_for(
                download_media(url, "mp3", work_dir),
                timeout=DOWNLOAD_TIMEOUT_MP3,
            )
            srt = await caption_processor.transcribe_video_to_srt(
                str(audio_path), language=payload.language
            )

        transcript_text = _srt_to_text(srt)
        result = {"source": "whisper", "transcript": transcript_text, "srt": srt}

        if want_summary:
            result["summary"] = await asyncio.to_thread(
                summarize_transcript, transcript_text, payload.model
            )
            result["model"] = payload.model or settings.OPENROUTER_MODEL

        return result
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=504,
            content={"code": "timeout", "message": "Processing took too long and was cancelled."},
        )
    except MediaDownloadError as e:
        return JSONResponse(status_code=e.status_code, content={"code": e.code, "message": e.message})
    except SummarizeError as e:
        return JSONResponse(status_code=502, content={"code": "summary_failed", "message": str(e)})
    except Exception as e:
        logger.error(f"Video insights error: {e}")
        return JSONResponse(
            status_code=500,
            content={"code": "failed", "message": str(e)[:200] or "Processing failed."},
        )


@app.post("/api/extract-tables")
async def extract_tables_endpoint(file: UploadFile = File(...)):
    """Find tables in a PDF (PyMuPDF find_tables — no client-side equivalent
    in mupdf.js). Powers extract-tables, pdf-to-csv, pdf-to-excel."""
    if not table_extraction_available():
        raise HTTPException(status_code=400, detail="Server table extraction is not configured on this server")
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    contents = await file.read()
    if len(contents) > settings.MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large")
    try:
        async with process_semaphore:
            tables = await extract_tables(contents)
    except TableExtractionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Table extraction error: {e}")
        raise HTTPException(status_code=500, detail=f"Table extraction failed: {e}")

    return {"tables": tables}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=settings.HOST, port=settings.PORT)
