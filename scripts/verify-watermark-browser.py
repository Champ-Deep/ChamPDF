"""Real local watermark removal gate. Requires playwright, pymupdf and Pillow.

Start npm run dev (or preview) first, then run:
  python3 scripts/verify-watermark-browser.py --output /absolute/scratch/path
External fixture PDFs are never copied into the repo. No backend or keys needed.
"""
import argparse
import base64
import io
import json
from pathlib import Path

import pymupdf
from PIL import Image, ImageChops, ImageDraw
from playwright.sync_api import sync_playwright


def verify(browser, base, fixture, output, name, page_count, first_only=False):
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
    errors, api_requests = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/api/**", lambda route: (api_requests.append(route.request.url), route.abort()))
    page.goto(base + "/remove-watermark.html", wait_until="networkidle")
    page.locator("#file-input").set_input_files(str(fixture))
    page.locator("#loader-modal").wait_for(state="hidden", timeout=30000)
    page.locator("#auto-detect-btn").click()
    page.locator("#alert-modal").wait_for(state="visible", timeout=30000)
    assert "On-device detection complete" in page.locator("#alert-title").inner_text()
    page.locator("#alert-ok").click()
    assert f"{page_count} regions selected" in page.locator("#selection-info").inner_text()
    box = page.locator('#region-overlay [data-region="0"]').evaluate("""el => ({
        x:parseFloat(el.style.left)/100, y:parseFloat(el.style.top)/100,
        width:parseFloat(el.style.width)/100, height:parseFloat(el.style.height)/100
    })""")
    assert box["x"] >= .65 and box["y"] >= .85
    # Regression: six-page sampling used to drop the trailing 'ebook'.
    if name.startswith("new"):
        assert box["x"] + box["width"] >= .99, box
    if first_only:
        while page.locator("#selection-info button").count() > 1:
            page.locator("#selection-info button").last.click()
    page.evaluate("""() => {
        window.encodedRasters = [];
        window.cornerProof = {before: [], after: []};
        const original = HTMLCanvasElement.prototype.toDataURL;
        const corner = canvas => {
            const crop = document.createElement('canvas');
            crop.width = 216; crop.height = 58;
            crop.getContext('2d').drawImage(canvas, 1160, 710, 216, 58, 0, 0, 216, 58);
            return original.call(crop, 'image/png');
        };
        const get = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function(...args) {
            if (args[0] === 0 && args[1] === 0 && args[2] === 1376 && args[3] === 768)
                window.cornerProof.before.push(corner(this.canvas));
            return get.apply(this, args);
        };
        HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
            window.encodedRasters.push({width:this.width,height:this.height,type,quality});
            window.cornerProof.after.push(corner(this));
            return original.call(this, type, quality);
        };
    }""")
    page.locator("#process-btn").click()
    page.locator("#logo-panel").wait_for(state="visible", timeout=90000)
    with page.expect_download(timeout=30000) as download:
        page.locator("#skip-logo-btn").click()
    target = output / (name + "-clean.pdf")
    download.value.save_as(str(target))
    rasters = page.evaluate("window.encodedRasters")
    corners = page.evaluate("window.cornerProof")
    source, result = pymupdf.open(fixture), pymupdf.open(target)
    assert len(result) == len(source) == page_count
    expected_count = 1 if first_only else page_count
    assert len(rasters) == expected_count, rasters
    for index, raster in enumerate(rasters):
        image = source[index].get_images()[0]
        assert (raster["width"], raster["height"]) == (image[2], image[3]), raster
        assert raster["type"] == "image/png" or raster["quality"] >= .92
        assert (image[2], image[3]) in [(i[2], i[3]) for i in result[index].get_images()]
    if first_only:
        for index in range(1, len(source)):
            assert source[index].get_pixmap().samples == result[index].get_pixmap().samples
    quality = verify_corner_quality(source, result, corners, output, name, expected_count)
    assert not errors, errors
    assert not api_requests, api_requests
    report = {"name": name, "pages": len(result), "processed": expected_count,
              "input_bytes": fixture.stat().st_size, "output_bytes": target.stat().st_size,
              "rasters": rasters, "box": box, "api_requests": api_requests,
              "quality": quality,
              "untouched_pages_pixel_identical": page_count - 1 if first_only else None}
    page.close()
    return report


def verify_corner_quality(source, result, corners, output, name, count):
    """Independent annotated glyph envelope, NOT the detector's broad bbox.

    This leaves the reported scale/architectural labels, badge border, navy
    rectangle and ruler lines protected. Compare lossless browser pixels so
    JPEG roundtrip noise cannot hide collateral erasure. Also save all actual
    downloaded PDF corners for visual grading, not just the first page.
    """
    assert len(corners["before"]) == len(corners["after"]) == count
    # Native 1376x768 fixture coordinates, includes the 2px glyph dilation.
    allowed = (1266 - 1160, 744 - 710, 1372 - 1160, 761 - 710)
    sheet = Image.new("RGB", (1320, count * 190), "white")
    rows = []
    for index in range(count):
        before, after = [Image.open(io.BytesIO(base64.b64decode(corners[k][index].split(',')[1]))).convert("RGB")
                         for k in ["before", "after"]]
        difference = ImageChops.difference(before, after)
        protected = difference.copy()
        ImageDraw.Draw(protected).rectangle((allowed[0], allowed[1], allowed[2] - 1, allowed[3] - 1), fill=(0, 0, 0))
        changed = sum(pixel != (0, 0, 0) for pixel in protected.getdata())
        before.save(output / f"{name}-{index+1:02}-lossless-before.png")
        after.save(output / f"{name}-{index+1:02}-lossless-after.png")
        protected.save(output / f"{name}-{index+1:02}-protected-difference.png")
        assert changed == 0, (name, index + 1, "collateral pixels", changed, protected.getbbox())
        assert difference.getbbox(), (name, index + 1, "nothing removed")
        for column, document in enumerate([source, result]):
            pix = document[index].get_pixmap(clip=pymupdf.Rect(1160, 710, 1376, 768), matrix=pymupdf.Matrix(3, 3))
            crop = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            sheet.paste(crop, (column * 660, index * 190 + 16))
        ImageDraw.Draw(sheet).text((0, index * 190), f"{name} page {index+1}: source left, exported PDF right", fill="black")
        rows.append({"page": index + 1, "changed_protected_pixels": changed})
    sheet.save(output / f"{name}-all-pages.png")
    return rows


def verify_timeout(browser, base, fixture):
    page = browser.new_page()
    # Hold the lazy runtime request open to exercise the real 30-second deadline.
    held_requests = []
    page.route("**/*watermark-opencv-runtime*", lambda route: held_requests.append(route))
    page.goto(base + "/remove-watermark.html", wait_until="networkidle")
    page.locator("#file-input").set_input_files(str(fixture))
    page.locator("#loader-modal").wait_for(state="hidden", timeout=30000)
    page.locator("#auto-detect-btn").click()
    page.locator("#alert-modal").wait_for(state="visible", timeout=30000)
    page.locator("#alert-ok").click()
    page.locator("#process-btn").click()
    page.locator("#alert-modal").wait_for(state="visible", timeout=40000)
    message = page.locator("#alert-message").inner_text()
    assert "OpenCV did not initialize within 30 seconds" in message, message
    page.locator("#loader-modal").wait_for(state="hidden", timeout=1000)
    page.locator("#alert-ok").click()
    page.locator("#clear-selections").click()
    assert "0 regions selected" in page.locator("#selection-info").inner_text()
    for route in held_requests:
        route.abort()
    page.close()
    return {"name": "stalled-runtime", "bounded_failure": True, "editor_recovered": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:5173")
    parser.add_argument("--fixtures", type=Path, default=Path("/Users/deep/repos/ChamPDF-fixtures"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        reports = []
        for name, filename, count, first_only in [
            ("new", "gemini-notebook-new-style.pdf", 15, False),
            ("old", "notebooklm-old-style.pdf", 12, False),
            ("new-first-only", "gemini-notebook-new-style.pdf", 15, True),
        ]:
            report = verify(browser, args.base, args.fixtures / filename, args.output, name, count, first_only)
            reports.append(report)
            print(json.dumps(report), flush=True)
        report = verify_timeout(browser, args.base, args.fixtures / "gemini-notebook-new-style.pdf")
        reports.append(report)
        print(json.dumps(report), flush=True)
        browser.close()
    (args.output / "report.json").write_text(json.dumps(reports, indent=2))


if __name__ == "__main__":
    main()
