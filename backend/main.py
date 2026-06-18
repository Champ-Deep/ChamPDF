"""
Video Logo Remover & Rebrander API
FastAPI backend for processing videos with FFmpeg
"""

import uuid
import io
import asyncio
import os
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, UploadFile, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
import aiofiles
import logging

from config import settings
from video_processor import VideoProcessor
from image_processor import ImageProcessor
from inpaint_processor import InpaintProcessor
from upscale_processor import UpscaleProcessor
from caption_processor import CaptionProcessor
from watermark_detector import WatermarkDetector

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

# Initialize processors.
# Heavy ML models inside these are loaded lazily on first use, so construction is cheap.
_device = settings.torch_device
watermark_detector = WatermarkDetector(
    template_dir=settings.WATERMARK_TEMPLATE_DIR,
    threshold=settings.WATERMARK_MATCH_THRESHOLD,
)
processor = VideoProcessor(logo_dir=settings.LOGO_DIR, detector=watermark_detector)
image_processor = ImageProcessor()
inpaint_processor = InpaintProcessor(device=_device) if settings.ENABLE_INPAINT else None
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
    auto_detect: bool = Form(True),
    add_captions: bool = Form(False),
    caption_language: Optional[str] = Form(None),
):
    """
    Process a video to remove watermarks and optionally add a new logo + captions.

    - auto_detect: locate the NotebookLM/AI watermark automatically (falls back to
      `watermark_position` when no reference template matches).
    - add_captions: transcribe speech with Whisper and burn subtitles into the video.
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

        # Optionally generate captions (.srt) before the main FFmpeg pass.
        srt_path: Optional[Path] = None
        if add_captions:
            if not caption_processor:
                cleanup_files(input_path)
                raise HTTPException(status_code=400, detail="Captions are disabled on this server")
            async with process_semaphore:
                srt_text = await caption_processor.transcribe_video_to_srt(
                    str(input_path), language=caption_language
                )
            srt_path = settings.OUTPUT_DIR / f"{job_id}.srt"
            srt_path.write_text(srt_text, encoding="utf-8")

        # Process video with concurrency limit
        async with process_semaphore:
            success, error = await processor.process(
                input_path=str(input_path),
                output_path=str(output_path),
                logo_preset=logo_preset,
                watermark_position=watermark_position,
                auto_detect=auto_detect,
                caption_srt_path=str(srt_path) if srt_path else None,
            )

        if not success:
            # Cleanup input on failure
            cleanup_files(input_path, *( [srt_path] if srt_path else [] ))
            raise HTTPException(status_code=500, detail=f"Processing failed: {error}")

        # Schedule cleanup after response
        cleanup_targets = [input_path, output_path] + ([srt_path] if srt_path else [])
        background_tasks.add_task(cleanup_files, *cleanup_targets)

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


@app.get("/api/capabilities")
async def get_capabilities():
    """Report which AI features are enabled so the frontend can show/hide them."""
    return {
        "background_removal": True,
        "video_rebrand": True,
        "inpaint": inpaint_processor is not None,
        "upscale": upscale_processor is not None,
        "captions": caption_processor is not None,
        "watermark_autodetect": watermark_detector.has_templates(),
        "upscale_scales": sorted({2, 4, 8} & {settings.UPSCALE_MAX_SCALE, 2, 4}),
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
async def detect_watermark(file: UploadFile = File(...)):
    """Return detected watermark bounding boxes for an image (for preview / auto-fill)."""
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
    """
    Remove a watermark from an image with LaMa inpainting.

    Provide EITHER `regions` (JSON array of {x,y,w,h} pixel boxes from the UI
    selection) OR set `auto_detect=true` to locate a known watermark automatically.
    """
    import json
    import numpy as np
    import cv2

    if not inpaint_processor:
        raise HTTPException(status_code=400, detail="AI inpainting is disabled on this server")
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    contents = await _read_image_upload(file)

    boxes: list[dict] = []
    if regions:
        try:
            parsed = json.loads(regions)
            boxes = [
                {"x": int(b["x"]), "y": int(b["y"]), "w": int(b["w"]), "h": int(b["h"])}
                for b in parsed
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
            output = await inpaint_processor.inpaint_boxes(contents, boxes)
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
async def inpaint(file: UploadFile = File(...), mask: UploadFile = File(...)):
    """Generic inpainting: image + a 1-channel mask (white = remove)."""
    if not inpaint_processor:
        raise HTTPException(status_code=400, detail="AI inpainting is disabled on this server")
    if not process_semaphore:
        raise HTTPException(status_code=503, detail="Server initializing")

    image_bytes = await _read_image_upload(file)
    mask_bytes = await mask.read()
    try:
        async with process_semaphore:
            output = await inpaint_processor.inpaint(image_bytes, mask_bytes)
    except Exception as e:
        logger.error(f"Inpaint error: {e}")
        raise HTTPException(status_code=500, detail=f"Processing failed: {e}")

    base = (file.filename or "image").rsplit(".", 1)[0]
    return StreamingResponse(
        io.BytesIO(output),
        media_type="image/png",
        headers={"Content-Disposition": f"attachment; filename={base}_inpainted.png"},
    )


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

    # OOM guard: reject very large inputs (output grows by scale^2).
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
):
    """Transcribe a video's speech to an .srt subtitle file (Whisper)."""
    if not caption_processor:
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
            srt_text = await caption_processor.transcribe_video_to_srt(str(input_path), language=language)
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
