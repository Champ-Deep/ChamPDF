#!/usr/bin/env bash
# Phase 1 local end-to-end proof. LOCAL ONLY: wrangler dev --env local + Docker. No deploy, no --remote, no login.
# Needs cloudflare/containers/.dev.vars with CHAMPDF_INTERNAL_TOKEN and CHAMPDF_ADMIN_TOKEN (gitignored, never printed).
# Writes proof/results/phase1-e2e.json {check: {pass, status, seconds, note}}. Exits 0 only if every check passes.
set -uo pipefail
cd "$(dirname "$0")/.."
CT=$PWD
WORK=$(mktemp -d "${TMPDIR:-/tmp}/p1e2e.XXXXXX")
IMG=champdf-p1e2e:local
export CT WORK IMG

PERSIST="$WORK/state"   # fresh wrangler state every run, so a leftover alarm or warm container cannot fake a pass
export PERSIST
WPID=""
teardown() {
  # only our own wrangler dev process tree, only workerd-champdf-api-local-* containers and p1-sign
  if [ -n "$WPID" ]; then
    pkill -P "$WPID" 2>/dev/null; kill "$WPID" 2>/dev/null; sleep 2
  fi
  for c in $(docker ps -aq --filter name=workerd-champdf-api-local); do docker rm -f "$c" >/dev/null 2>&1; done
  docker rm -f p1-sign >/dev/null 2>&1
  docker volume rm p1-sign-data >/dev/null 2>&1
  rm -rf "$WORK"
}
trap teardown EXIT

LEFT=$(docker ps -aq --filter name=workerd-champdf-api-local)
if [ -n "$LEFT" ] || docker ps -a --format '{{.Names}}' | grep -qx p1-sign; then
  echo "refusing to start: leftover workerd-champdf-api-local-* or p1-sign container exists (docker rm -f them, check they are not another lane's)"; trap - EXIT; rm -rf "$WORK"; exit 1
fi
docker volume rm p1-sign-data >/dev/null 2>&1
echo "== build backend image (shares layer cache with wrangler's build)"
docker build -q -t "$IMG" ../../backend >/dev/null || { echo "image build failed"; exit 1; }

echo "== fixtures"
mkdir -p "$WORK/fx"
cp proof/gen_fixtures.py "$WORK/fx/"
docker run --rm -v "$WORK/fx:/fx" "$IMG" python /fx/gen_fixtures.py >/dev/null || { echo "fixtures failed"; exit 1; }
export FX="$WORK/fx/out"

echo "== Railway stand-in Sign backend on :8001"
docker run -d --name p1-sign -p 8001:8000 -v p1-sign-data:/app/data "$IMG" uvicorn main:app --host 0.0.0.0 --port 8000 >/dev/null || exit 1

echo "== local D1 migrations (fresh state dir)"
npx wrangler d1 migrations apply champdf-local --local --env local --persist-to "$PERSIST" >"$WORK/migrate.log" 2>&1 || { cat "$WORK/migrate.log"; exit 1; }

echo "== wrangler dev --env local on :8787"
npx wrangler dev --env local --port 8787 --persist-to "$PERSIST" >"$WORK/dev.log" 2>&1 &
WPID=$!
for _ in $(seq 1 600); do
  curl -s -o /dev/null http://127.0.0.1:8787/api/sign/status && break
  kill -0 "$WPID" 2>/dev/null || { tail -30 "$WORK/dev.log"; exit 1; }
  sleep 1
done

python3 - <<'PY'
import json, os, subprocess, sys, time, uuid, urllib.request, urllib.error

CT, FX = os.environ["CT"], os.environ["FX"]
URL = "http://127.0.0.1:8787"
ADMIN = next(l.split("=", 1)[1].strip() for l in open(f"{CT}/.dev.vars") if l.startswith("CHAMPDF_ADMIN_TOKEN="))
PERSIST = os.environ["PERSIST"]
INTERNAL = next(l.split("=", 1)[1].strip() for l in open(f"{CT}/.dev.vars") if l.startswith("CHAMPDF_INTERNAL_TOKEN="))
IDS = ["keys_cross_instance", "keys_survive_replace", "usage_metered", "revoke_everywhere", "sign_split", "sign_pdf_stays", "ssrf_d1", "ssrf_probe_direct", "office_to_pdf", "ocr", "remove_bg_first_call", "video_720p", "video_1080p_30s", "gate_still_failing"]
R = {}


def sh(*a, **k):
    return subprocess.run(a, capture_output=True, text=True, cwd=CT, **k)


def mp(fields, files):
    b = "----e2e" + uuid.uuid4().hex
    o = b""
    for k, v in fields.items():
        o += f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    for k, (fn, d) in files.items():
        o += f'--{b}\r\nContent-Disposition: form-data; name="{k}"; filename="{fn}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + d + b"\r\n"
    return o + f"--{b}--\r\n".encode(), f"multipart/form-data; boundary={b}"


def call(method, path, headers=None, fields=None, files=None, body=None, timeout=900):
    h = dict(headers or {})
    data = body
    if files is not None:
        data, h["Content-Type"] = mp(fields or {}, files)
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(urllib.request.Request(URL + path, data=data, method=method, headers=h), timeout=timeout) as r:
            return r.status, r.read(), {k.lower(): v for k, v in r.headers.items()}, time.monotonic() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read(), {k.lower(): v for k, v in e.headers.items()}, time.monotonic() - t0
    except Exception as e:
        return None, repr(e).encode(), {}, time.monotonic() - t0


def rec(cid, ok, status, secs, note):
    R[cid] = {"pass": bool(ok), "status": status, "seconds": round(secs, 2), "note": note}
    print(f"{'PASS' if ok else 'FAIL'} {cid} status={status} {secs:.2f}s {note}", flush=True)


def rd(n):
    return open(f"{FX}/{n}", "rb").read()


def d1(sql):
    r = sh("npx", "wrangler", "d1", "execute", "champdf-local", "--local", "--env", "local", "--persist-to", PERSIST, "--json", "--command", sql)
    try:
        return json.loads(r.stdout)[0]["results"]
    except Exception:
        return None


def wrangler_containers():
    out = sh("docker", "ps", "-a", "--filter", "name=workerd-champdf-api-local", "--format", "{{.ID}} {{.Names}}").stdout.splitlines()
    return [l.split()[0] for l in out if not l.split()[1].endswith("-proxy")]  # -proxy is wrangler's own sidecar


def new_key(label):
    s, b, _, _ = call("POST", "/api/v1/admin/keys?instance=0", {"X-Admin-Token": ADMIN, "Content-Type": "application/json"},
                      body=json.dumps({"label": label, "monthly_quota": 100000}).encode())
    j = json.loads(b) if s == 200 else {}
    if s != 200:
        print("admin create failed:", b[:300], flush=True)
    return s, j.get("key"), j.get("id")


def who(key, inst):
    s, b, _, secs = call("GET", f"/api/v1/whoami?instance={inst}", {"Authorization": "Bearer " + (key or "")})
    return s, secs


def main():
    global KEY, KID
    # 1. keys_cross_instance
    t0 = time.monotonic()
    s0, KEY, KID = new_key("e2e")
    s1, _ = who(KEY, 1) if KEY else (None, 0)
    rec("keys_cross_instance", s0 == 200 and s1 == 200, f"{s0},{s1}", time.monotonic() - t0, "admin create on instance 0, whoami on instance 1")
    AUTH = {"Authorization": "Bearer " + (KEY or "")}

    # 2. keys_survive_replace
    t0 = time.monotonic()
    ids = wrangler_containers()
    if ids:
        sh("docker", "rm", "-f", *ids)
    gone = not wrangler_containers()
    s, secs = who(KEY, 0)
    s_b, _ = who(KEY, 1)
    rec("keys_survive_replace", bool(ids) and gone and s == 200 and s_b == 200, f"{s},{s_b}", time.monotonic() - t0,
        f"removed {len(ids)} wrangler containers, fresh containers answered with the same key on both instances")

    # 3. usage_metered: pdf/info is metered via _meter(key, "pdf/info"); whoami is not metered
    M = 5
    t0 = time.monotonic()
    ok200 = 0
    pdf = rd("text10.pdf")
    for i in range(M):
        s, _, _, _ = call("POST", f"/api/v1/pdf/info?instance={i % 2}", AUTH, files={"file": ("t.pdf", pdf)})
        ok200 += s == 200
    used = d1("SELECT requests_used FROM api_keys WHERE label='e2e'")
    logn = d1(f"SELECT count(*) AS n FROM request_log WHERE key_id={int(KID)}" if KID else "SELECT NULL AS n")
    u = used[0]["requests_used"] if used else None
    n = logn[0]["n"] if logn else None
    rec("usage_metered", ok200 == M and u == ok200 and n == ok200, "200" if ok200 == M else "mixed", time.monotonic() - t0,
        f"{M} calls to /api/v1/pdf/info (metered, backend/api_v1.py _meter pdf/info) over both instances; 200s counted {ok200}, requests_used {u}, request_log rows {n}")

    # 4. revoke_everywhere (second key for the remaining checks first)
    _, KEY2, KID2 = new_key("e2e-ops")
    AUTH2 = {"Authorization": "Bearer " + (KEY2 or "")}
    t0 = time.monotonic()
    sd, _, _, _ = call("DELETE", f"/api/v1/admin/keys/{KID or 0}?instance=0", {"X-Admin-Token": ADMIN})
    a, _ = who(KEY, 0)
    b, _ = who(KEY, 1)
    rec("revoke_everywhere", sd == 200 and a == 401 and b == 401, f"{a},{b}", time.monotonic() - t0, "admin DELETE then whoami on instance 0 and 1 (delete status %s)" % sd)

    # 5. sign_split
    t0 = time.monotonic()
    s, b, h, secs = call("GET", "/api/sign/status")
    logs = sh("docker", "logs", "p1-sign")
    seen = "/api/sign/status" in (logs.stdout + logs.stderr)
    rec("sign_split", s == 200 and h.get("x-champdf-route") == "sign-origin" and "x-champdf-instance" not in h and seen, s, secs,
        f"route={h.get('x-champdf-route')}, instance header present={'x-champdf-instance' in h}, p1-sign log shows request={seen}")

    # 6. sign_pdf_stays
    t0 = time.monotonic()
    s, signed, h, _ = call("POST", "/api/v1/pdf/sign", AUTH2, {"passphrase": "proofpass", "timestamp": "false"}, {"file": ("t.pdf", pdf), "cert": ("c.p12", rd("signer.p12"))})
    inst = "x-champdf-instance" in h
    v1 = v2 = None
    if s == 200:
        sv, bv, _, _ = call("POST", "/api/v1/pdf/verify-signature", AUTH2, files={"file": ("s.pdf", signed)})
        t = bytearray(signed); t[len(t) // 2] ^= 0xFF
        sv2, bv2, _, _ = call("POST", "/api/v1/pdf/verify-signature", AUTH2, files={"file": ("t.pdf", bytes(t))})
        def intact(st, bb):
            try:
                return json.loads(bb).get("signatures", [{}])[0].get("intact") if st == 200 else None
            except Exception:
                return None
        v1, v2 = intact(sv, bv), intact(sv2, bv2)
    rec("sign_pdf_stays", s == 200 and inst and v1 is True and v2 is False, s, time.monotonic() - t0, f"x-champdf-instance present={inst}, intact={v1}, tampered intact={v2}")

    # 7. ssrf_d1
    t0 = time.monotonic()
    mark = b"R2-MARKER-" + uuid.uuid4().hex.encode()
    open(f"{os.environ['WORK']}/mark.bin", "wb").write(mark)
    sh("npx", "wrangler", "r2", "object", "put", "champdf-files-local/tmp/x", "--file", f"{os.environ['WORK']}/mark.bin", "--local", "--env", "local", "--persist-to", PERSIST)
    before = d1("SELECT count(*) AS n FROM api_keys")
    bad = []
    sts = []
    for u_ in ("http://d1.champdf.internal/", "http://r2.champdf.internal/tmp/x"):
        s, b, _, _ = call("POST", "/api/download-from-url", {"Content-Type": "application/json"}, body=json.dumps({"url": u_}).encode())
        sts.append(s)
        txt = b.decode("latin1")
        if mark.decode() in txt or '"results"' in txt or "key_hash" in txt or "champdf_live_" in txt or "requests_used" in txt:
            bad.append(u_)
    after = d1("SELECT count(*) AS n FROM api_keys")
    same = bool(before) and before == after
    rec("ssrf_d1", not bad and same, ",".join(map(str, sts)), time.monotonic() - t0, f"leaks={len(bad)}, api_keys count before={before and before[0]['n']} after={after and after[0]['n']}")

    # 7b. direct in-container probe: the guard must be armed, and the marker must be really there (control with token)
    t0 = time.monotonic()
    PROBE = (
        "import os,urllib.request,urllib.error\n"
        "def g(u,tok):\n"
        " h={'x-champdf-internal':tok} if tok else {}\n"
        " try: return urllib.request.urlopen(urllib.request.Request(u,headers=h),timeout=20).status\n"
        " except urllib.error.HTTPError as e: return e.code\n"
        " except Exception as e: return type(e).__name__\n"
        "t=os.environ['T']\n"
        "print(g('http://d1.champdf.internal/',''),g('http://r2.champdf.internal/tmp/x',''),g('http://r2.champdf.internal/tmp/x',t))\n"
    )
    ctr = wrangler_containers()
    pr = sh("docker", "exec", "-e", "T=" + INTERNAL, ctr[0], "python", "-c", PROBE) if ctr else None
    got = pr.stdout.split() if pr else []
    rec("ssrf_probe_direct", got == ["401", "401", "200"], ",".join(got) or "no container", time.monotonic() - t0,
        "in-container GET without token: d1 401, r2 401; r2 with token 200 (control, marker present)")

    # 8. stateless ops (office_to_pdf, ocr, video_720p), then remove_bg on a fresh container
    def op(cid, path, fields, files, magic, off=0, limit=None, extra=""):
        s, b, h, secs = call("POST", path, AUTH2, fields, files)
        ok = s == 200 and b[off:off + len(magic)] == magic and "x-champdf-instance" in h and (limit is None or secs < limit)
        rec(cid, ok, s, secs, f"magic {b[off:off+8]!r} expected {magic!r}" + extra)

    op("office_to_pdf", "/api/v1/convert/to-pdf", {}, {"file": ("sample.docx", rd("sample.docx"))}, b"%PDF")
    op("ocr", "/api/v1/pdf/ocr", {"language": "eng", "pdfa": "false"}, {"file": ("s.pdf", rd("scan1.pdf"))}, b"%PDF")
    op("video_720p", "/api/v1/video/remove-logo", {"logo_preset": "none"}, {"file": ("v.mp4", rd("video_720p_5s.mp4"))}, b"ftyp", off=4)
    ids = wrangler_containers()
    if ids:
        sh("docker", "rm", "-f", *ids)
    op("remove_bg_first_call", "/api/v1/image/remove-bg?instance=0", {}, {"image": ("p.png", rd("photo.png"))}, b"\x89PNG", limit=15, extra=f"; fresh container after removing {len(ids)}, limit 15 s incl. cold start")

    # 9. video 1080p 30s, local only
    s, b, h, secs = call("POST", "/api/v1/video/remove-logo", AUTH2, {"logo_preset": "none"}, {"file": ("v.mp4", rd("video_1080p_30s.mp4"))})
    rec("video_1080p_30s", s == 200 and b[4:8] == b"ftyp", s, secs, f"{len(b)} bytes out; local Worker+DO under OrbStack, NOT the real Cloudflare path")

    # 10. gate_still_failing
    t0 = time.monotonic()
    c1 = sh("npm", "run", "check:config").returncode
    c2 = sh("npm", "run", "check:config", "--", "--deployable").returncode
    rec("gate_still_failing", c1 == 0 and c2 == 1, f"{c1},{c2}", time.monotonic() - t0, "check:config exit 0, --deployable exit 1")



try:
    main()
except BaseException as e:
    print("check run aborted:", repr(e), flush=True)
for cid in IDS:
    if cid not in R:
        R[cid] = {"pass": False, "status": None, "seconds": 0, "note": "not run or aborted"}
json.dump(R, open(f"{CT}/proof/results/phase1-e2e.json", "w"), indent=2)

p = sum(v["pass"] for v in R.values())
print(f"SUMMARY {p}/{len(R)} passed")
sys.exit(0 if p == len(R) == len(IDS) else 1)
PY
