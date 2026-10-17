"""
treg gateway client, with urllib mocked. The live behaviour (submit, poll via
replicate.predictions.get, cost header, 402 route_max_cost refusal) was
verified against treg.to on 2026-09-10; these tests pin the client's handling
of those shapes so a regression is caught without spending balance.

Run:  pytest backend/tests/test_treg_client.py -v
"""

from __future__ import annotations

import io
import json
import sys
import urllib.error
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))


class FakeResp(io.BytesIO):
    def __init__(self, status, headers, body):
        super().__init__(body)
        self.status = status
        self.headers = headers

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class Recorder:
    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        url = req.full_url
        for match, resp in self.routes:
            if match in url:
                if callable(resp):
                    resp = resp(req)
                if isinstance(resp, Exception):
                    raise resp
                return resp
        raise AssertionError(f"unexpected request {req.get_method()} {url}")


def http_error(code, headers, body):
    return urllib.error.HTTPError("https://treg.to/x", code, "err", headers, io.BytesIO(body))


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("TREG_TOKEN", "tok_test")
    monkeypatch.setenv("TREG_ORG", "champions-accelerator")
    monkeypatch.delenv("TREG_ORG_ID", raising=False)


def test_headers_meta_and_ceiling(env, monkeypatch):
    import treg_client as t

    rec = Recorder([("treg.to/call/x.y", FakeResp(200, {"X-Treg-Call-Id": "c1", "X-Treg-Cost-Micro": "2500"}, b'{"ok":true}'))])
    monkeypatch.setattr(t.urllib.request, "urlopen", rec)
    r = t.call("x.y", params={"q": "a b"}, meta={"customer": "cust 1@x", "feature": "edit-image"}, max_cost_usd=0.05)
    assert r.json() == {"ok": True}
    assert r.call_id == "c1" and r.cost_micro == 2500 and r.cost_usd == 0.0025 and not r.treg_error
    req = rec.requests[0]
    assert req.full_url == "https://treg.to/call/x.y?q=a+b"
    assert req.get_header("X-treg-token") == "tok_test"
    assert req.get_header("X-treg-org") == "champions-accelerator"
    assert req.get_header("X-treg-route-max-cost") == "0.0500"
    meta = req.get_header("X-treg-meta")
    assert meta.startswith("app=champdf") and "customer=cust_1_x" in meta and "feature=edit-image" in meta


def test_treg_refusal_is_flagged(env, monkeypatch):
    import treg_client as t

    body = json.dumps({"detail": {"error": "route_max_cost", "estimated_cost_micro": 3000}}).encode()
    rec = Recorder([("treg.to/call/", http_error(402, {"X-Treg-Error": "1", "X-Treg-Call-Id": "c9"}, body))])
    monkeypatch.setattr(t.urllib.request, "urlopen", rec)
    with pytest.raises(t.TregError) as ei:
        t.call("replicate.image-gen.flux-schnell", method="POST", body={"input": {}}, max_cost_usd=0.0001)
    assert ei.value.status == 402 and ei.value.treg_error and ei.value.call_id == "c9"
    assert ei.value.detail()["detail"]["error"] == "route_max_cost"


def test_provider_error_is_not_treg_error(env, monkeypatch):
    import treg_client as t

    rec = Recorder([("treg.to/call/", http_error(422, {"X-Treg-Call-Id": "c2"}, b'{"detail":"bad input"}'))])
    monkeypatch.setattr(t.urllib.request, "urlopen", rec)
    with pytest.raises(t.TregError) as ei:
        t.call("some.provider.endpoint")
    assert ei.value.status == 422 and not ei.value.treg_error


def test_run_task_polls_via_descriptor_endpoint(env, monkeypatch):
    import treg_client as t

    monkeypatch.setattr(t.time, "sleep", lambda s: None)
    state = {"polls": 0}

    def poll(req):
        state["polls"] += 1
        status = "processing" if state["polls"] < 2 else "succeeded"
        body = {"id": "task1", "status": status, "output": ["https://cdn.example/out.png"] if status == "succeeded" else None}
        return FakeResp(200, {"X-Treg-Call-Id": f"p{state['polls']}", "X-Treg-Cost-Micro": "0"}, json.dumps(body).encode())

    submit_body = json.dumps({"id": "task1", "status": "starting", "urls": {"get": "https://api.replicate.com/v1/predictions/task1"}}).encode()
    rec = Recorder([
        ("call/replicate.predictions.get?id=task1", poll),
        ("call/replicate.image-gen.flux-schnell", FakeResp(201, {"X-Treg-Call-Id": "s1", "X-Treg-Cost-Micro": "3000"}, submit_body)),
    ])
    monkeypatch.setattr(t.urllib.request, "urlopen", rec)
    descriptor = {"id_from": "id", "poll": {"endpoint": "replicate.predictions.get", "param": {"in": "pathParams", "name": "id"}},
                  "status": {"path": "status", "success": ["succeeded"], "failure": ["failed", "canceled"]},
                  "result": {"path": "output"}, "interval": 2}
    res = t.run_task("replicate.image-gen.flux-schnell", {"input": {"prompt": "x"}}, descriptor=descriptor, timeout=30)
    assert res.task_id == "task1" and res.polls == 2 and res.cost_usd == 0.003
    assert t.first_url(res.result) == "https://cdn.example/out.png"
    assert res.call_ids == ["s1", "p1", "p2"]


def test_replicate_run_polls_urls_get_through_treg(env, monkeypatch):
    import treg_client as t

    monkeypatch.setattr(t.time, "sleep", lambda s: None)
    submit = json.dumps({"id": "abc", "status": "starting", "urls": {"get": "https://api.replicate.com/v1/predictions/abc"}}).encode()
    done = json.dumps({"id": "abc", "status": "succeeded", "output": "https://cdn.example/x.png"}).encode()
    rec = Recorder([
        ("call/https://api.replicate.com/v1/predictions/abc", FakeResp(200, {}, done)),
        ("call/https://api.replicate.com/v1/models/google/nano-banana/predictions", FakeResp(201, {"X-Treg-Call-Id": "s"}, submit)),
    ])
    monkeypatch.setattr(t.urllib.request, "urlopen", rec)
    res = t.replicate_run("google/nano-banana", {"prompt": "p"}, timeout=30)
    assert res.result == "https://cdn.example/x.png"
    assert rec.requests[0].get_method() == "POST"
    assert json.loads(rec.requests[0].data) == {"input": {"prompt": "p"}}
    assert res.cost_usd is None  # own key through treg: unmetered, no cost header


def test_replicate_run_with_pinned_version_uses_predictions_endpoint(env, monkeypatch):
    import treg_client as t

    monkeypatch.setattr(t.time, "sleep", lambda s: None)
    submit = json.dumps({"id": "v1", "status": "succeeded", "output": ["https://cdn.example/y.png"], "urls": {"get": "https://api.replicate.com/v1/predictions/v1"}}).encode()
    rec = Recorder([("call/https://api.replicate.com/v1/predictions", FakeResp(201, {}, submit))])
    monkeypatch.setattr(t.urllib.request, "urlopen", rec)
    res = t.replicate_run("allenhooo/lama:deadbeef", {"image": "data:..."}, timeout=30)
    assert res.polls == 0 and json.loads(rec.requests[0].data)["version"] == "deadbeef"


def test_run_task_failure_raises(env, monkeypatch):
    import treg_client as t

    monkeypatch.setattr(t.time, "sleep", lambda s: None)
    submit = json.dumps({"id": "f", "status": "failed", "error": "NSFW", "urls": {"get": "https://api.replicate.com/v1/predictions/f"}}).encode()
    rec = Recorder([("call/", FakeResp(201, {}, submit))])
    monkeypatch.setattr(t.urllib.request, "urlopen", rec)
    with pytest.raises(t.TregError, match="failed"):
        t.replicate_run("owner/model", {}, timeout=5)


def test_not_configured(monkeypatch):
    import treg_client as t

    monkeypatch.delenv("TREG_TOKEN", raising=False)
    assert not t.treg_configured()
    with pytest.raises(t.TregError):
        t.call("x")
