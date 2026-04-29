#!/usr/bin/env bash
# End-to-end v2 smoke test against a locally-running stack.
#
# Workflow:
#   1. docker compose -f docker-compose.dev.yml up --build video-backend
#      (wait for "Application startup complete")
#   2. ./scripts/test-v2-local.sh
#        - Generates fixtures (image, PDF, mask) with PIL+fitz
#        - Issues a v1 API key via the admin endpoint
#        - Hits every v1 tool endpoint with a real payload
#        - Writes the issued key to .env.mcp so docker-compose can boot
#          the MCP service
#        - Optionally exercises the MCP HTTP server if it's running
#
# Pass / fail printed inline. Non-zero exit = something didn't work.
#
# Env knobs:
#   BACKEND_URL    default http://localhost:8000
#   MCP_URL        default http://localhost:8081
#   ADMIN_TOKEN    default reads CHAMPDF_ADMIN_TOKEN; falls back to
#                  admin_local_test_token_change_me (matches compose default)
#   GEMINI_API_KEY optional; tests that need it auto-skip if missing

set -uo pipefail

BACKEND_URL=${BACKEND_URL:-http://localhost:8000}
MCP_URL=${MCP_URL:-http://localhost:8081}
ADMIN_TOKEN=${CHAMPDF_ADMIN_TOKEN:-${ADMIN_TOKEN:-admin_local_test_token_change_me}}

WORKDIR=$(mktemp -d -t champdf-test-XXXXXX)
trap 'rm -rf "$WORKDIR"' EXIT

PASS=0
FAIL=0
SKIP=0
RESULTS=()

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$1"; }

ok()    { green "  ✓ $1"; PASS=$((PASS+1)); RESULTS+=("PASS $1"); }
fail()  { red   "  ✗ $1"; FAIL=$((FAIL+1)); RESULTS+=("FAIL $1"); }
skip()  { yellow "  - $1 (skipped)"; SKIP=$((SKIP+1)); RESULTS+=("SKIP $1"); }

# ---------------------------------------------------------------------------
# Step 0 — Tool checks
# ---------------------------------------------------------------------------
echo "=== Tool check ==="
for tool in curl jq python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    red "Missing required tool: $tool"
    exit 2
  fi
done
ok "curl, jq, python3 available"

# ---------------------------------------------------------------------------
# Step 1 — Backend reachable + healthy
# ---------------------------------------------------------------------------
echo ""
echo "=== Backend health ($BACKEND_URL) ==="
HEALTH=$(curl -fsS --max-time 5 "$BACKEND_URL/health" 2>&1) && ok "GET /health: $HEALTH" || {
  fail "Backend not reachable at $BACKEND_URL — start it with 'docker compose -f docker-compose.dev.yml up video-backend'"
  exit 1
}

# ---------------------------------------------------------------------------
# Step 2 — Generate fixtures
# ---------------------------------------------------------------------------
echo ""
echo "=== Generating test fixtures ==="
python3 - "$WORKDIR" <<'PYEOF'
import os, sys
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]

# Test image: 400x300 with a "WATERMARK" text in the bottom-right
img = Image.new("RGB", (400, 300), (200, 220, 240))
d = ImageDraw.Draw(img)
d.rectangle([20, 20, 380, 280], outline=(40, 60, 90), width=3)
d.text((30, 30), "Real content here", fill=(40, 60, 90))
d.text((250, 250), "WATERMARK", fill=(220, 30, 100))
img.save(os.path.join(out, "image.png"))

# Mask: same size, white box where the watermark is
mask = Image.new("L", (400, 300), 0)
md = ImageDraw.Draw(mask)
md.rectangle([245, 245, 380, 270], fill=255)
mask.save(os.path.join(out, "mask.png"))

print(f"  image.png ({os.path.getsize(os.path.join(out, 'image.png'))} bytes)")
print(f"  mask.png  ({os.path.getsize(os.path.join(out, 'mask.png'))} bytes)")

try:
    import fitz
    doc = fitz.open()
    for i in range(2):
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 72), f"Page {i+1} body content. Should remain after cleanup.", fontsize=14)
        if i == 0:
            page.insert_text((420, 800), "WATERMARK", fontsize=24, color=(1, 0, 1))
    doc.save(os.path.join(out, "doc.pdf"))
    print(f"  doc.pdf   ({os.path.getsize(os.path.join(out, 'doc.pdf'))} bytes, 2 pages)")
except ImportError:
    print("  (PyMuPDF not installed locally — PDF endpoint test will fall back to a tiny stub)")
    # Fallback: minimal valid PDF
    minimal = (
        b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>/Contents 4 0 R>>endobj\n"
        b"4 0 obj<</Length 0>>stream\nendstream\nendobj\n"
        b"xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000092 00000 n \n0000000160 00000 n \n"
        b"trailer<</Size 5/Root 1 0 R>>\nstartxref\n205\n%%EOF\n"
    )
    with open(os.path.join(out, "doc.pdf"), "wb") as f:
        f.write(minimal)
    print(f"  doc.pdf   ({os.path.getsize(os.path.join(out, 'doc.pdf'))} bytes, stub)")
PYEOF
[[ -f "$WORKDIR/image.png" && -f "$WORKDIR/mask.png" && -f "$WORKDIR/doc.pdf" ]] && ok "fixtures generated in $WORKDIR" || { fail "fixture generation"; exit 1; }

# ---------------------------------------------------------------------------
# Step 3 — Issue API key via admin endpoint
# ---------------------------------------------------------------------------
echo ""
echo "=== v1 admin: issue API key ==="
ISSUE=$(curl -sS -X POST "$BACKEND_URL/api/v1/admin/keys" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"v2-smoke","monthly_quota":10000}')

API_KEY=$(echo "$ISSUE" | jq -r '.key // empty')
KEY_ID=$(echo "$ISSUE" | jq -r '.id // empty')

if [[ -z "$API_KEY" ]]; then
  fail "admin /keys returned no key. Response: $ISSUE"
  red "  Hint: ensure CHAMPDF_ADMIN_TOKEN is set in the backend container's env."
  exit 1
fi
ok "issued key id=$KEY_ID (label=v2-smoke, quota=10000/mo)"

# Persist for the MCP service to pick up
ENVFILE="$(pwd)/.env.mcp"
{
  echo "CHAMPDF_API_KEY=$API_KEY"
  echo "CHAMPDF_MCP_AUTH_TOKEN=${CHAMPDF_MCP_AUTH_TOKEN:-mcp_local_test_token}"
} > "$ENVFILE"
chmod 600 "$ENVFILE"
ok "wrote $ENVFILE — boot MCP with: docker compose --env-file .env.mcp -f docker-compose.dev.yml up champdf-mcp"

# ---------------------------------------------------------------------------
# Step 4 — v1 tool endpoints
# ---------------------------------------------------------------------------
AUTH="Authorization: Bearer $API_KEY"

echo ""
echo "=== v1: GET /whoami ==="
WHO=$(curl -sS "$BACKEND_URL/api/v1/whoami" -H "$AUTH")
echo "$WHO" | jq -e '.id == '"$KEY_ID" >/dev/null 2>&1 && ok "whoami returned id=$KEY_ID" || fail "whoami: $WHO"

echo ""
echo "=== v1: POST /image/remove-bg ==="
RESP=$(curl -sS -o "$WORKDIR/no-bg.png" -w "%{http_code}" -X POST "$BACKEND_URL/api/v1/image/remove-bg" \
  -H "$AUTH" -F "image=@$WORKDIR/image.png")
if [[ "$RESP" == "200" ]] && [[ -s "$WORKDIR/no-bg.png" ]]; then
  ok "remove-bg → $(stat -c%s "$WORKDIR/no-bg.png" 2>/dev/null || stat -f%z "$WORKDIR/no-bg.png") bytes"
else
  fail "remove-bg HTTP $RESP"
fi

echo ""
echo "=== v1: POST /image/inpaint (telea) ==="
RESP=$(curl -sS -o "$WORKDIR/inpainted-cv.png" -w "%{http_code}" -X POST "$BACKEND_URL/api/v1/image/inpaint" \
  -H "$AUTH" -F "image=@$WORKDIR/image.png" -F "mask=@$WORKDIR/mask.png" -F "method=telea")
[[ "$RESP" == "200" ]] && [[ -s "$WORKDIR/inpainted-cv.png" ]] && ok "inpaint(telea) → OK" || fail "inpaint(telea) HTTP $RESP"

echo ""
echo "=== v1: POST /pdf/remove-watermark (telea) ==="
RESP=$(curl -sS -o "$WORKDIR/clean.pdf" -w "%{http_code}" -X POST "$BACKEND_URL/api/v1/pdf/remove-watermark" \
  -H "$AUTH" \
  -F "file=@$WORKDIR/doc.pdf" \
  -F 'regions=[{"page":1,"x":410,"y":780,"w":130,"h":35}]' \
  -F "method=telea")
if [[ "$RESP" == "200" ]] && [[ -s "$WORKDIR/clean.pdf" ]]; then
  ok "pdf/remove-watermark(telea) → $(stat -c%s "$WORKDIR/clean.pdf" 2>/dev/null || stat -f%z "$WORKDIR/clean.pdf") bytes"
else
  fail "pdf/remove-watermark HTTP $RESP"
fi

echo ""
echo "=== v1: POST /image/edit (Gemini) ==="
if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  skip "image/edit: GEMINI_API_KEY not set in this shell"
else
  RESP=$(curl -sS -o "$WORKDIR/edited.png" -w "%{http_code}" -X POST "$BACKEND_URL/api/v1/image/edit" \
    -H "$AUTH" -F "image=@$WORKDIR/image.png" -F "prompt=Remove the magenta WATERMARK text")
  if [[ "$RESP" == "200" ]] && [[ -s "$WORKDIR/edited.png" ]]; then
    ok "image/edit(Gemini) → OK"
  elif [[ "$RESP" == "503" ]]; then
    skip "image/edit: backend reports Gemini not configured (set GEMINI_API_KEY in compose env)"
  else
    fail "image/edit HTTP $RESP"
  fi
fi

echo ""
echo "=== v1: POST /image/detect-watermarks (Gemini) ==="
if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  skip "detect-watermarks: GEMINI_API_KEY not set"
else
  RESP=$(curl -sS -X POST "$BACKEND_URL/api/v1/image/detect-watermarks" -H "$AUTH" -F "image=@$WORKDIR/image.png")
  if echo "$RESP" | jq -e '.regions | type == "array"' >/dev/null 2>&1; then
    COUNT=$(echo "$RESP" | jq '.regions | length')
    ok "detect-watermarks → $COUNT region(s) found"
  elif echo "$RESP" | grep -qi "gemini\|503"; then
    skip "detect-watermarks: backend reports Gemini not configured"
  else
    fail "detect-watermarks unexpected: $RESP"
  fi
fi

echo ""
echo "=== v1: POST /video/download (yt-dlp) ==="
yellow "  (skipping — pulls a real YouTube video; run manually if you want)"
SKIP=$((SKIP+1)); RESULTS+=("SKIP video/download (network-heavy, manual only)")

echo ""
echo "=== v1: POST /video/remove-logo ==="
yellow "  (skipping — needs a real video file; run manually)"
SKIP=$((SKIP+1)); RESULTS+=("SKIP video/remove-logo (needs real video, manual only)")

# ---------------------------------------------------------------------------
# Step 5 — MCP HTTP server (if running)
# ---------------------------------------------------------------------------
echo ""
echo "=== MCP HTTP server ($MCP_URL) ==="
if ! curl -fsS --max-time 2 "$MCP_URL/healthz" >/dev/null 2>&1; then
  skip "MCP not running. Boot it with: docker compose --env-file .env.mcp -f docker-compose.dev.yml up champdf-mcp"
else
  ok "MCP /healthz reachable"

  MCP_AUTH_HEADER=()
  if [[ -n "${CHAMPDF_MCP_AUTH_TOKEN:-mcp_local_test_token}" ]]; then
    MCP_AUTH_HEADER=(-H "Authorization: Bearer ${CHAMPDF_MCP_AUTH_TOKEN:-mcp_local_test_token}")
  fi

  INIT=$(curl -sS -X POST "$MCP_URL/mcp" \
    "${MCP_AUTH_HEADER[@]}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
  if echo "$INIT" | grep -q '"serverInfo"'; then
    ok "MCP initialize handshake"
  else
    fail "MCP initialize: $INIT"
  fi

  TOOLS=$(curl -sS -X POST "$MCP_URL/mcp" \
    "${MCP_AUTH_HEADER[@]}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
  TOOL_COUNT=$(echo "$TOOLS" | sed -n 's/.*"tools":\[//p' | grep -oE '"name":"champdf_[a-z_]+"' | wc -l | tr -d ' ')
  if [[ "$TOOL_COUNT" -ge 8 ]]; then
    ok "MCP tools/list returned $TOOL_COUNT champdf_* tools"
  else
    fail "MCP tools/list: expected 8 tools, got $TOOL_COUNT"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Summary ==="
green "PASS: $PASS"
[[ $SKIP -gt 0 ]] && yellow "SKIP: $SKIP"
[[ $FAIL -gt 0 ]] && red "FAIL: $FAIL"
echo ""
for r in "${RESULTS[@]}"; do echo "  $r"; done

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
