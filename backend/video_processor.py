"""
Video Processor - FFmpeg-based video processing for watermark removal and logo overlay
"""

import asyncio
import subprocess
import json
import os
from pathlib import Path
from typing import Tuple, Optional, Dict


class VideoProcessor:
    """Handles video processing using FFmpeg"""

    # Watermark regions by resolution (x, y, width, height)
    # These are approximate regions for NotebookLM and similar AI tool watermarks
    WATERMARK_REGIONS = {
        "720p": {"x": 1100, "y": 660, "w": 180, "h": 60},
        "1080p": {"x": 1700, "y": 1000, "w": 220, "h": 80},
        "480p": {"x": 700, "y": 440, "w": 140, "h": 40},
        "4k": {"x": 3600, "y": 2080, "w": 400, "h": 160},
    }

    def __init__(self):
        # Check multiple possible logo locations
        # 1. Environment variable (highest priority)
        # 2. Docker mount location (/app/assets/logos)
        # 3. Local dev: "Images & Logos" folder in project root
        # 4. Fallback: backend/assets/logos
        logo_dir_env = os.environ.get("LOGO_DIR", "")
        logo_paths = [
            Path(logo_dir_env) if logo_dir_env else None,
            Path("/app/assets/logos"),
            Path(__file__).parent.parent / "Images & Logos",
            Path(__file__).parent / "assets" / "logos",
        ]

        self.logo_dir = None
        for path in logo_paths:
            if path is not None and path.exists() and path.is_dir():
                self.logo_dir = path
                break

        # Fallback to default if none found
        if self.logo_dir is None:
            self.logo_dir = Path(__file__).parent / "assets" / "logos"
            self.logo_dir.mkdir(parents=True, exist_ok=True)

    def check_ffmpeg(self) -> bool:
        """Check if FFmpeg is available"""
        try:
            result = subprocess.run(
                ["ffmpeg", "-version"],
                capture_output=True,
                text=True,
                timeout=5
            )
            return result.returncode == 0
        except Exception:
            return False

    def logo_exists(self, preset: str) -> bool:
        """Check if a logo file exists for the given preset"""
        if preset == "none":
            return True
        logo_path = self.logo_dir / f"{preset}.png"
        return logo_path.exists()

    def get_logo_path(self, preset: str) -> Optional[Path]:
        """Get the path to a logo file"""
        if preset == "none":
            return None
        logo_path = self.logo_dir / f"{preset}.png"
        return logo_path if logo_path.exists() else None

    async def get_video_info(self, input_path: str) -> Dict:
        """Get video metadata using ffprobe"""
        cmd = [
            "ffprobe",
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            input_path
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()

        if proc.returncode != 0:
            return {}

        try:
            return json.loads(stdout.decode())
        except json.JSONDecodeError:
            return {}

    def _get_resolution_key(self, width: int, height: int) -> str:
        """Determine resolution key based on video dimensions"""
        if height >= 2160:
            return "4k"
        elif height >= 1080:
            return "1080p"
        elif height >= 720:
            return "720p"
        else:
            return "480p"

    def _calculate_watermark_region(
        self,
        width: int,
        height: int,
        position: str
    ) -> Dict[str, int]:
        """Calculate watermark region based on video size and position"""
        resolution = self._get_resolution_key(width, height)
        base_region = self.WATERMARK_REGIONS.get(resolution, self.WATERMARK_REGIONS["720p"])

        # Scale region based on actual dimensions
        scale_x = width / (3840 if resolution == "4k" else 1920 if resolution == "1080p" else 1280 if resolution == "720p" else 854)
        scale_y = height / (2160 if resolution == "4k" else 1080 if resolution == "1080p" else 720 if resolution == "720p" else 480)

        region_w = int(base_region["w"] * scale_x)
        region_h = int(base_region["h"] * scale_y)

        # Calculate position
        if position == "bottom-right":
            x = width - region_w - 20
            y = height - region_h - 20
        elif position == "bottom-left":
            x = 20
            y = height - region_h - 20
        elif position == "top-right":
            x = width - region_w - 20
            y = 20
        elif position == "top-left":
            x = 20
            y = 20
        else:
            # Default to bottom-right
            x = width - region_w - 20
            y = height - region_h - 20

        return {"x": max(0, x), "y": max(0, y), "w": region_w, "h": region_h}

    def _get_logo_position(self, position: str) -> str:
        """Get FFmpeg overlay position expression"""
        positions = {
            "bottom-right": "W-w-20:H-h-20",
            "bottom-left": "20:H-h-20",
            "top-right": "W-w-20:20",
            "top-left": "20:20",
        }
        return positions.get(position, positions["bottom-right"])

    async def process(
        self,
        input_path: str,
        output_path: str,
        logo_preset: str = "lakeb2b",
        watermark_position: str = "bottom-right",
    ) -> Tuple[bool, Optional[str]]:
        """
        Process video to remove watermark and optionally add logo.

        Args:
            input_path: Path to input video
            output_path: Path for output video
            logo_preset: Logo to add (lakeb2b, champions, ampliz, none)
            watermark_position: Position of original watermark

        Returns:
            Tuple of (success, error_message)
        """
        try:
            # Get video info
            info = await self.get_video_info(input_path)
            if not info:
                return False, "Could not read video metadata"

            # Find video stream
            video_stream = None
            for stream in info.get("streams", []):
                if stream.get("codec_type") == "video":
                    video_stream = stream
                    break

            if not video_stream:
                return False, "No video stream found"

            width = video_stream.get("width", 1280)
            height = video_stream.get("height", 720)

            # Calculate watermark region
            region = self._calculate_watermark_region(width, height, watermark_position)

            # Build FFmpeg command
            logo_path = self.get_logo_path(logo_preset)
            logo_position = self._get_logo_position(watermark_position)

            if logo_path:
                # Delogo + overlay new logo
                filter_complex = (
                    f"[0:v]delogo=x={region['x']}:y={region['y']}:w={region['w']}:h={region['h']}:show=0[delogoed];"
                    f"[1:v]scale=120:-1[logo];"
                    f"[delogoed][logo]overlay={logo_position}:format=auto[out]"
                )
                cmd = [
                    "ffmpeg",
                    "-y",  # Overwrite output
                    "-i", input_path,
                    "-i", str(logo_path),
                    "-filter_complex", filter_complex,
                    "-map", "[out]",
                    "-map", "0:a?",  # Include audio if present
                    "-c:v", "libx264",
                    "-crf", "18",
                    "-preset", "fast",
                    "-c:a", "copy",
                    "-movflags", "+faststart",
                    output_path
                ]
            else:
                # Just delogo, no new logo overlay
                filter_complex = (
                    f"delogo=x={region['x']}:y={region['y']}:w={region['w']}:h={region['h']}:show=0"
                )
                cmd = [
                    "ffmpeg",
                    "-y",
                    "-i", input_path,
                    "-vf", filter_complex,
                    "-c:v", "libx264",
                    "-crf", "18",
                    "-preset", "fast",
                    "-c:a", "copy",
                    "-movflags", "+faststart",
                    output_path
                ]

            # Run FFmpeg
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()

            if proc.returncode != 0:
                error_msg = stderr.decode()[-500:] if stderr else "Unknown error"
                return False, f"FFmpeg error: {error_msg}"

            # Verify output exists
            if not Path(output_path).exists():
                return False, "Output file was not created"

            return True, None

        except Exception as e:
            return False, str(e)
