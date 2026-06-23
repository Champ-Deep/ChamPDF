"""
Isolated smoke test for the Replicate ProPainter offload (Best-quality video).

Run this BEFORE testing through the full /api/process-video stack so you can
confirm the model + output selection work without holding a 5-minute HTTP
request. It builds a static white-box mask over the bottom-right corner (where
NotebookLM-style marks sit), sends the clip + mask to the configured ProPainter
model, exercises gpu_video_remover._select_output / _read_output for real, and
writes the cleaned video next to the input.

Usage:
    export VIDEO_GPU_PROVIDER=replicate
    export REPLICATE_API_TOKEN=r8_...
    # optional: export REPLICATE_PROPAINTER_MODEL=jd7h/propainter
    python backend/scripts/test_replicate_propainter.py path/to/clip.mp4

Keep the clip short (<= ~15s) for the first run — Replicate bills per GPU-second.
"""

import asyncio
import io
import json
import subprocess
import sys
from pathlib import Path

# Put backend/ on the path so we import the real client.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def probe_size(path: str) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", path],
        capture_output=True,
        text=True,
    )
    data = json.loads(out.stdout or "{}")
    for s in data.get("streams", []):
        if s.get("codec_type") == "video":
            return int(s.get("width", 1280)), int(s.get("height", 720))
    return 1280, 720


def build_mask(width: int, height: int) -> bytes:
    """White box (=remove) over the bottom-right corner; black elsewhere."""
    from PIL import Image, ImageDraw

    img = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(img)
    w = int(width * 0.18)
    h = int(height * 0.10)
    x = width - w - 20
    y = height - h - 20
    draw.rectangle([x, y, x + w, y + h], fill=255)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


async def main() -> None:
    if len(sys.argv) < 2:
        print("usage: test_replicate_propainter.py <video.mp4>")
        sys.exit(1)
    video = sys.argv[1]
    if not Path(video).exists():
        print(f"No such file: {video}")
        sys.exit(1)

    import gpu_video_remover as g

    if not g.gpu_removal_available():
        print("Set VIDEO_GPU_PROVIDER=replicate and REPLICATE_API_TOKEN first.")
        sys.exit(2)

    w, h = probe_size(video)
    mask = build_mask(w, h)
    print(f"Sending {video} ({w}x{h}) + static mask to {g._model_slug()} …")
    data = await g.remove_watermark(video, mask)

    out = f"{Path(video).with_suffix('')}-cleaned.mp4"
    Path(out).write_bytes(data)
    print(f"✓ Wrote {out} ({len(data):,} bytes)")
    print("  Eyeball it (watermark gone? no mask overlay?), then check billed")
    print("  seconds at https://replicate.com/account/billing")


if __name__ == "__main__":
    asyncio.run(main())
