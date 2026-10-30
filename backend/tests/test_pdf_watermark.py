from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

fitz = pytest.importorskip("fitz")
pikepdf = pytest.importorskip("pikepdf")

import pdf_watermark as pw  # noqa: E402

BODY = "The quick brown fox jumps over the lazy dog. Quarterly revenue grew twelve percent. " * 12


def _body_page(doc, n):
    page = doc.new_page()
    page.insert_text((72, 72), f"Report page {n}", fontsize=18)
    page.insert_textbox(fitz.Rect(72, 100, 540, 700), BODY, fontsize=11)
    page.insert_text((72, 770), f"Footer page {n}", fontsize=9)
    return page


def _text(pdf_bytes):
    with fitz.open(stream=pdf_bytes, filetype="pdf") as d:
        return [p.get_text() for p in d]


def _draft_doc(pages=3):
    doc = fitz.open()
    for i in range(pages):
        page = _body_page(doc, i + 1)
        page.insert_text((150, 560), "DRAFT", fontsize=110, color=(0.5, 0.5, 0.5), fill_opacity=0.25,
                         morph=(fitz.Point(306, 450), fitz.Matrix(-30)))
        page.insert_text((430, 775), "ACME CORP", fontsize=16, color=(0.1, 0.3, 0.8), fill_opacity=0.6)
    return doc.tobytes()


def test_detects_translucent_rotated_and_repeated_marks():
    found = pw.detect(_draft_doc())
    texts = sorted({r["text"] for r in found["regions"]})
    assert texts == ["ACME CORP", "DRAFT"]
    assert {r["pageIndex"] for r in found["regions"]} == {0, 1, 2}
    draft = next(r for r in found["regions"] if r["text"] == "DRAFT")
    assert any("opacity" in why for why in draft["reasons"])
    assert any("rotated" in why for why in draft["reasons"])


def test_auto_removal_keeps_body_text_and_drops_marks_from_text_layer():
    src = _draft_doc()
    out, report = pw.remove(src)
    assert report["removed"] == 6
    before, after = _text(src), _text(out)
    for b, a in zip(before, after):
        assert "DRAFT" in b and "DRAFT" not in a
        assert "ACME CORP" not in a
        assert a.count("quick brown fox") == b.count("quick brown fox")
        assert "Footer page" in a


def test_region_mode_removes_only_the_mark_under_the_box():
    src = _draft_doc(pages=1)
    draft = next(r for r in pw.detect(src)["regions"] if r["text"] == "DRAFT")
    region = {k: draft[k] for k in ("x", "y", "width", "height")}
    region = {**region, "x": region["x"] - 0.02, "width": region["width"] + 0.04, "pageIndex": 0}
    out, report = pw.remove(src, regions=[region])
    after = _text(out)[0]
    assert "DRAFT" not in after
    assert "ACME CORP" in after
    assert after.count("quick brown fox") == _text(src)[0].count("quick brown fox")
    assert report["unmatched"] == []


def test_region_prefers_the_watermark_over_repeated_boilerplate():
    src = _draft_doc(pages=3)
    draft = next(r for r in pw.detect(src)["regions"] if r["text"] == "DRAFT" and r["pageIndex"] == 0)
    region = {"pageIndex": 0, **{k: draft[k] for k in ("x", "y", "width", "height")}}
    out, report = pw.remove(src, regions=[region])
    before, after = _text(src)[0], _text(out)[0]
    assert report["removed"] == 1
    assert "DRAFT" not in after
    assert after.count("quick brown fox") == before.count("quick brown fox")


def test_clean_documents_are_untouched():
    doc = fitz.open()
    for i in range(3):
        page = _body_page(doc, i + 1)
        page.draw_rect(fitz.Rect(0, 0, 595, 40), color=None, fill=(0.9, 0.4, 0.1), fill_opacity=0.5)
        if i == 1:
            page.draw_rect(fitz.Rect(100, 600, 300, 680), color=None, fill=(0.2, 0.5, 0.9), fill_opacity=0.4)
    src = doc.tobytes()
    assert pw.detect(src)["regions"] == []
    out, report = pw.remove(src)
    assert report["removed"] == 0
    assert _text(out) == _text(src)


def test_repeated_plain_footer_needs_a_region():
    doc = fitz.open()
    for i in range(3):
        page = _body_page(doc, i + 1)
        page.insert_text((300, 780), "Company Confidential", fontsize=9)
    src = doc.tobytes()
    assert pw.detect(src)["regions"] == []
    with fitz.open(stream=src, filetype="pdf") as d:
        hit = d[0].search_for("Company Confidential")[0]
        w, h = d[0].rect.width, d[0].rect.height
    region = {"pageIndex": 0, "x": hit.x0 / w - 0.01, "y": hit.y0 / h - 0.01,
              "width": hit.width / w + 0.02, "height": hit.height / h + 0.02}
    out, _ = pw.remove(src, regions=[region])
    after = _text(out)
    assert "Company Confidential" not in after[0]
    assert "Company Confidential" in after[1]


def test_optional_content_layer_named_watermark_is_definite():
    doc = fitz.open()
    page = _body_page(doc, 1)
    ocg = doc.add_ocg("Watermark", on=True)
    page.insert_text((200, 400), "SAMPLE", fontsize=14, oc=ocg)
    src = doc.tobytes()
    regions = pw.detect(src)["regions"]
    assert [r["text"] for r in regions] == ["SAMPLE"]
    assert regions[0]["score"] >= pw.DEFINITE
    out, _ = pw.remove(src)
    assert "SAMPLE" not in _text(out)[0]
    assert "quick brown fox" in _text(out)[0]


def test_acrobat_watermark_artifact_form_is_removed():
    stamp = fitz.open()
    stamp.new_page(width=300, height=100).insert_text((20, 60), "PAID", fontsize=40, color=(1, 0, 0))
    doc = fitz.open()
    page = _body_page(doc, 1)
    page.show_pdf_page(fitz.Rect(300, 300, 500, 367), stamp, 0)
    raw = io.BytesIO(doc.tobytes())

    with pikepdf.open(raw) as pdf:
        pg = pdf.pages[0]
        ins = pikepdf.parse_content_stream(pg)
        out = []
        for i in ins:
            if str(i.operator) == "Do":
                props = pikepdf.Dictionary(Type=pikepdf.Name.Pagination, Subtype=pikepdf.Name.Watermark)
                out.append(pikepdf.ContentStreamInstruction([pikepdf.Name.Artifact, props], pikepdf.Operator("BDC")))
                out.append(i)
                out.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("EMC")))
            else:
                out.append(i)
        pg.obj.Contents = pdf.make_stream(pikepdf.unparse_content_stream(out))
        buf = io.BytesIO()
        pdf.save(buf)
    src = buf.getvalue()

    regions = pw.detect(src)["regions"]
    assert len(regions) == 1 and regions[0]["kind"] == "form" and regions[0]["score"] >= pw.DEFINITE
    out_bytes, report = pw.remove(src)
    assert report["removed"] == 1
    assert "PAID" in _text(src)[0] and "PAID" not in _text(out_bytes)[0]
    assert "quick brown fox" in _text(out_bytes)[0]


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_fractions_follow_the_viewer_for_rotated_pages(rotation):
    doc = fitz.open()
    page = doc.new_page()
    page.insert_textbox(fitz.Rect(72, 400, 540, 700), BODY, fontsize=11)
    page.insert_text((100, 200), "STAMP", fontsize=60, fill_opacity=0.3)
    page.set_rotation(rotation)
    src = doc.tobytes()
    region = pw.detect(src)["regions"][0]
    with fitz.open(stream=src, filetype="pdf") as d:
        p = d[0]
        hit = p.search_for("STAMP")[0] * p.rotation_matrix
        cx = (hit.x0 + hit.x1) / 2 / p.rect.width
        cy = (hit.y0 + hit.y1) / 2 / p.rect.height
    assert abs(region["x"] + region["width"] / 2 - cx) < 0.05
    assert abs(region["y"] + region["height"] / 2 - cy) < 0.05


def test_raster_region_is_inpainted_inside_the_image_at_native_resolution():
    from PIL import Image

    img = Image.new("RGB", (1200, 900), (30, 90, 160))
    for x in range(1050, 1180):
        for y in range(820, 880):
            img.putpixel((x, y), (250, 250, 250))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    doc = fitz.open()
    page = doc.new_page(width=800, height=600)
    page.insert_image(page.rect, stream=buf.getvalue())
    src = doc.tobytes()

    calls = []

    def fake_inpaint(image_png: bytes, mask_png: bytes) -> bytes:
        im = Image.open(io.BytesIO(image_png)).convert("RGB")
        mask = Image.open(io.BytesIO(mask_png)).convert("L")
        calls.append(mask.getbbox())
        im.paste((30, 90, 160), mask=mask)
        out = io.BytesIO()
        im.save(out, "PNG")
        return out.getvalue()

    region = {"pageIndex": 0, "x": 1040 / 1200, "y": 810 / 900, "width": 150 / 1200, "height": 80 / 900}
    out, report = pw.remove(src, regions=[region], inpaint=fake_inpaint)
    assert report["imagePatches"] == 1 and report["unmatched"] == []
    assert calls and calls[0] is not None

    with pikepdf.open(io.BytesIO(out)) as pdf:
        xobjs = pdf.pages[0].Resources.XObject
        result = pikepdf.PdfImage(xobjs[list(xobjs.keys())[0]]).as_pil_image().convert("RGB")
    assert result.size == (1200, 900)
    assert result.getpixel((1100, 850)) == (30, 90, 160)
    assert result.getpixel((10, 10)) == (30, 90, 160)


def test_region_without_anything_removable_is_reported():
    src = _draft_doc(pages=1)
    region = {"pageIndex": 0, "x": 0.02, "y": 0.02, "width": 0.03, "height": 0.02}
    _, report = pw.remove(src, regions=[region])
    assert report["removed"] == 0
    assert len(report["unmatched"]) == 1


def test_password_protected_pdf_has_a_clear_error():
    doc = fitz.open()
    _body_page(doc, 1)
    src = doc.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="o", user_pw="u")
    with pytest.raises(pw.WatermarkError, match="password"):
        pw.detect(src)


def test_translucent_png_logo_repeated_on_every_page_is_removed():
    from PIL import Image, ImageDraw

    logo = Image.new("RGBA", (300, 300), (0, 0, 0, 0))
    ImageDraw.Draw(logo).ellipse((20, 20, 280, 280), fill=(230, 90, 20, 90))
    buf = io.BytesIO()
    logo.save(buf, "PNG")
    doc = fitz.open()
    for i in range(3):
        page = _body_page(doc, i + 1)
        page.insert_image(fitz.Rect(150, 270, 445, 565), stream=buf.getvalue())
    src = doc.tobytes()
    found = pw.detect(src)["regions"]
    assert len(found) == 3 and all(r["kind"] == "image" for r in found)
    out, report = pw.remove(src)
    assert report["removed"] == 3
    with fitz.open(stream=out, filetype="pdf") as d:
        assert all(not p.get_images() for p in d)


def test_large_box_on_a_scan_clears_the_mark_without_inpainting_the_text():
    from PIL import Image

    img = Image.new("RGB", (1000, 1400), (250, 250, 247))
    px = img.load()
    for y in range(500, 900):
        for x in range(0, 600):
            px[x, y] = (215, 215, 213)
    for y in range(600, 612):
        for x in range(100, 800):
            px[x, y] = (30, 30, 30)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    doc = fitz.open()
    page = doc.new_page(width=500, height=700)
    page.insert_image(page.rect, stream=buf.getvalue())

    def no_inpaint(image_png: bytes, mask_png: bytes) -> bytes:
        raise AssertionError("document boxes should not go through LaMa")

    region = {"pageIndex": 0, "x": 0.0, "y": 0.35, "width": 0.62, "height": 0.30}
    out, report = pw.remove(doc.tobytes(), regions=[region], inpaint=no_inpaint)
    assert report["imagePatches"] == 1
    with pikepdf.open(io.BytesIO(out)) as pdf:
        xobjs = pdf.pages[0].Resources.XObject
        result = pikepdf.PdfImage(xobjs[list(xobjs.keys())[0]]).as_pil_image().convert("RGB")
    assert result.getpixel((300, 700)) == (250, 250, 247)
    assert result.getpixel((300, 606)) == (30, 30, 30)
    assert result.getpixel((750, 606)) == (30, 30, 30)
