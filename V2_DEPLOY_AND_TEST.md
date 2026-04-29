# v2 — Deploy & Test Checklist

Single page with everything you need to bring `v2` up on Railway, smoke-
test it end-to-end, and decide whether it's ready to merge into `main`.

## What `v2` ships

Three deployable services (defined in `railway.toml`):

| Service             | Dockerfile                       | Public URL pattern            |
| ------------------- | -------------------------------- | ----------------------------- |
| `champdf-frontend`  | `Dockerfile.frontend`            | the user-visible web app      |
| `champdf-backend`   | `backend/Dockerfile.railway`     | FastAPI; ML; v1 API + admin   |
| `champdf-mcp`       | `mcp/Dockerfile.railway` (new)   | hosted MCP for AI clients     |

## Step 1 — Frontend service

The existing `champdf-frontend` service should auto-redeploy when v2 is
pushed. No env var changes needed if your nginx already proxies `/api/`
to the backend.

If `/api/*` is still 405-ing on POST, set:

- **Build:** Dockerfile path `Dockerfile.frontend`, root `.`
- **Variables:**
  - `BACKEND_URL` = `http://champdf-backend.railway.internal:8000`
    (or whatever the backend service's private URL is)

Smoke test once redeployed:

```bash
curl -i https://champdf-frontend.up.railway.app/
# expect 200, HTML
curl -X POST https://champdf-frontend.up.railway.app/api/process-video -d ''
# expect 422 (unprocessable entity from FastAPI), NOT 405. 405 means
# the /api/ proxy block didn't make it to the deployed nginx.
```

Visit `/` in a browser and confirm the new pillar nav renders Documents
/ Images / Video buttons. Click into Video Downloader and Edit Banana —
both should load without console errors.

## Step 2 — Backend service

Required env vars on `champdf-backend`:

| Var                       | Required                | Notes                                                                |
| ------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `GEMINI_API_KEY`          | for Edit Banana / AI    | Without it those endpoints return 503; OpenCV fallback still works.  |
| `CHAMPDF_ADMIN_TOKEN`     | for issuing v1 API keys | Without it `/api/v1/admin/*` returns 503.                            |
| `CHAMPDF_DB_PATH`         | optional                | Defaults to `/app/data/champdf.db`. Mount a Volume there.            |
| `GEMINI_IMAGE_MODEL`      | optional                | Defaults to `gemini-2.5-flash-image-preview`.                        |
| `GEMINI_DETECT_MODEL`     | optional                | Defaults to `gemini-2.5-flash` (cheaper than the image-edit model).  |
| `MAX_CONCURRENT_JOBS`     | optional                | Defaults to 2. Bump if you have headroom.                            |

**Mount a Railway Volume at `/app/data`.** Without it the SQLite key
store is ephemeral and you'll have to reissue API keys after every
redeploy.

After deploy, verify:

```bash
# 1. Health
curl https://champdf-backend.up.railway.app/health
# -> {"status":"ok",...}

# 2. v1 OpenAPI is exposed
curl https://champdf-backend.up.railway.app/docs
# -> swagger UI HTML

# 3. Issue a key (admin-gated)
curl -X POST https://champdf-backend.up.railway.app/api/v1/admin/keys \
  -H "X-Admin-Token: $CHAMPDF_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"smoke","monthly_quota":1000}'
# -> {"id":1,"key":"champdf_live_...","label":"smoke",...}

# 4. Use the key
KEY=champdf_live_...
curl https://champdf-backend.up.railway.app/api/v1/whoami \
  -H "Authorization: Bearer $KEY"
# -> {"id":1,"label":"smoke",...}

# 5. Real-tool smoke (background removal)
curl -X POST https://champdf-backend.up.railway.app/api/v1/image/remove-bg \
  -H "Authorization: Bearer $KEY" \
  -F "image=@some-photo.jpg" \
  -o no-bg.png
# -> 200, ~PNG with alpha
```

## Step 3 — MCP service (new in v2)

The `champdf-mcp` service is optional but recommended if you want
hosted MCP access (for Claude Desktop on shared machines, web clients,
etc.). Skip this if you only need the npm-published stdio MCP.

In Railway, add a third service. **Build context: repo root.** Dockerfile
path: `mcp/Dockerfile.railway`. Healthcheck path: `/healthz`.

Required env vars:

| Var                       | Required | Notes                                                                |
| ------------------------- | -------- | -------------------------------------------------------------------- |
| `CHAMPDF_API_KEY`         | yes      | A v1 API key the MCP server uses. Issue one in Step 2 first.         |
| `CHAMPDF_API_BASE_URL`    | yes      | `http://champdf-backend.railway.internal:8000` keeps traffic private. |
| `CHAMPDF_MCP_AUTH_TOKEN`  | recommended | Bearer token clients must pass. If unset, the URL is open.        |

Smoke test:

```bash
# Healthcheck
curl https://champdf-mcp.up.railway.app/healthz
# -> ok

# MCP initialize
curl -X POST https://champdf-mcp.up.railway.app/mcp \
  -H "Authorization: Bearer $CHAMPDF_MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
# -> SSE event with serverInfo
```

Connect from Claude Desktop:

```json
{
  "mcpServers": {
    "champdf": {
      "type": "http",
      "url": "https://champdf-mcp.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_CHAMPDF_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

Then ask the agent: _"call champdf_whoami"_ — should return your key's
quota. _"call champdf_remove_background with /Users/.../photo.jpg → /tmp/out.png"_
should return a transparent PNG.

## Step 4 — Validate the heavy paths

Use `backend/scripts/verify_inpaint.py` to exercise the Gemini /
OpenCV inpainting code paths against the deployed backend:

```bash
cd backend
python3 scripts/verify_inpaint.py remote \
  --base-url https://champdf-backend.up.railway.app \
  --key $CHAMPDF_API_KEY \
  --prompt "Remove the magenta watermark"
```

Saves `/tmp/champdf-verify/remote_*.png`. Open them; quality should be
visibly clean.

For the **PDF watermark remover with a real NotebookLM PDF**, the
quickest manual A/B test is in the browser at `/remove-watermark.html`:

1. Upload your watermarked PDF.
2. Set Method = `Gemini AI (Highest Quality, Server)`.
3. Click `Auto-detect` — Gemini should outline the watermark.
4. Click `Remove Watermark`.
5. Compare the downloaded PDF against the same flow with Method = `Telea`.

If Gemini's output isn't clean enough, the OpenCV path is always
available as a fallback (no key needed).

## Step 5 — Branch cleanup

Once the above passes on your Testing environment and you've merged
`v2 → main`, you can delete the 12 source branches. See
`V2_BRANCH_AUDIT.md` for the full list and the loop you can paste.
Every branch's tip is reachable from v2's history, so deletion loses
no work.

## What's deliberately NOT covered

- **Custom domain / DNS:** that's all Railway-side.
- **Multi-tenant per-user MCP keys:** Phase 4 work. Right now the
  hosted MCP forwards to v1 with one shared key.
- **CI tests:** smoke tests + the verify_inpaint harness exist; a
  proper test suite is a separate iteration.
- **Self-service signup for v1 API keys:** issuance is admin-only
  (X-Admin-Token-gated). A public signup page is Phase 4.

Open product questions still on the table (in
`/root/.claude/plans/champdf-api-and-mcp-server.md`):

1. Free-tier monthly quota size?
2. Pricing model?
3. SQLite forever or move to Postgres at some traffic threshold?
4. npm package name: `@champ-deep/champdf-mcp` (org-scoped) or root
   `champdf-mcp`?
5. Self-service signup UX vs engineering-only?
