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

    def __init__(self, logo_dir: Optional[Path] = None, detector=None):
        # Optional WatermarkDetector for automatic region location.
        self.detector = detector

        # Check multiple possible logo locations
        # 1. Passed argument (highest priority)
        # 2. Environment variable
        # 3. Docker mount location (/app/assets/logos)
        # 4. Local dev: "Images & Logos" folder in project root
        # 5. Fallback: backend/assets/logos

        logo_dir_env = os.environ.get("LOGO_DIR", "")
        logo_paths = [
            logo_dir,
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

    @staticmethod
    def _escape_subtitles_path(path: str) -> str:
        """Escape a path for use inside the FFmpeg subtitles filter."""
        # Backslashes, then the filtergraph-special ':' and "'".
        return path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")

    async def _resolve_region(
        self, input_path: str, width: int, height: int, watermark_position: str, auto_detect: bool
    ) -> Dict[str, int]:
        """Pick the watermark region: auto-detected if possible, else heuristic."""
        if auto_detect and self.detector is not None and self.detector.has_templates():
            try:
                from config import settings
                found = await asyncio.to_thread(
                    self.detector.detect_in_video, input_path, settings.WATERMARK_SAMPLE_FRAMES
                )
                if found:
                    box = found[0]
                    pad = 4  # small pad so delogo fully covers the mark
                    return {
                        "x": max(0, int(box["x"]) - pad),
                        "y": max(0, int(box["y"]) - pad),
                        "w": min(width, int(box["w"]) + 2 * pad),
                        "h": min(height, int(box["h"]) + 2 * pad),
                    }
            except Exception as e:  # detection is best-effort; never block processing
                from config import settings  # noqa: F401
                import logging
                logging.getLogger(__name__).warning("Auto-detect failed, using heuristic: %s", e)
        return self._calculate_watermark_region(width, height, watermark_position)

    async def process(
        self,
        input_path: str,
        output_path: str,
        logo_preset: str = "lakeb2b",
        watermark_position: str = "bottom-right",
        auto_detect: bool = True,
        caption_srt_path: Optional[str] = None,
    ) -> Tuple[bool, Optional[str]]:
        """
        Process video to remove watermark and optionally add logo + captions.

        Args:
            input_path: Path to input video
            output_path: Path for output video
            logo_preset: Logo to add (lakeb2b, champions, ampliz, none)
            watermark_position: Fallback position when auto-detection is off/empty
            auto_detect: Locate the watermark automatically via template matching
            caption_srt_path: Optional .srt file to burn into the video

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

            # Resolve watermark region (auto-detected or heuristic)
            region = await self._resolve_region(
                input_path, width, height, watermark_position, auto_detect
            )

            # Optional burned-in subtitles, appended to whichever video chain runs.
            sub_filter = ""
            if caption_srt_path:
                sub_filter = f",subtitles='{self._escape_subtitles_path(caption_srt_path)}'"

            # Build FFmpeg command
            logo_path = self.get_logo_path(logo_preset)
            logo_position = self._get_logo_position(watermark_position)

            if logo_path:
                # Delogo + overlay new logo (+ optional captions)
                filter_complex = (
                    f"[0:v]delogo=x={region['x']}:y={region['y']}:w={region['w']}:h={region['h']}:show=0[delogoed];"
                    f"[1:v]scale=120:-1[logo];"
                    f"[delogoed][logo]overlay={logo_position}:format=auto{sub_filter}[out]"
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
                # Just delogo, no new logo overlay (+ optional captions)
                filter_complex = (
                    f"delogo=x={region['x']}:y={region['y']}:w={region['w']}:h={region['h']}:show=0{sub_filter}"
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
            
            from config import settings
            try:
                # Wait for process to complete with timeout
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(),
                    timeout=settings.PROCESS_TIMEOUT
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.communicate()
                return False, f"Processing timed out after {settings.PROCESS_TIMEOUT} seconds"

            if proc.returncode != 0:
                error_msg = stderr.decode()[-500:] if stderr else "Unknown error"
                return False, f"FFmpeg error: {error_msg}"

            # Verify output exists
            if not Path(output_path).exists():
                return False, "Output file was not created"

            return True, None

        except Exception as e:
            return False, str(e)
