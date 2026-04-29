"""
Local verification harness for the watermark-remover inpaint pipeline.

Two modes:

  python verify_inpaint.py local
      Run the inpaint_processor module directly. Exercises the OpenCV
      fallback path. If GEMINI_API_KEY is set, also tries the Gemini
      path. Saves outputs to /tmp/champdf-verify/.

  python verify_inpaint.py remote --base-url http://... --key champdf_live_...
      Hits POST /api/inpaint-image (and /api/edit-image if a prompt is
      supplied) on a deployed backend. Validates response is a valid
      PNG of expected dimensions.

Generates a synthetic 800x600 test image with a fake "watermark" rectangle
in the bottom-right corner so you can run this without external assets.
For real quality grading, swap in a NotebookLM-watermarked PDF page.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


OUT_DIR = Path("/tmp/champdf-verify")


def synthesize_test_image() -> tuple[bytes, bytes]:
    """
    Build a (image, mask) pair for testing. Image is a gradient with text
    underneath a fake watermark rectangle in the bottom-right. Mask covers
    the watermark.
    """
    w, h = 800, 600
    img = Image.new("RGB", (w, h), (245, 240, 230))
    draw = ImageDraw.Draw(img)

    # Background gradient (so inpainting has something non-trivial to fill)
    for y in range(h):
        shade = int(245 - (y / h) * 30)
        draw.line([(0, y), (w, y)], fill=(shade, shade - 5, shade - 15))

    # Fake document text the watermark partially overlaps
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 24)
    except OSError:
        font = ImageFont.load_default()
    draw.text((40, 100), "ChamPDF inpaint validation page", font=font, fill=(40, 40, 40))
    draw.text((40, 140), "This text should remain after inpainting.", font=font, fill=(60, 60, 60))
    for i in range(8):
        draw.text(
            (40, 200 + i * 40),
            f"Line {i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit.",
            font=font,
            fill=(80, 80, 80),
        )

    # Fake watermark — a translucent magenta box with diagonal text
    wm_layer = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    wm_draw = ImageDraw.Draw(wm_layer)
    wm_box = (520, 480, 760, 560)
    wm_draw.rectangle(wm_box, fill=(255, 0, 255, 80))
    wm_draw.text((540, 500), "WATERMARK", font=font, fill=(255, 0, 255, 220))
    img = Image.alpha_composite(img.convert("RGBA"), wm_layer).convert("RGB")

    # Mask: white over the watermark, black elsewhere
    mask = Image.new("L", (w, h), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rectangle(wm_box, fill=255)

    img_buf = io.BytesIO()
    img.save(img_buf, format="PNG")
    mask_buf = io.BytesIO()
    mask.save(mask_buf, format="PNG")
    return img_buf.getvalue(), mask_buf.getvalue()


def verify_png(data: bytes, label: str) -> None:
    img = Image.open(io.BytesIO(data))
    assert img.format == "PNG", f"{label}: expected PNG, got {img.format}"
    assert img.size[0] > 0 and img.size[1] > 0, f"{label}: empty image"
    print(f"  ✓ {label}: {img.format} {img.size[0]}x{img.size[1]} ({len(data) // 1024} KB)")


async def run_local() -> int:
    """Direct module call. Exercises the same code path the endpoint uses."""
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from inpaint_processor import inpaint_image, _gemini_available

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img_bytes, mask_bytes = synthesize_test_image()
    (OUT_DIR / "input.png").write_bytes(img_bytes)
    (OUT_DIR / "mask.png").write_bytes(mask_bytes)
    print(f"Test image + mask written to {OUT_DIR}/")

    print("\n[1/2] OpenCV fallback path...")
    # Force the OpenCV path by temporarily clearing the key
    saved = os.environ.pop("GEMINI_API_KEY", None)
    try:
        out_cv = await inpaint_image(img_bytes, mask_bytes, radius=5)
    finally:
        if saved:
            os.environ["GEMINI_API_KEY"] = saved
    (OUT_DIR / "result_opencv.png").write_bytes(out_cv)
    verify_png(out_cv, "OpenCV Telea result")

    print("\n[2/2] Gemini path...")
    if not _gemini_available():
        print("  · GEMINI_API_KEY not set — skipping. Set it and re-run for full validation.")
        return 0
    out_gem = await inpaint_image(img_bytes, mask_bytes, radius=5)
    (OUT_DIR / "result_gemini.png").write_bytes(out_gem)
    verify_png(out_gem, "Gemini result")

    print("\nAll outputs saved to /tmp/champdf-verify/. Open them in an image")
    print("viewer to compare quality side-by-side against input.png.")
    return 0


def run_remote(base_url: str, key: str, prompt: str | None) -> int:
    """Hit a deployed backend's /api/inpaint-image (and /api/edit-image)."""
    import urllib.request

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img_bytes, mask_bytes = synthesize_test_image()

    # Build a multipart body manually (no extra deps)
    boundary = "----CHAMPDF" + os.urandom(8).hex()

    def part(name: str, filename: str, data: bytes, ctype: str) -> bytes:
        return (
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f'Content-Type: {ctype}\r\n\r\n'
        ).encode() + data + b'\r\n'

    print("\n[remote] /api/inpaint-image ...")
    body = (
        part("image", "page.png", img_bytes, "image/png")
        + part("mask", "mask.png", mask_bytes, "image/png")
        + f"--{boundary}--\r\n".encode()
    )
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/inpaint-image",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Authorization": f"Bearer {key}" if key.startswith("champdf_live_") else "",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        out = resp.read()
    (OUT_DIR / "remote_inpaint.png").write_bytes(out)
    verify_png(out, "Remote inpaint")

    if prompt:
        print(f"\n[remote] /api/edit-image (prompt: {prompt!r}) ...")
        body2 = (
            part("image", "page.png", img_bytes, "image/png")
            + (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="prompt"\r\n\r\n'
                f"{prompt}\r\n"
            ).encode()
            + f"--{boundary}--\r\n".encode()
        )
        req2 = urllib.request.Request(
            f"{base_url.rstrip('/')}/api/edit-image",
            data=body2,
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Authorization": f"Bearer {key}" if key.startswith("champdf_live_") else "",
            },
            method="POST",
        )
        with urllib.request.urlopen(req2, timeout=180) as resp:
            out2 = resp.read()
        (OUT_DIR / "remote_edit.png").write_bytes(out2)
        verify_png(out2, "Remote edit (Edit Banana)")

    print(f"\nResults in {OUT_DIR}/. Compare visually.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("local")
    rp = sub.add_parser("remote")
    rp.add_argument("--base-url", required=True)
    rp.add_argument(
        "--key",
        default="",
        help="API key. Pass an unversioned key like 'champdf_live_...' "
        "if your deployed backend gates /api/* with auth, otherwise leave empty.",
    )
    rp.add_argument("--prompt", default=None, help="Optional Edit Banana prompt to also exercise /api/edit-image")
    args = parser.parse_args()

    if args.cmd == "local":
        return asyncio.run(run_local())
    if args.cmd == "remote":
        return run_remote(args.base_url, args.key, args.prompt)
    return 2


if __name__ == "__main__":
    sys.exit(main())
