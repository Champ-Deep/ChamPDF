"""
Media Downloader - Download videos from URLs (YouTube, Instagram) as MP4 or MP3.

Uses yt-dlp for the download/extraction step and ffmpeg (via subprocess) for
the MP3 transcode. yt-dlp's MP4 muxing path also relies on ffmpeg internally
when the source streams are split (video-only + audio-only).
"""

import asyncio
import logging
import re
import shutil
from pathlib import Path
from typing import Literal, Optional, Tuple

import yt_dlp
from yt_dlp.utils import DownloadError

logger = logging.getLogger(__name__)

# 30 minutes
MAX_DURATION_SECONDS = 30 * 60

# 500 MB ceiling on the produced file
MAX_OUTPUT_BYTES = 500 * 1024 * 1024


class MediaDownloadError(Exception):
    """Raised by `download_media` to signal a user-facing failure."""

    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _classify_yt_dlp_error(err: Exception) -> Tuple[str, str, int]:
    text = str(err).lower()

    if "unsupported url" in text or "no video formats found" in text:
        return ("unsupported_url", "This link isn't from a supported platform.", 400)
    if (
        "login" in text
        or "private" in text
        or "sign in" in text
        or "cookies" in text and "required" in text
    ):
        return (
            "private_or_login_required",
            "This video requires login or is private.",
            403,
        )
    if "geo" in text and ("restrict" in text or "block" in text):
        return ("geo_restricted", "Not available in this region.", 403)
    if "live" in text and "stream" in text:
        return ("live_stream", "Live streams aren't supported.", 400)

    return (
        "download_failed",
        "Couldn't download from this link. Try another.",
        400,
    )


def _sanitize_filename(title: Optional[str], fallback: str) -> str:
    """Produce a Content-Disposition-safe filename."""
    if not title:
        return fallback

    # Strip newlines and control chars; replace path separators and quotes.
    cleaned = re.sub(r"[\x00-\x1f\x7f]", "", title)
    cleaned = re.sub(r'[\\/:*?"<>|]', "_", cleaned)
    cleaned = cleaned.strip().strip(".")

    if not cleaned:
        return fallback

    # Truncate to keep total filename (with extension) under ~120 chars.
    return cleaned[:115]


def _probe_metadata(url: str) -> dict:
    """Run yt-dlp metadata extraction without downloading.

    Raises MediaDownloadError on validation failures.
    """
    probe_opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": 30,
    }

    try:
        with yt_dlp.YoutubeDL(probe_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except DownloadError as e:
        code, message, status = _classify_yt_dlp_error(e)
        raise MediaDownloadError(code, message, status) from e

    if info is None:
        raise MediaDownloadError(
            "unsupported_url",
            "This link isn't from a supported platform.",
            400,
        )

    if info.get("_type") == "playlist":
        entries = info.get("entries") or []
        # Some extractors wrap a single video as a 1-entry "playlist" — accept that.
        if len(entries) != 1:
            raise MediaDownloadError(
                "unsupported_url",
                "Playlists aren't supported. Paste a single video link.",
                400,
            )
        info = entries[0]

    if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming"}:
        raise MediaDownloadError(
            "live_stream",
            "Live streams aren't supported.",
            400,
        )

    duration = info.get("duration")
    if duration is not None and duration > MAX_DURATION_SECONDS:
        raise MediaDownloadError(
            "too_long",
            "Video exceeds the 30-minute limit.",
            400,
        )

    return info


def _ydl_options_for(fmt: Literal["mp4", "mp3"], work_dir: Path) -> dict:
    common = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "restrictfilenames": True,
        "socket_timeout": 30,
        "retries": 2,
        "outtmpl": str(work_dir / "%(id)s.%(ext)s"),
        "paths": {"home": str(work_dir), "temp": str(work_dir)},
    }

    if fmt == "mp4":
        return {
            **common,
            # Prefer native MP4+M4A pair; fall back to any best video+audio pair
            # and let yt-dlp remux to MP4 via ffmpeg.
            "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv+ba/b",
            "merge_output_format": "mp4",
        }

    # mp3 — grab best audio, transcode separately for 320 kbps CBR.
    return {
        **common,
        "format": "bestaudio/best",
    }


def _run_yt_dlp(url: str, opts: dict) -> Path:
    """Download with yt-dlp and return the resulting file path."""
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            # `requested_downloads` reflects post-merge output(s). Fall back to
            # `_filename` / template prepare if it's missing.
            if info is None:
                raise MediaDownloadError(
                    "download_failed",
                    "Couldn't download from this link. Try another.",
                    400,
                )

            requested = info.get("requested_downloads") or []
            if requested:
                filepath = requested[0].get("filepath")
                if filepath:
                    return Path(filepath)

            filename = ydl.prepare_filename(info)
            return Path(filename)
    except DownloadError as e:
        code, message, status = _classify_yt_dlp_error(e)
        raise MediaDownloadError(code, message, status) from e


async def _transcode_to_mp3(src: Path, dst: Path) -> None:
    """Transcode any audio source to 320 kbps CBR stereo MP3 at 44.1 kHz."""
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-vn",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-b:a",
        "320k",
        "-codec:a",
        "libmp3lame",
        str(dst),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        logger.error(
            "ffmpeg mp3 transcode failed (rc=%s): %s",
            proc.returncode,
            stderr.decode(errors="replace")[-500:],
        )
        raise MediaDownloadError(
            "download_failed",
            "Couldn't extract audio from this link. Try another.",
            500,
        )


async def download_media(
    url: str,
    fmt: Literal["mp4", "mp3"],
    work_dir: Path,
) -> Tuple[Path, str]:
    """
    Download a video URL as MP4 or MP3.

    Returns: (output_path, suggested_download_filename)
    Raises: MediaDownloadError on user-facing failures.
    """
    if fmt not in ("mp4", "mp3"):
        raise MediaDownloadError("unsupported_url", "Invalid format.", 400)

    work_dir.mkdir(parents=True, exist_ok=True)

    loop = asyncio.get_running_loop()

    # 1. Pre-flight metadata probe
    info = await loop.run_in_executor(None, _probe_metadata, url)
    title = info.get("title") or info.get("id") or "video"

    # 2. Download
    opts = _ydl_options_for(fmt, work_dir)
    downloaded = await loop.run_in_executor(None, _run_yt_dlp, url, opts)

    if not downloaded.exists():
        raise MediaDownloadError(
            "download_failed",
            "Couldn't download from this link. Try another.",
            500,
        )

    # 3. Produce the requested output
    if fmt == "mp4":
        output_path = downloaded
        download_filename = f"{_sanitize_filename(title, 'video')}.mp4"
    else:
        output_path = work_dir / f"{downloaded.stem}.mp3"
        await _transcode_to_mp3(downloaded, output_path)
        download_filename = f"{_sanitize_filename(title, 'audio')}.mp3"

    # 4. Output size guard
    size = output_path.stat().st_size
    if size > MAX_OUTPUT_BYTES:
        raise MediaDownloadError(
            "download_failed",
            "Downloaded file is too large to deliver.",
            413,
        )

    return output_path, download_filename


def cleanup_work_dir(work_dir: Path) -> None:
    """Best-effort recursive removal of the per-job temp directory."""
    try:
        shutil.rmtree(work_dir, ignore_errors=True)
    except Exception as e:
        logger.warning("Failed to clean up %s: %s", work_dir, e)
