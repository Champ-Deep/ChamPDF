from pydantic_settings import BaseSettings
from pydantic import Field, model_validator
from pathlib import Path
import tempfile
import os
from typing import Union, List

class Settings(BaseSettings):
    # App Config
    PORT: int = 8000
    HOST: str = "0.0.0.0"
    LOG_LEVEL: str = "INFO"

    # CORS - Support both list and comma-separated string from environment
    # Note: When using Nginx reverse proxy (Railway frontend service), CORS is
    # handled at the proxy level, so the backend only sees internal requests.
    # These defaults allow:
    #   - Local development (localhost)
    #   - Direct backend access from Railway frontend
    ALLOWED_ORIGINS: Union[List[str], str] = Field(
        default=[
            "http://localhost:5173",
            "http://localhost:5174",
            "http://localhost:5175",
            "http://localhost:8080",
            "http://localhost:8000",
            # Railway domains - update via ALLOWED_ORIGINS env var in Railway dashboard
            # Format: "https://champdf-production.up.railway.app,https://www.yourdomaincom"
        ],
        description="Allowed CORS origins (comma-separated string or list)"
    )
    
    # File Limits
    MAX_FILE_SIZE: int = 100 * 1024 * 1024  # 100MB
    MAX_VIDEO_SIZE_MB: int = 100
    MAX_IMAGE_SIZE_MB: int = 10
    
    # Resource Limits
    MAX_CONCURRENT_JOBS: int = 2  # Limit simultaneous heavy processing to prevent OOM
    HEALTH_CHECK_TIMEOUT: int = 10  # Quick health checks
    PROCESS_TIMEOUT: int = 300    # 5 minutes timeout for FFmpeg/ML tasks

    # ML / Device
    # "auto" uses CUDA when available and falls back to CPU. Force with "cpu"/"cuda".
    DEVICE: str = "auto"

    # LaMa inpainting (watermark / object removal)
    ENABLE_INPAINT: bool = True

    # faster-whisper captions: tiny | base | small | medium | large-v3
    WHISPER_MODEL_SIZE: str = "base"
    WHISPER_COMPUTE_TYPE: str = "int8"  # int8 is fast + low-memory on CPU
    ENABLE_CAPTIONS: bool = True

    # Real-ESRGAN upscaling
    ENABLE_UPSCALE: bool = True
    UPSCALE_MAX_SCALE: int = 4       # 2, 4, or 8 supported by the weights
    UPSCALE_MAX_PIXELS: int = 4_000_000  # reject huge inputs (OOM guard)

    # Watermark auto-detection (OpenCV template matching)
    WATERMARK_MATCH_THRESHOLD: float = 0.62  # 0-1; higher = stricter match
    WATERMARK_SAMPLE_FRAMES: int = 12        # frames sampled to locate a video watermark

    # LLM summaries via OpenRouter (set OPENROUTER_API_KEY in env to enable).
    # Powers the Video Downloader's transcript → AI summary step.
    OPENROUTER_MODEL: str = "openai/gpt-4o-mini"
    ENABLE_VIDEO_INSIGHTS: bool = True  # transcript + summary from a video URL

    # Multimodal YouTube analysis via Gemini (uses GEMINI_API_KEY).
    GEMINI_VIDEO_MODEL: str = "gemini-2.5-flash"

    # GPU video watermark removal (Video Rebrander "Best" quality).
    # Railway has no GPU, so the heavy inpainting is offloaded to an external
    # provider. "replicate" runs a hosted ProPainter model; "none" disables it.
    VIDEO_GPU_PROVIDER: str = "none"  # replicate | none
    # Replicate model slug (owner/name or owner/name:version) for video inpainting.
    REPLICATE_PROPAINTER_MODEL: str = "jd7h/propainter"
    # Seconds to wait for the external GPU job before giving up.
    GPU_VIDEO_TIMEOUT: int = 600
    # Reject offloading clips longer than this (cost guard). 0 = no cap.
    GPU_VIDEO_MAX_SECONDS: int = 120

    # Paths - Use system temp by default for better cross-platform support
    BASE_TEMP_DIR: Path = Path(tempfile.gettempdir()) / "champdf-backend"

    @model_validator(mode='after')
    def parse_origins(self) -> 'Settings':
        """Parse comma-separated CORS origins from environment variable"""
        if isinstance(self.ALLOWED_ORIGINS, str):
            self.ALLOWED_ORIGINS = [
                origin.strip()
                for origin in self.ALLOWED_ORIGINS.split(',')
                if origin.strip()
            ]
        return self
    
    @property
    def UPLOAD_DIR(self) -> Path:
        path = self.BASE_TEMP_DIR / "uploads"
        path.mkdir(parents=True, exist_ok=True)
        return path
        
    @property
    def OUTPUT_DIR(self) -> Path:
        path = self.BASE_TEMP_DIR / "outputs"
        path.mkdir(parents=True, exist_ok=True)
        return path

    # Assets
    LOGO_DIR: Path = Path(__file__).parent / "assets" / "logos"
    # Drop NotebookLM (and other) watermark reference PNGs here for auto-detection.
    WATERMARK_TEMPLATE_DIR: Path = Path(__file__).parent / "assets" / "watermark_templates"

    @property
    def torch_device(self) -> str:
        """Resolve DEVICE='auto' to an actual torch device string."""
        if self.DEVICE != "auto":
            return self.DEVICE
        try:
            import torch
            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"

    class Config:
        env_file = ".env"
        case_sensitive = True

settings = Settings()
