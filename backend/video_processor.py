"""
Video Processor - Video processing for watermark removal and logo overlay.
Uses OpenCV inpainting for high-quality logo removal when available,
falls back to FFmpeg delogo filter otherwise.
"""

import asyncio
import subprocess
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Tuple, Optional, Dict

logger = logging.getLogger(__name__)

# Try to import OpenCV for high-quality inpainting
try:
    import cv2
    import numpy as np
    HAS_OPENCV = True
except ImportError:
    HAS_OPENCV = False


class VideoProcessor:
    """Handles video processing using OpenCV inpainting + FFmpeg"""

    # Watermark regions by resolution (x, y, width, height)
    # These are approximate regions for NotebookLM and similar AI tool watermarks
    WATERMARK_REGIONS = {
        "720p": {"x": 1100, "y": 660, "w": 180, "h": 60},
        "1080p": {"x": 1700, "y": 1000, "w": 220, "h": 80},
        "480p": {"x": 700, "y": 440, "w": 140, "h": 40},
        "4k": {"x": 3600, "y": 2080, "w": 400, "h": 160},
    }

    def __init__(self, logo_dir: Optional[Path] = None):
        # Check multiple possible logo locations
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
        ref_widths = {"4k": 3840, "1080p": 1920, "720p": 1280, "480p": 854}
        ref_heights = {"4k": 2160, "1080p": 1080, "720p": 720, "480p": 480}
        scale_x = width / ref_widths.get(resolution, 1280)
        scale_y = height / ref_heights.get(resolution, 720)

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

    def _create_inpaint_mask(
        self,
        width: int,
        height: int,
        region: Dict[str, int],
        feather_px: int = 6
    ) -> "np.ndarray":
        """Create a binary mask for the watermark region with soft feathered edges."""
        mask = np.zeros((height, width), dtype=np.uint8)

        x, y, w, h = region["x"], region["y"], region["w"], region["h"]

        # Expand region slightly for better coverage
        pad = 4
        x1 = max(0, x - pad)
        y1 = max(0, y - pad)
        x2 = min(width, x + w + pad)
        y2 = min(height, y + h + pad)

        mask[y1:y2, x1:x2] = 255

        # Apply Gaussian blur for soft edges (helps inpainting blend naturally)
        if feather_px > 0:
            ksize = feather_px * 2 + 1
            mask = cv2.GaussianBlur(mask, (ksize, ksize), 0)
            # Re-threshold to keep solid center but soft edges
            _, mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)

        return mask

    def _inpaint_frame(
        self,
        frame: "np.ndarray",
        mask: "np.ndarray",
        radius: int = 5
    ) -> "np.ndarray":
        """Inpaint a single frame using OpenCV's Navier-Stokes method.

        Uses INPAINT_NS (Navier-Stokes) which produces smoother results
        for small regions like logos compared to INPAINT_TELEA.
        A second TELEA pass refines the result for cleaner blending.
        """
        # First pass: Navier-Stokes (smooth, good for texture continuation)
        result = cv2.inpaint(frame, mask, radius, cv2.INPAINT_NS)

        # Second pass: TELEA (better edge handling) with smaller radius
        result = cv2.inpaint(result, mask, max(2, radius // 2), cv2.INPAINT_TELEA)

        return result

    async def _inpaint_video_opencv(
        self,
        input_path: str,
        output_path: str,
        region: Dict[str, int],
        logo_path: Optional[Path],
        logo_position: str,
        width: int,
        height: int,
        logo_scale: float = 1.0,
    ) -> Tuple[bool, Optional[str]]:
        """Process video frame-by-frame with OpenCV inpainting, then re-encode."""

        work_dir = tempfile.mkdtemp(prefix="champdf_inpaint_")

        try:
            # Create the mask once (same for all frames since logo is static)
            mask = self._create_inpaint_mask(width, height, region)
            inpaint_radius = max(3, min(region["w"], region["h"]) // 8)

            # Extract audio first
            audio_path = os.path.join(work_dir, "audio.aac")
            has_audio = await self._extract_audio(input_path, audio_path)

            # Process frames using OpenCV in a thread pool
            inpainted_path = os.path.join(work_dir, "inpainted_raw.mp4")
            loop = asyncio.get_event_loop()
            success, err = await loop.run_in_executor(
                None,
                self._process_frames_sync,
                input_path,
                inpainted_path,
                mask,
                inpaint_radius,
            )

            if not success:
                return False, err

            # Re-encode with FFmpeg: mux inpainted video + original audio + optional logo
            success, err = await self._finalize_video(
                inpainted_path,
                output_path,
                audio_path if has_audio else None,
                logo_path,
                logo_position,
                logo_scale,
            )

            return success, err

        except Exception as e:
            return False, str(e)
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    def _process_frames_sync(
        self,
        input_path: str,
        output_path: str,
        mask: "np.ndarray",
        inpaint_radius: int,
    ) -> Tuple[bool, Optional[str]]:
        """Synchronous frame-by-frame inpainting (runs in thread pool)."""
        cap = cv2.VideoCapture(input_path)
        if not cap.isOpened():
            return False, "Could not open video for frame processing"

        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        writer = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

        if not writer.isOpened():
            cap.release()
            return False, "Could not create video writer"

        try:
            frame_idx = 0
            while True:
                ret, frame = cap.read()
                if not ret:
                    break

                # Inpaint the logo region
                inpainted = self._inpaint_frame(frame, mask, inpaint_radius)
                writer.write(inpainted)
                frame_idx += 1

        except Exception as e:
            return False, f"Frame processing error at frame {frame_idx}: {str(e)}"
        finally:
            cap.release()
            writer.release()

        if frame_idx == 0:
            return False, "No frames were processed"

        return True, None

    async def _extract_audio(self, input_path: str, audio_path: str) -> bool:
        """Extract audio stream from video."""
        cmd = [
            "ffmpeg", "-y",
            "-i", input_path,
            "-vn", "-acodec", "copy",
            audio_path
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        await proc.communicate()
        return proc.returncode == 0 and Path(audio_path).exists()

    async def _finalize_video(
        self,
        video_path: str,
        output_path: str,
        audio_path: Optional[str],
        logo_path: Optional[Path],
        logo_position: str,
        logo_scale: float = 1.0,
    ) -> Tuple[bool, Optional[str]]:
        """Re-encode inpainted video with H.264, mux audio, and optionally overlay logo."""

        # Default logo width is 120px; user-supplied logo_scale (0.5–2.0)
        # multiplies it. Round to even so libx264 is happy.
        logo_w = max(2, int(round(120 * logo_scale / 2)) * 2)

        if logo_path and audio_path:
            # Inpainted video + audio + logo overlay
            filter_complex = f"[0:v][1:v]overlay={logo_position}:format=auto[out]"
            cmd = [
                "ffmpeg", "-y",
                "-i", video_path,
                "-i", str(logo_path),
                "-i", audio_path,
                "-filter_complex", f"[1:v]scale={logo_w}:-1[logo];[0:v][logo]overlay={logo_position}:format=auto[out]",
                "-map", "[out]",
                "-map", "2:a",
                "-c:v", "libx264", "-crf", "18", "-preset", "fast",
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart",
                output_path
            ]
        elif logo_path:
            # Inpainted video + logo overlay (no audio)
            cmd = [
                "ffmpeg", "-y",
                "-i", video_path,
                "-i", str(logo_path),
                "-filter_complex", f"[1:v]scale={logo_w}:-1[logo];[0:v][logo]overlay={logo_position}:format=auto[out]",
                "-map", "[out]",
                "-c:v", "libx264", "-crf", "18", "-preset", "fast",
                "-movflags", "+faststart",
                output_path
            ]
        elif audio_path:
            # Inpainted video + audio (no logo)
            cmd = [
                "ffmpeg", "-y",
                "-i", video_path,
                "-i", audio_path,
                "-map", "0:v", "-map", "1:a",
                "-c:v", "libx264", "-crf", "18", "-preset", "fast",
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart",
                output_path
            ]
        else:
            # Just re-encode (no logo, no audio)
            cmd = [
                "ffmpeg", "-y",
                "-i", video_path,
                "-c:v", "libx264", "-crf", "18", "-preset", "fast",
                "-movflags", "+faststart",
                output_path
            ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        from config import settings
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=settings.PROCESS_TIMEOUT
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            return False, f"Finalization timed out after {settings.PROCESS_TIMEOUT} seconds"

        if proc.returncode != 0:
            error_msg = stderr.decode()[-500:] if stderr else "Unknown error"
            return False, f"FFmpeg finalize error: {error_msg}"

        if not Path(output_path).exists():
            return False, "Output file was not created"

        return True, None

    async def _process_with_ffmpeg_delogo(
        self,
        input_path: str,
        output_path: str,
        region: Dict[str, int],
        logo_path: Optional[Path],
        logo_position: str,
        logo_scale: float = 1.0,
    ) -> Tuple[bool, Optional[str]]:
        """Fallback: process video with FFmpeg delogo filter (lower quality)."""

        logo_w = max(2, int(round(120 * logo_scale / 2)) * 2)

        if logo_path:
            filter_complex = (
                f"[0:v]delogo=x={region['x']}:y={region['y']}:w={region['w']}:h={region['h']}:show=0[delogoed];"
                f"[1:v]scale={logo_w}:-1[logo];"
                f"[delogoed][logo]overlay={logo_position}:format=auto[out]"
            )
            cmd = [
                "ffmpeg", "-y",
                "-i", input_path,
                "-i", str(logo_path),
                "-filter_complex", filter_complex,
                "-map", "[out]",
                "-map", "0:a?",
                "-c:v", "libx264", "-crf", "18", "-preset", "fast",
                "-c:a", "copy",
                "-movflags", "+faststart",
                output_path
            ]
        else:
            filter_complex = (
                f"delogo=x={region['x']}:y={region['y']}:w={region['w']}:h={region['h']}:show=0"
            )
            cmd = [
                "ffmpeg", "-y",
                "-i", input_path,
                "-vf", filter_complex,
                "-c:v", "libx264", "-crf", "18", "-preset", "fast",
                "-c:a", "copy",
                "-movflags", "+faststart",
                output_path
            ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        from config import settings
        try:
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

        if not Path(output_path).exists():
            return False, "Output file was not created"

        return True, None

    async def process(
        self,
        input_path: str,
        output_path: str,
        logo_preset: str = "lakeb2b",
        watermark_position: str = "bottom-right",
        logo_scale: float = 1.0,
        quality: str = "fast",
    ) -> Tuple[bool, Optional[str]]:
        """
        Process video to remove watermark and optionally add logo.

        Quality:
          - "best": offload the inpainting to an external GPU provider
            (hosted ProPainter) for clean results on detailed backgrounds,
            then re-mux audio + overlay the logo locally. Falls back to the
            CPU path if the provider is unavailable or fails.
          - "fast" (default): OpenCV inpainting (Navier-Stokes + TELEA dual
            pass) when available, else the FFmpeg delogo filter. All local.

        Args:
            input_path: Path to input video
            output_path: Path for output video
            logo_preset: Logo to add (lakeb2b, champions, ampliz, none)
            watermark_position: Position of original watermark
            logo_scale: User-supplied size multiplier for replacement logo
                (1.0 = default 120px width). Range 0.5–2.0.
            quality: "fast" (CPU, local) or "best" (external GPU offload).

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

            # Get logo info
            logo_path = self.get_logo_path(logo_preset)
            logo_position = self._get_logo_position(watermark_position)

            # "Best" quality → external GPU inpainting (ProPainter). Falls back
            # to the local CPU path below if unavailable or if the job fails.
            if quality == "best":
                from gpu_video_remover import gpu_removal_available
                if gpu_removal_available():
                    success, err = await self._inpaint_video_gpu(
                        input_path=input_path,
                        output_path=output_path,
                        region=region,
                        logo_path=logo_path,
                        logo_position=logo_position,
                        width=width,
                        height=height,
                        info=info,
                        logo_scale=logo_scale,
                    )
                    if success:
                        return True, None
                    logger.warning(
                        "GPU video removal failed (%s); falling back to CPU path.",
                        err,
                    )
                else:
                    logger.info("GPU video removal requested but unavailable; using CPU path.")

            # Use OpenCV inpainting for higher quality when available
            if HAS_OPENCV:
                return await self._inpaint_video_opencv(
                    input_path=input_path,
                    output_path=output_path,
                    region=region,
                    logo_path=logo_path,
                    logo_position=logo_position,
                    width=width,
                    height=height,
                    logo_scale=logo_scale,
                )
            else:
                # Fallback to FFmpeg delogo
                return await self._process_with_ffmpeg_delogo(
                    input_path=input_path,
                    output_path=output_path,
                    region=region,
                    logo_path=logo_path,
                    logo_position=logo_position,
                    logo_scale=logo_scale,
                )

        except Exception as e:
            return False, str(e)

    def _build_mask_png(
        self,
        width: int,
        height: int,
        region: Dict[str, int],
        pad: int = 4,
    ) -> bytes:
        """Build a PNG mask (white over the watermark box) for the GPU provider.

        Uses PIL so it works even when OpenCV isn't installed. A single static
        mask is correct for fixed-position watermarks like NotebookLM's.
        """
        from PIL import Image, ImageDraw
        import io as _io

        img = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(img)
        x1 = max(0, region["x"] - pad)
        y1 = max(0, region["y"] - pad)
        x2 = min(width, region["x"] + region["w"] + pad)
        y2 = min(height, region["y"] + region["h"] + pad)
        draw.rectangle([x1, y1, x2, y2], fill=255)

        buf = _io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    @staticmethod
    def _even(v: int) -> int:
        """Round down to even — libx264/yuv420p requires even dimensions."""
        return int(v) - (int(v) % 2)

    def _gpu_crop_window(
        self,
        region: Dict[str, int],
        width: int,
        height: int,
    ) -> Optional[Dict[str, int]]:
        """Padded, even-aligned crop window around the watermark, or None.

        The GPU bill scales with pixels processed, and a corner watermark is a
        tiny fraction of the frame — so inpainting a window around it instead of
        the whole frame cuts cost by roughly the pixel ratio. Returns None when
        the window would still cover most of the frame (nothing to save) or when
        cropping is disabled.
        """
        from config import settings

        if not getattr(settings, "GPU_VIDEO_CROP_ENABLED", True):
            return None

        pad_ratio = float(getattr(settings, "GPU_VIDEO_CROP_PAD_RATIO", 1.0))
        min_side = int(getattr(settings, "GPU_VIDEO_CROP_MIN_SIDE", 320))
        max_frac = float(getattr(settings, "GPU_VIDEO_CROP_MAX_FRACTION", 0.6))

        # Pad around the watermark for propagation context.
        pad_x = int(region["w"] * pad_ratio)
        pad_y = int(region["h"] * pad_ratio)
        win_w = region["w"] + 2 * pad_x
        win_h = region["h"] + 2 * pad_y

        # Enforce a sensible floor, then clamp to the frame.
        win_w = min(max(win_w, min_side), width)
        win_h = min(max(win_h, min_side), height)

        # Centre the window on the watermark, then slide it fully inside frame.
        cx = region["x"] + region["w"] / 2.0
        cy = region["y"] + region["h"] / 2.0
        x = int(round(cx - win_w / 2.0))
        y = int(round(cy - win_h / 2.0))
        x = max(0, min(x, width - win_w))
        y = max(0, min(y, height - win_h))

        # Even-align origin and size without falling outside the frame.
        x, y = self._even(x), self._even(y)
        win_w = self._even(min(win_w, width - x))
        win_h = self._even(min(win_h, height - y))
        if win_w <= 0 or win_h <= 0:
            return None

        # If we're not meaningfully smaller than the frame, don't bother.
        if (win_w * win_h) > (max_frac * width * height):
            return None

        return {"x": x, "y": y, "w": win_w, "h": win_h}

    async def _crop_video(
        self,
        input_path: str,
        output_path: str,
        window: Dict[str, int],
    ) -> Tuple[bool, Optional[str]]:
        """Extract the crop window as a standalone video (no audio)."""
        cmd = [
            "ffmpeg", "-y",
            "-i", input_path,
            "-filter:v", f"crop={window['w']}:{window['h']}:{window['x']}:{window['y']}",
            "-an",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p",
            output_path,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0 or not Path(output_path).exists():
            return False, f"Crop failed: {stderr.decode()[-300:]}"
        return True, None

    async def _composite_cleaned_patch(
        self,
        original_path: str,
        cleaned_crop_path: str,
        output_path: str,
        region: Dict[str, int],
        window: Dict[str, int],
        width: int,
        height: int,
        mask_pad: int = 4,
    ) -> Tuple[bool, Optional[str]]:
        """Paste only the inpainted watermark box back onto the original video.

        Deliberately narrow: we overlay just the masked box, not the whole
        cleaned window. Everything outside it comes straight from the source, so
        the crop boundary can't show up as a seam from differing re-encodes.
        The cleaned crop is scaled back to the window size first, since the model
        may return a different resolution than it was given.
        """
        # The box actually inpainted = region + the mask's own padding, clamped
        # to both the frame and the crop window (mask can't exceed the window).
        px1 = max(window["x"], region["x"] - mask_pad, 0)
        py1 = max(window["y"], region["y"] - mask_pad, 0)
        px2 = min(
            window["x"] + window["w"], region["x"] + region["w"] + mask_pad, width
        )
        py2 = min(
            window["y"] + window["h"], region["y"] + region["h"] + mask_pad, height
        )
        pw, ph = int(px2 - px1), int(py2 - py1)
        if pw <= 0 or ph <= 0:
            return False, "Computed empty composite patch"

        # Same box expressed inside the cleaned crop.
        rx, ry = int(px1 - window["x"]), int(py1 - window["y"])

        filter_complex = (
            f"[1:v]scale={window['w']}:{window['h']},"
            f"crop={pw}:{ph}:{rx}:{ry}[patch];"
            f"[0:v][patch]overlay={int(px1)}:{int(py1)}:format=auto[out]"
        )
        cmd = [
            "ffmpeg", "-y",
            "-i", original_path,
            "-i", cleaned_crop_path,
            "-filter_complex", filter_complex,
            "-map", "[out]",
            "-an",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p",
            output_path,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0 or not Path(output_path).exists():
            return False, f"Composite failed: {stderr.decode()[-300:]}"
        return True, None

    async def _inpaint_video_gpu(
        self,
        input_path: str,
        output_path: str,
        region: Dict[str, int],
        logo_path: Optional[Path],
        logo_position: str,
        width: int,
        height: int,
        info: Dict,
        logo_scale: float = 1.0,
    ) -> Tuple[bool, Optional[str]]:
        """Offload inpainting to an external GPU provider, then finalize locally.

        Flow: crop a padded window around the watermark (cost control — see
        _gpu_crop_window) → build a mask for it → extract audio → send to the
        provider → composite the cleaned patch back onto the original → re-mux
        audio and overlay the replacement logo with the existing FFmpeg step.

        Falls back to sending the full frame when cropping isn't worthwhile or
        the crop step fails, so behaviour is never worse than before.
        """
        from gpu_video_remover import remove_watermark, GpuVideoError
        from config import settings

        # Cost guard: skip very long clips (GPU offload is billed per second).
        try:
            duration = float(info.get("format", {}).get("duration", 0) or 0)
        except (TypeError, ValueError):
            duration = 0.0
        max_s = getattr(settings, "GPU_VIDEO_MAX_SECONDS", 0)
        if max_s and duration and duration > max_s:
            return False, (
                f"Clip is {int(duration)}s; GPU removal is capped at {max_s}s. "
                "Use Fast (CPU) quality or trim the clip."
            )

        work_dir = tempfile.mkdtemp(prefix="champdf_gpu_")
        try:
            # Pull the audio aside; the provider returns video only.
            audio_path = os.path.join(work_dir, "audio.aac")
            has_audio = await self._extract_audio(input_path, audio_path)

            window = self._gpu_crop_window(region, width, height)
            send_path = input_path
            if window:
                crop_path = os.path.join(work_dir, "crop.mp4")
                ok, err = await self._crop_video(input_path, crop_path, window)
                if ok:
                    send_path = crop_path
                    saving = 1.0 - (window["w"] * window["h"]) / float(width * height)
                    logger.info(
                        "GPU inpaint: sending %dx%d crop instead of %dx%d frame "
                        "(~%.0f%% fewer pixels billed)",
                        window["w"], window["h"], width, height, saving * 100,
                    )
                    # Mask is relative to the crop's own coordinate space.
                    mask_png = self._build_mask_png(
                        window["w"],
                        window["h"],
                        {
                            "x": region["x"] - window["x"],
                            "y": region["y"] - window["y"],
                            "w": region["w"],
                            "h": region["h"],
                        },
                    )
                else:
                    logger.warning("Crop for GPU inpaint failed (%s); sending full frame.", err)
                    window = None

            if not window:
                mask_png = self._build_mask_png(width, height, region)

            try:
                cleaned = await remove_watermark(send_path, mask_png)
            except GpuVideoError as e:
                return False, str(e)

            cleaned_path = os.path.join(work_dir, "cleaned.mp4")
            Path(cleaned_path).write_bytes(cleaned)

            if window:
                composited = os.path.join(work_dir, "composited.mp4")
                ok, err = await self._composite_cleaned_patch(
                    input_path, cleaned_path, composited, region, window, width, height
                )
                if not ok:
                    return False, err
                cleaned_path = composited

            return await self._finalize_video(
                cleaned_path,
                output_path,
                audio_path if has_audio else None,
                logo_path,
                logo_position,
                logo_scale,
            )
        except Exception as e:
            return False, str(e)
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
