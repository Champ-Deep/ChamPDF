"""
Video Logo Remover & Rebrander API
FastAPI backend for processing videos with FFmpeg
"""

import os
import uuid
import asyncio
import io
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
import aiofiles
import logging

from video_processor import VideoProcessor
from image_processor import ImageProcessor

logger = logging.getLogger(__name__)

app = FastAPI(
    title="Video Logo Remover API",
    description="Remove AI watermarks and rebrand videos with custom logos",
    version="1.0.0"
)

# CORS for frontend
# Environment-based configuration for security
allowed_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:8080").split(",")
allowed_origins = [origin.strip() for origin in allowed_origins]  # Clean whitespace

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,  # Configured via ALLOWED_ORIGINS env var
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Configuration
UPLOAD_DIR = Path("/tmp/video-rebrander/uploads")
OUTPUT_DIR = Path("/tmp/video-rebrander/outputs")
MAX_FILE_SIZE = 100 * 1024 * 1024  # 100MB
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".webm", ".avi"}

# Ensure directories exist
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Initialize processors
processor = VideoProcessor()
image_processor = ImageProcessor()


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

    Args:
        file: Image file (PNG, JPG, WebP, etc.)
        output_format: Output format (png, jpg, webp)

    Returns:
        Processed image with transparent background
    """
    # Validate file type
    allowed_types = ["image/png", "image/jpeg", "image/jpg", "image/webp"]
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type. Allowed: {', '.join(allowed_types)}"
        )

    # Read and validate file size (max 10MB)
    contents = await file.read()
    if len(contents) > 10 * 1024 * 1024:
        raise HTTPException(
            status_code=400,
            detail="File too large. Maximum size is 10MB."
        )

    try:
        # Process image
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
    file: UploadFile = File(...),
    logo_preset: str = Form("lakeb2b"),
    watermark_position: str = Form("bottom-right"),
):
    """
    Process a video to remove watermarks and optionally add a new logo.

    Args:
        file: Video file (MP4, MOV, WebM, AVI)
        logo_preset: Logo to overlay (lakeb2b, champions, ampliz, none)
        watermark_position: Where the original watermark is (bottom-right, bottom-left, top-right, top-left)

    Returns:
        Processed video file as streaming response
    """
    # Validate file extension
    file_ext = Path(file.filename or "").suffix.lower()
    if file_ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type. Allowed: {', '.join(ALLOWED_EXTENSIONS)}"
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
    input_path = UPLOAD_DIR / f"{job_id}{file_ext}"
    output_path = OUTPUT_DIR / f"{job_id}_processed.mp4"

    try:
        # Save uploaded file
        file_size = 0
        async with aiofiles.open(input_path, 'wb') as out_file:
            while chunk := await file.read(1024 * 1024):  # 1MB chunks
                file_size += len(chunk)
                if file_size > MAX_FILE_SIZE:
                    await out_file.close()
                    input_path.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=f"File too large. Maximum size: {MAX_FILE_SIZE // (1024*1024)}MB"
                    )
                await out_file.write(chunk)

        # Process video
        success, error = await processor.process(
            input_path=str(input_path),
            output_path=str(output_path),
            logo_preset=logo_preset,
            watermark_position=watermark_position,
        )

        if not success:
            raise HTTPException(status_code=500, detail=f"Processing failed: {error}")

        # Return processed file as streaming response
        def iterfile():
            with open(output_path, 'rb') as f:
                while chunk := f.read(1024 * 1024):
                    yield chunk
            # Cleanup after streaming
            input_path.unlink(missing_ok=True)
            output_path.unlink(missing_ok=True)

        # Get original filename for download
        original_name = Path(file.filename or "video").stem
        download_name = f"{original_name}_rebranded.mp4"

        return StreamingResponse(
            iterfile(),
            media_type="video/mp4",
            headers={
                "Content-Disposition": f'attachment; filename="{download_name}"'
            }
        )

    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        # Cleanup on error
        input_path.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")


@app.delete("/api/cleanup")
async def cleanup_temp_files():
    """Manual cleanup of temp files (for maintenance)"""
    import shutil
    try:
        shutil.rmtree(UPLOAD_DIR, ignore_errors=True)
        shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        return {"status": "cleaned"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
