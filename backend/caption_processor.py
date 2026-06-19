"""
Caption Processor - speech-to-text subtitles using faster-whisper.

faster-whisper runs the Whisper model on the CTranslate2 engine (no torch, up to
4x faster, low memory with int8). We extract the audio track with FFmpeg, then
transcribe to an .srt file that can be returned to the user or burned into a
rebranded video.
"""

import asyncio
import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def _format_timestamp(seconds: float) -> str:
    """Seconds -> SRT timestamp 'HH:MM:SS,mmm'."""
    if seconds < 0:
        seconds = 0
    millis = int(round(seconds * 1000))
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


class CaptionProcessor:
    """Lazy-loaded faster-whisper transcription -> SRT."""

    def __init__(self, model_size: str = "base", compute_type: str = "int8", device: str = "cpu"):
        self.model_size = model_size
        self.compute_type = compute_type
        self.device = device
        self._model = None
        self._lock = asyncio.Lock()

    def _ensure_model(self):
        if self._model is None:
            from faster_whisper import WhisperModel  # heavy import
            # CTranslate2 has no "auto"; map cuda->cuda else cpu.
            device = "cuda" if self.device == "cuda" else "cpu"
            self._model = WhisperModel(self.model_size, device=device, compute_type=self.compute_type)
            logger.info("faster-whisper loaded: %s (%s/%s)", self.model_size, device, self.compute_type)
        return self._model

    @staticmethod
    def _extract_audio(video_path: str) -> str:
        """Extract a 16kHz mono WAV (Whisper's expected format) via FFmpeg."""
        audio_path = str(Path(tempfile.gettempdir()) / f"{Path(video_path).stem}_audio.wav")
        cmd = [
            "ffmpeg", "-y", "-i", video_path,
            "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", audio_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"Audio extraction failed: {result.stderr[-300:]}")
        return audio_path

    def _transcribe_to_srt(self, audio_path: str, language: Optional[str]) -> str:
        model = self._ensure_model()
        segments, info = model.transcribe(audio_path, beam_size=5, language=language)
        logger.info("Transcribing (detected language=%s, p=%.2f)", info.language, info.language_probability)
        lines = []
        for i, seg in enumerate(segments, start=1):
            text = seg.text.strip()
            if not text:
                continue
            lines.append(str(i))
            lines.append(f"{_format_timestamp(seg.start)} --> {_format_timestamp(seg.end)}")
            lines.append(text)
            lines.append("")
        return "\n".join(lines)

    async def transcribe_video_to_srt(self, video_path: str, language: Optional[str] = None) -> str:
        """Full pipeline: extract audio -> transcribe -> SRT string."""
        async with self._lock:
            audio_path = await asyncio.to_thread(self._extract_audio, video_path)
            try:
                srt = await asyncio.to_thread(self._transcribe_to_srt, audio_path, language)
            finally:
                Path(audio_path).unlink(missing_ok=True)
            return srt
