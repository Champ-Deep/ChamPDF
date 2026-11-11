"""
Media provider switch: resolution rules and the hosted paths with the network
mocked. Local engines are stand-ins; nothing here loads torch.

Run:  pytest backend/tests/test_media_providers.py -v
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))


def png_bytes(size=(32, 24), color=(200, 40, 40, 255)):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGBA", size, color).save(buf, format="PNG")
    return buf.getvalue()


class FakeLocal:
    def __init__(self, tag):
        self.tag = tag

    async def inpaint(self, image, mask):
        return b"LAMA" + image[:4]

    async def upscale(self, image, scale=2, output_format="png"):
        return b"ESRGAN"

    async def remove_background(self, image, output_format="png"):
        return b"REMBG"


@pytest.fixture
def clean_env(monkeypatch):
    for k in ("TREG_TOKEN", "TREG_ORG", "REPLICATE_API_TOKEN", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "OPENROUTER_VIA_TREG",
              "REPLICATE_VIA_TREG", "MEDIA_EDIT_PROVIDER", "MEDIA_INPAINT_PROVIDER", "MEDIA_BG_PROVIDER", "MEDIA_UPSCALE_PROVIDER"):
        monkeypatch.delenv(k, raising=False)
    import media_providers as mp

    mp.configure_local(lama=None, upscaler=None, image_processor=None)
    yield mp
    mp.configure_local(lama=None, upscaler=None, image_processor=None)


def test_nothing_configured(clean_env):
    mp = clean_env
    assert mp.resolve("edit_image") is None
    assert mp.resolve("inpaint") == "opencv"
    assert mp.resolve("remove_background") is None
    assert mp.resolve("upscale") is None
    d = mp.describe()
    assert d["edit_image"]["available"] is False and d["treg_configured"] is False


def test_local_engines_win_by_default(clean_env):
    mp = clean_env
    mp.configure_local(lama=FakeLocal("l"), upscaler=FakeLocal("u"), image_processor=FakeLocal("i"))
    assert mp.resolve("inpaint") == "local" and mp.resolve("upscale") == "local" and mp.resolve("remove_background") == "local"
    res = asyncio.run(mp.upscale(png_bytes(), scale=2))
    assert res.provider == "local" and res.data == b"ESRGAN"


def test_explicit_replicate_via_treg(clean_env, monkeypatch):
    mp = clean_env
    mp.configure_local(lama=FakeLocal("l"), upscaler=FakeLocal("u"), image_processor=FakeLocal("i"))
    monkeypatch.setenv("TREG_TOKEN", "tok")
    monkeypatch.setenv("MEDIA_UPSCALE_PROVIDER", "replicate")
    assert mp.resolve("upscale") == "replicate"
    assert mp.describe()["upscale"] == {"provider": "replicate", "available": True, "setting": "replicate",
                                        "model": "nightmareai/real-esrgan", "via": "treg"}

    import treg_client as t

    calls = {}

    def fake_replicate_run(model, inputs, timeout, meta, max_cost_usd):
        calls.update(model=model, inputs=inputs, meta=meta, max_cost_usd=max_cost_usd)
        return t.TaskResult(result=["https://cdn.example/up.png"], task_id="t", submit=t.TregResponse(201, {"x-treg-call-id": "c"}, b"{}", "u"), final={})

    monkeypatch.setattr(t, "replicate_run", fake_replicate_run)
    monkeypatch.setattr(t, "download", lambda url, **kw: png_bytes((64, 48)))
    res = asyncio.run(mp.upscale(png_bytes(), scale=2, output_format="jpg"))
    assert res.provider == "replicate" and res.model == "nightmareai/real-esrgan" and res.call_id == "c"
    assert calls["inputs"]["scale"] == 2 and calls["inputs"]["image"].startswith("data:image/png;base64,")
    assert calls["max_cost_usd"] == 0.25 and calls["meta"] == {"feature": "upscale"}
    assert res.data[:3] == b"\xff\xd8\xff"  # converted to JPEG on request


def test_auto_prefers_replicate_when_local_missing(clean_env, monkeypatch):
    mp = clean_env
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_test")
    assert mp.resolve("remove_background") == "replicate"
    assert mp.describe()["remove_background"]["via"] == "direct"


def test_inpaint_falls_back_to_opencv_when_hosted_fails(clean_env, monkeypatch):
    mp = clean_env
    monkeypatch.setenv("TREG_TOKEN", "tok")
    monkeypatch.setenv("MEDIA_INPAINT_PROVIDER", "replicate")
    import treg_client as t

    def boom(*a, **k):
        raise t.TregError("provider answered 503", status=503)

    monkeypatch.setattr(t, "replicate_run", boom)
    img = png_bytes((40, 30)); mask = png_bytes((40, 30), (255, 255, 255, 255))
    res = asyncio.run(mp.inpaint(img, mask))
    assert res.provider == "opencv" and res.data.startswith(b"\x89PNG")


def test_edit_image_openrouter_direct(clean_env, monkeypatch):
    mp = clean_env
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    assert mp.resolve("edit_image") == "openrouter"
    out_png = png_bytes((32, 24), (0, 0, 255, 255))
    reply = {"created": 1, "data": [{"b64_json": base64.b64encode(out_png).decode(), "media_type": "image/png"}],
             "usage": {"cost": 0.04}}
    seen = {}

    class R(io.BytesIO):
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        seen["url"] = req.full_url
        seen["body"] = json.loads(req.data)
        seen["auth"] = req.get_header("Authorization")
        return R(json.dumps(reply).encode())

    monkeypatch.setattr(mp.urllib.request, "urlopen", fake_urlopen)
    res = asyncio.run(mp.edit_image(png_bytes(), "make it blue"))
    assert res.provider == "openrouter" and res.model == "google/gemini-2.5-flash-image"
    assert res.data.startswith(b"\x89PNG") and res.cost_usd == 0.04
    assert seen["url"] == mp.OPENROUTER_IMAGES_URL and seen["auth"] == "Bearer sk-or-test"
    assert seen["body"]["prompt"] == "make it blue" and seen["body"]["model"] == "google/gemini-2.5-flash-image"
    ref = seen["body"]["input_references"][0]
    assert ref["type"] == "image_url" and ref["image_url"]["url"].startswith("data:image/png;base64,")


def test_openrouter_chat_shape_still_parses(clean_env):
    mp = clean_env
    out_png = png_bytes((8, 8))
    payload = {"choices": [{"message": {"images": [{"image_url": {"url": "data:image/png;base64," + base64.b64encode(out_png).decode()}}]}}]}
    assert mp._extract_openrouter_image(payload) == out_png
    assert mp._extract_openrouter_image({"choices": []}) is None


def test_edit_image_replicate_nano_banana(clean_env, monkeypatch):
    mp = clean_env
    monkeypatch.setenv("TREG_TOKEN", "tok")
    monkeypatch.setenv("MEDIA_EDIT_PROVIDER", "replicate")
    import treg_client as t

    calls = {}

    def fake_replicate_run(model, inputs, timeout, meta, max_cost_usd):
        calls.update(model=model, inputs=inputs)
        return t.TaskResult(result="https://cdn.example/e.png", task_id="t", submit=t.TregResponse(201, {}, b"{}", "u"), final={})

    monkeypatch.setattr(t, "replicate_run", fake_replicate_run)
    monkeypatch.setattr(t, "download", lambda url, **kw: png_bytes())
    res = asyncio.run(mp.edit_image(png_bytes(), "remove the text"))
    assert res.provider == "replicate" and calls["model"] == "google/nano-banana"
    assert calls["inputs"]["prompt"] == "remove the text" and len(calls["inputs"]["image_input"]) == 1


def test_edit_image_validation_and_not_configured(clean_env):
    mp = clean_env
    with pytest.raises(mp.MediaError) as ei:
        asyncio.run(mp.edit_image(png_bytes(), "   "))
    assert ei.value.code == "invalid_input"
    with pytest.raises(mp.MediaError) as ei:
        asyncio.run(mp.edit_image(png_bytes(), "hello"))
    assert ei.value.code == "not_configured"


def test_off_disables_capability(clean_env, monkeypatch):
    mp = clean_env
    mp.configure_local(upscaler=FakeLocal("u"))
    monkeypatch.setenv("MEDIA_UPSCALE_PROVIDER", "off")
    assert mp.resolve("upscale") is None
