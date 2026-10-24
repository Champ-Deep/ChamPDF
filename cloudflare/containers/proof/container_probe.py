"""Local container proof for the ChamPDF backend image. Stdlib only; drives docker + HTTP.

Usage: python container_probe.py <image> <fixture_dir>/out <result.json>

Measures with the SAME resource shape as Cloudflare standard-4 (4 vCPU / 12 GiB) via docker limits.
Honest limits: this is Docker on an Apple-silicon (arm64) host. Cloudflare Containers run linux/amd64
on their own hardware, so absolute latencies here are not Cloudflare numbers; RAM, image size,
failure behaviour and request shapes are.
"""
import json, os, subprocess, sys, threading, time, uuid, urllib.request, urllib.error

IMAGE, FX, RESULT = sys.argv[1], sys.argv[2], sys.argv[3]
ADMIN = "probe-admin-" + uuid.uuid4().hex[:8]  # throwaway, only exists for this run
NAME = "champdf-probe"
res = {"image": IMAGE, "ops": {}, "tests": {}}


def sh(*a, check=True):
    return subprocess.run(a, capture_output=True, text=True, check=check).stdout.strip()


def start(name, port, extra=()):
    sh("docker", "rm", "-f", name, check=False)
    t0 = time.monotonic()
    sh("docker", "run", "-d", "--name", name, "--cpus", "4", "--memory", "12g", "-p", f"{port}:8000",
       "-e", f"CHAMPDF_ADMIN_TOKEN={ADMIN}", "-e", "CHAMPDF_DB_PATH=/tmp/champdf/champdf.db", *extra, IMAGE,
       # same command the Container class passes as `entrypoint`: the image CMD binds only "::", unreachable on IPv4
       "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000")
    return t0


def wait_health(port, t0, limit=180):
    while time.monotonic() - t0 < limit:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                if r.status == 200:
                    return round(time.monotonic() - t0, 2)
        except Exception:
            time.sleep(0.25)
    return None


def multipart(fields, files):
    b = "----probe" + uuid.uuid4().hex
    out = b""
    for k, v in fields.items():
        out += f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    for k, (fn, data) in files.items():
        out += f'--{b}\r\nContent-Disposition: form-data; name="{k}"; filename="{fn}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + data + b"\r\n"
    return out + f"--{b}--\r\n".encode(), f"multipart/form-data; boundary={b}"


def call(port, method, path, headers=None, fields=None, files=None, timeout=900):
    body, ctype = (multipart(fields or {}, files or {}) if files is not None else (None, None))
    h = dict(headers or {})
    if ctype:
        h["Content-Type"] = ctype
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body, method=method, headers=h)
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read(); code = r.status
    except urllib.error.HTTPError as e:
        data = e.read(); code = e.code
    except Exception as e:  # connection reset etc
        return {"status": None, "error": type(e).__name__, "secs": round(time.monotonic() - t0, 2), "bytes": 0}, b""
    return {"status": code, "secs": round(time.monotonic() - t0, 2), "bytes": len(data)}, data


class Sampler(threading.Thread):
    """docker stats once a second; keeps peak memory and CPU."""
    def __init__(self, name):
        super().__init__(daemon=True); self.name_, self.stop_, self.mem, self.cpu = name, False, 0.0, 0.0

    def run(self):
        while not self.stop_:
            o = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}|{{.CPUPerc}}", self.name_], capture_output=True, text=True).stdout.strip()
            if "|" in o:
                m, c = o.split("|")
                used = m.split("/")[0].strip()
                v = float(used.rstrip("MiBGKi"))
                mib = v * 1024 if used.endswith("GiB") else v / 1024 if used.endswith("KiB") else v
                self.mem = max(self.mem, mib); self.cpu = max(self.cpu, float(c.strip("%") or 0))
            time.sleep(0.2)


def rd(n):
    return open(os.path.join(FX, n), "rb").read()


def key_for(port):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/v1/admin/keys", data=json.dumps({"label": "probe", "monthly_quota": 100000}).encode(),
                                 headers={"X-Admin-Token": ADMIN, "Content-Type": "application/json"}, method="POST")
    return json.load(urllib.request.urlopen(req))["key"]


P = 18080
res["image_size_bytes"] = int(sh("docker", "image", "inspect", IMAGE, "--format", "{{.Size}}"))
res["image_id"] = sh("docker", "image", "inspect", IMAGE, "--format", "{{.Id}}")

# 1. cold start
t0 = start(NAME, P)
res["cold_start_to_health_s"] = wait_health(P, t0)
smp = Sampler(NAME); smp.start()
res["idle_mem_mib"] = None
time.sleep(1.5); res["idle_mem_mib"] = smp.mem

# 2. operations
K = key_for(P); AUTH = {"Authorization": "Bearer " + K}
res["api_key_prefix_ok"] = K.startswith("champdf_live_")
ops = [
    ("convert_docx_to_pdf", "/api/v1/convert/to-pdf", {}, {"file": ("sample.docx", rd("sample.docx"))}),
    ("pdf_to_text_10p", "/api/v1/pdf/to-text", {}, {"file": ("t.pdf", rd("text10.pdf"))}),
    ("ocr_scanned_pdf_11MB", "/api/v1/pdf/ocr", {"language": "eng", "pdfa": "false"}, {"file": ("s.pdf", rd("scan1.pdf"))}),
    ("pdf_sign", "/api/v1/pdf/sign", {"passphrase": "proofpass", "timestamp": "false"}, {"file": ("t.pdf", rd("text10.pdf")), "cert": ("c.p12", rd("signer.p12"))}),
    ("image_remove_bg_1024", "/api/v1/image/remove-bg", {}, {"image": ("p.png", rd("photo.png"))}),
    ("image_remove_bg_transparent_in", "/api/v1/image/remove-bg", {}, {"image": ("t.png", rd("transparent.png"))}),
    ("video_remove_logo_720p_5s", "/api/v1/video/remove-logo", {"logo_preset": "none"}, {"file": ("v.mp4", rd("video_720p_5s.mp4"))}),
    ("video_remove_logo_1080p_30s_21MB", "/api/v1/video/remove-logo", {"logo_preset": "none"}, {"file": ("v.mp4", rd("video_1080p_30s.mp4"))}),
]
signed = b""
for name, path, fields, files in ops:
    r, d = call(P, "POST", path, AUTH, fields, files)
    if name == "pdf_sign" and r["status"] == 200:
        signed = d
    r["magic"] = d[:8].decode("latin1") if d[:4] in (b"%PDF", b"\x89PNG") else d[4:8].decode("latin1") if d[4:8] == b"ftyp" else None
    if r["status"] and r["status"] >= 400:
        r["detail"] = d[:200].decode("latin1")
    res["ops"][name] = r
if signed:
    open(os.path.join(FX, "signed.pdf"), "wb").write(signed)
    r, d = call(P, "POST", "/api/v1/pdf/verify-signature", AUTH, {}, {"file": ("signed.pdf", signed)})
    r["report_head"] = d[:300].decode("latin1"); res["ops"]["verify_signature"] = r
    tam = bytearray(signed); tam[len(tam) // 2] ^= 0xFF  # flip a byte, verification must notice
    r, d = call(P, "POST", "/api/v1/pdf/verify-signature", AUTH, {}, {"file": ("tamper.pdf", bytes(tam))})
    r["report_head"] = d[:300].decode("latin1"); res["ops"]["verify_signature_tampered"] = r
res["peak_mem_mib_after_ops"], res["peak_cpu_pct_after_ops"] = round(smp.mem), smp.cpu

# 3. repeat request (warm) latency
res["warm_repeat"] = [call(P, "POST", "/api/v1/pdf/to-text", AUTH, {}, {"file": ("t.pdf", rd("text10.pdf"))})[0]["secs"] for _ in range(5)]

# 4. concurrency: 4 parallel OCR calls on one 4 vCPU instance
outs = []
def one(): outs.append(call(P, "POST", "/api/v1/pdf/ocr", AUTH, {"language": "eng", "pdfa": "false"}, {"file": ("s.pdf", rd("scan1.pdf"))})[0])
t0c = time.monotonic(); th = [threading.Thread(target=one) for _ in range(4)]
[t.start() for t in th]; [t.join() for t in th]
res["tests"]["concurrent_ocr_x4"] = {"wall_s": round(time.monotonic() - t0c, 2), "each": outs}
res["peak_mem_mib_final"], res["peak_cpu_pct_final"] = round(smp.mem), smp.cpu

# 5. persistence: docker restart keeps the writable layer; a Cloudflare replacement does not
call(P, "GET", "/health")
sh("docker", "restart", NAME); wait_health(P, time.monotonic())
r, _ = call(P, "GET", "/api/v1/whoami", AUTH)
res["tests"]["key_after_docker_restart_same_disk"] = r["status"]
sh("docker", "rm", "-f", NAME)
t0 = start(NAME, P); wait_health(P, t0)
r, _ = call(P, "GET", "/api/v1/whoami", AUTH)
res["tests"]["key_after_replacement_fresh_disk"] = r["status"]

# 6. interrupted job: kill the container mid video request on a fresh instance
K2 = key_for(P); A2 = {"Authorization": "Bearer " + K2}
box = {}
def long(): box["r"] = call(P, "POST", "/api/v1/video/remove-logo", A2, {"logo_preset": "none"}, {"file": ("v.mp4", rd("video_1080p_30s.mp4"))})[0]
th = threading.Thread(target=long); th.start(); time.sleep(5)
sh("docker", "kill", NAME); th.join(60)
t0 = start(NAME, P); wait_health(P, t0)
r2, _ = call(P, "GET", "/api/v1/whoami", A2)
r3, _ = call(P, "GET", "/api/v1/whoami", {"Authorization": "Bearer " + K2})
res["tests"]["interrupted_video_request"] = {"client_saw": box.get("r"), "key_after_replacement": r2["status"],
                                              "job_status_endpoint_exists": call(P, "GET", "/api/jobs/anything", AUTH)[0]["status"]}
smp.stop_ = True
sh("docker", "rm", "-f", NAME)

# 7. multi-instance: two containers, separate disks
start("champdf-probe-a", 18081); start("champdf-probe-b", 18082)
wait_health(18081, time.monotonic()); wait_health(18082, time.monotonic())
Ka = key_for(18081)
res["tests"]["multi_instance"] = {"key_on_A_seen_by_A": call(18081, "GET", "/api/v1/whoami", {"Authorization": "Bearer " + Ka})[0]["status"],
                                  "key_on_A_seen_by_B": call(18082, "GET", "/api/v1/whoami", {"Authorization": "Bearer " + Ka})[0]["status"]}
# burst limiter is in-process memory: N instances = N x the per-key budget
sh("docker", "rm", "-f", "champdf-probe-a", "champdf-probe-b")
json.dump(res, open(RESULT, "w"), indent=2)
print(json.dumps(res, indent=2))
