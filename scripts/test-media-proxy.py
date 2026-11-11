"""Exercise the production Nginx entrypoint and real multipart upload limits.

Run: python3 scripts/test-media-proxy.py
Requires Docker. The upstream only counts bytes, it does not process media.
No API keys or ML model downloads are needed.
"""
import http.client
import json
import re
import subprocess
import threading
import time
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "nginxinc/nginx-unprivileged:stable-alpine-slim"
MIB = 1024 * 1024


class UploadCounter(BaseHTTPRequestHandler):
    def do_POST(self):
        remaining = int(self.headers["Content-Length"])
        received = 0
        while remaining:
            chunk = self.rfile.read(min(remaining, MIB))
            if not chunk:
                return
            received += len(chunk)
            remaining -= len(chunk)
        body = json.dumps({"path": self.path, "received": received}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, format, *args):
        pass


@contextmanager
def proxy(dockerfile, backend_port):
    """Use the actual Dockerfile template destination and envsubst settings."""
    source = (ROOT / dockerfile).read_text()
    match = re.search(
        r"COPY (?:--chown=nginx:nginx )?(nginx[^ ]*) (/etc/nginx/templates/[^\s]+)",
        source,
    )
    assert match, f"No Nginx template COPY in {dockerfile}"
    template, target = match.groups()
    env = dict(re.findall(r"^ENV (NGINX_ENVSUBST_[A-Z_]+)=(.*)$", source, re.M))
    env.update(PORT="8080", BACKEND_URL=f"http://host.docker.internal:{backend_port}")
    args = ["docker", "run", "-d", "-p", "127.0.0.1::8080",
            "--add-host", "host.docker.internal:host-gateway",
            "--tmpfs", "/etc/nginx/tmp:uid=101,gid=101",
            "-v", f"{ROOT / template}:{target}:ro"]
    for key, value in env.items():
        args.extend(["-e", f"{key}={value}"])
    name = subprocess.check_output(args + [IMAGE], text=True).strip()
    try:
        port_text = subprocess.check_output(["docker", "port", name, "8080/tcp"], text=True)
        port = int(port_text.strip().split(":")[-1])
        for _ in range(100):
            try:
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                conn.request("GET", "/api/readiness")
                response = conn.getresponse()
                response.read()
                conn.close()
                if response.status == 200:
                    break
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(0.1)
        else:
            logs = subprocess.check_output(["docker", "logs", name], stderr=subprocess.STDOUT, text=True)
            raise AssertionError(f"{dockerfile} failed to start:\n{logs}")
        subprocess.run(["docker", "exec", name, "nginx", "-t"], check=True)
        yield port
    finally:
        subprocess.run(["docker", "stop", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["docker", "rm", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def upload(port, path, size, filename, fields):
    boundary = "champdf-upload-regression"
    prefix = b""
    for key, value in fields.items():
        prefix += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
    prefix += f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()
    suffix = f"\r\n--{boundary}--\r\n".encode()
    total = len(prefix) + size + len(suffix)
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    try:
        conn.putrequest("POST", path)
        conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
        conn.putheader("Content-Length", str(total))
        conn.endheaders()
        conn.send(prefix)
        chunk = b"x" * MIB
        remaining = size
        while remaining:
            n = min(remaining, len(chunk))
            conn.send(chunk[:n])
            remaining -= n
        conn.send(suffix)
        response = conn.getresponse()
        return response.status, response.read(), total
    finally:
        conn.close()


class MediaProxyTests(unittest.TestCase):
    def test_production_upload_routes(self):
        backend = ThreadingHTTPServer(("0.0.0.0", 0), UploadCounter)
        thread = threading.Thread(target=backend.serve_forever, daemon=True)
        thread.start()
        try:
            for dockerfile in ("Dockerfile", "Dockerfile.frontend"):
                with self.subTest(dockerfile=dockerfile), proxy(dockerfile, backend.server_port) as port:
                    cases = [
                        ("/api/remove-background", 10 * MIB, "portrait.png", {"output_format": "png"}),
                        ("/api/process-video", 100 * MIB, "watermarked.mp4", {
                            "logo_preset": "none", "watermark_position": "bottom-right",
                            "logo_scale": "1", "quality": "fast",
                        }),
                        # API suffixes must not be captured by static JSON locations.
                        ("/api/probe.json", 2 * MIB, "probe.png", {}),
                    ]
                    for path, size, filename, fields in cases:
                        with self.subTest(path=path):
                            status, body, total = upload(port, path, size, filename, fields)
                            self.assertEqual(status, 200, body.decode(errors="replace"))
                            self.assertEqual(json.loads(body), {"path": path, "received": total})
                            print(f"PASS {dockerfile}: {path}, {size} file bytes + multipart = {total}")
                    # The proxy remains bounded. Send only headers so Nginx rejects
                    # oversized bodies immediately, without transferring 102 MiB.
                    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                    try:
                        conn.putrequest("POST", "/api/process-video")
                        conn.putheader("Content-Length", str(102 * MIB))
                        conn.endheaders()
                        response = conn.getresponse()
                        self.assertEqual(response.status, 413)
                        response.read()
                    finally:
                        conn.close()
        finally:
            backend.shutdown()
            backend.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main(verbosity=2)
