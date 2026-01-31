"""
Video Logo Remover & Rebrander API
FastAPI backend for processing videos with FFmpeg
"""

import uuid
import io
import asyncio
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
    
    logger.info(f"Starting up... Concurrency limit set to {settings.MAX_CONCURRENT_JOBS}")
    
    # Pre-load/Check ML model connectivity
    try:
        # We can optionally trigger a dummy removal here to load model into memory
        # but rembg loads it lazily. We just log readiness.
        logger.info("Ready to accept connections.")
    except Exception as e:
        logger.warning(f"Startup warning: {e}")

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
