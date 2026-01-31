from pydantic_settings import BaseSettings
from pydantic import Field, model_validator
from pathlib import Path
import tempfile
import os

class Settings(BaseSettings):
    # App Config
    PORT: int = 8000
    HOST: str = "0.0.0.0"
    LOG_LEVEL: str = "INFO"

    # CORS - Support both list and comma-separated string from environment
    ALLOWED_ORIGINS: list[str] | str = Field(
        default=["http://localhost:5173", "http://localhost:8080"],
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

    class Config:
        env_file = ".env"
        case_sensitive = True

settings = Settings()
