#!/usr/bin/env python3
"""
Probe a ChamPDF backend's media capabilities and report what served each one.

    python3 scripts/test-media-providers.py https://champdf-backend.up.railway.app
    python3 scripts/test-media-providers.py http://localhost:8000 --scale 4 --timeout 240

For every capability it POSTs a small generated fixture, then prints HTTP
status, wall time, output size, and the X-ChamPDF-Provider header the backend
now returns (local | replicate | openrouter | gemini | opencv). Use it after
flipping a MEDIA_*_PROVIDER variable on Railway to prove the change took, and
to compare CPU timings against hosted ones. Needs only Pillow.

Exit code 1 if any capability the server reports as available fails.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import time
import urllib.error
import urllib.request
import uuid


def fixtures():
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (320, 240), (118, 160, 220))
    d = ImageDraw.Draw(img)
    d.ellipse([70, 40, 250, 200], fill=(232, 92, 60))
    d.text((190, 214), "WATERMARK", fill=(255, 0, 255))
    mask = Image.new("L", (320, 240), 0)
    ImageDraw.Draw(mask).rectangle([185, 208, 315, 232], fill=255)
    out = {}
    for name, im in (("img.png", img), ("mask.png", mask)):
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        out[name] = buf.getvalue()
    return out


def multipart(fields, files):
    boundary = "----champdf" + uuid.uuid4().hex
    body = io.BytesIO()
    for k, v in fields.items():
        body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    for k, (fname, data, ctype) in files.items():
        body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fname}\"\r\nContent-Type: {ctype}\r\n\r\n".encode())
        body.write(data)
        body.write(b"\r\n")
    body.write(f"--{boundary}--\r\n".encode())
    return body.getvalue(), f"multipart/form-data; boundary={boundary}"


def post(base, path, fields, files, timeout):
    data, ctype = multipart(fields, files)
    req = urllib.request.Request(f"{base}{path}", data=data, method="POST", headers={"Content-Type": ctype})
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            return resp.status, time.time() - started, body, dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, time.time() - started, e.read(), dict(e.headers)
    except Exception as e:  # noqa: BLE001
        return 0, time.time() - started, str(e).encode(), {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base", help="backend base URL, e.g. https://champdf-backend.up.railway.app")
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--prompt", default="remove the magenta text at the bottom")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    try:
        with urllib.request.urlopen(f"{base}/api/capabilities", timeout=30) as r:
            caps = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        print(f"capabilities: FAILED ({e})")
        return 1
    print(f"capabilities: ok  providers={json.dumps({k: v.get('provider') for k, v in caps.get('media_providers', {}).items() if isinstance(v, dict)})}  treg={caps.get('treg', {}).get('configured')}")

    fx = fixtures()
    img = ("img.png", fx["img.png"], "image/png")
    mask = ("mask.png", fx["mask.png"], "image/png")
    probes = [
        ("remove-background", "/api/remove-background", {"output_format": "png"}, {"file": img}, caps.get("background_removal")),
        ("inpaint (mask)", "/api/inpaint", {}, {"file": img, "mask": mask}, caps.get("inpaint")),
        ("inpaint-image (gemini/opencv)", "/api/inpaint-image", {}, {"image": img, "mask": mask}, True),
        ("remove-image-watermark", "/api/remove-image-watermark", {"regions": json.dumps([{"x": 185, "y": 208, "w": 130, "h": 24}])}, {"file": img}, caps.get("inpaint")),
        (f"upscale x{args.scale}", "/api/upscale-image", {"scale": str(args.scale), "output_format": "png"}, {"file": img}, caps.get("upscale")),
        ("edit-image (prompt)", "/api/edit-image", {"prompt": args.prompt}, {"image": img}, caps.get("gemini_inpaint")),
        ("detect-watermark", "/api/detect-watermark", {}, {"file": img}, True),
    ]
    failures = 0
    print(f"{'capability':<32} {'http':>4} {'secs':>7} {'bytes':>8}  provider   note")
    for name, path, fields, files, advertised in probes:
        status, secs, body, headers = post(base, path, fields, files, args.timeout)
        provider = headers.get("X-ChamPDF-Provider") or headers.get("x-champdf-provider") or "-"
        note = ""
        if status != 200:
            try:
                note = json.loads(body).get("detail")
            except Exception:  # noqa: BLE001
                note = body[:80].decode("utf-8", "replace")
            if isinstance(note, (dict, list)):
                note = json.dumps(note)[:120]
            if advertised:
                failures += 1
        elif not (body.startswith(b"\x89PNG") or body.startswith(b"\xff\xd8\xff") or body.startswith(b"{")):
            note = "unexpected body"
            failures += 1
        print(f"{name:<32} {status:>4} {secs:>7.1f} {len(body):>8}  {provider:<10} {str(note)[:100]}")
    print(f"\n{'ALL GOOD' if not failures else f'{failures} FAILURE(S)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
