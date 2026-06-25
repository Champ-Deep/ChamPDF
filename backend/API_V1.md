# ChamPDF Public API v1

A versioned, API-key-authenticated surface that exposes ChamPDF's tools to
external clients (other web apps, scripts, AI agents). Distinct from the
unversioned `/api/*` endpoints the ChamPDF frontend uses.

## Endpoints

All under `/api/v1`. Auth: `Authorization: Bearer <api_key>`.

| Method | Path                       | What                                                                            |
| ------ | -------------------------- | ------------------------------------------------------------------------------- |
| GET    | `/whoami`                  | Returns the authenticated key's id, label, quota, usage. Cheap.                 |
| POST   | `/image/remove-bg`         | multipart `image` → PNG with transparent background.                            |
| POST   | `/image/edit`              | multipart `image` + `prompt` → PNG (Gemini "Edit Banana").                      |
| POST   | `/image/detect-watermarks` | multipart `image` → JSON `{watermarks: [{x,y,w,h,label,confidence}]}`.          |
| POST   | `/image/inpaint`           | multipart `image` + `mask` (+ optional `prompt`, `radius`) → PNG.               |
| POST   | `/video/download`          | JSON `{url, format: "mp3" \| "mp4"}` → binary stream of the file.               |
| POST   | `/video/remove-logo`       | multipart `file` + `logo_preset` + `watermark_position` + `logo_scale` → MP4.   |
| POST   | `/pdf/remove-watermark`    | multipart `file` + `regions` (JSON) + `method` (telea/ns/gemini) → cleaned PDF. |

Auto-generated docs at `GET /docs` (Swagger UI) and `GET /openapi.json`.
v1 endpoints show under the **v1** tag.

## Admin endpoints

Gated by `X-Admin-Token: <CHAMPDF_ADMIN_TOKEN env var>`.

| Method | Path                          | What                                |
| ------ | ----------------------------- | ----------------------------------- |
| POST   | `/api/v1/admin/keys`          | Issue a new key.                    |
| GET    | `/api/v1/admin/keys`          | List all keys (without raw values). |
| DELETE | `/api/v1/admin/keys/{key_id}` | Revoke a key.                       |

If `CHAMPDF_ADMIN_TOKEN` is not set, all admin endpoints return 503.

## Self-serve keys (Clerk sign-in)

So a signed-in user can mint their own key from the website (account menu →
**API**) and hand it to their AI assistant — no admin involvement. These are
authenticated by the user's **Clerk session token**, not the admin token:
`Authorization: Bearer <clerk_session_jwt>`.

| Method | Path                     | What                                                           |
| ------ | ------------------------ | -------------------------------------------------------------- |
| GET    | `/api/v1/keys/me`        | Status of the caller's key (metadata only, never the raw key). |
| POST   | `/api/v1/keys/me`        | Mint the caller's key. 409 if one already exists.              |
| POST   | `/api/v1/keys/me/rotate` | Revoke the old key and issue a fresh one.                      |
| DELETE | `/api/v1/keys/me`        | Revoke the caller's key.                                       |

Each key is bound to the Clerk user id (`sub`); a user has at most one active
key. The raw value is returned only by the POST endpoints (create/rotate),
once.

**Enablement.** Dormant until `CLERK_ISSUER` is set (the Clerk Frontend API
URL). When unset these endpoints return 503. The frontend advertises
availability via `GET /api/capabilities` → `"api_self_serve_keys": true`.

**Who may mint.** Default: any signed-in Clerk user. To lock issuance to your
team, set `CHAMPDF_API_KEY_EMAIL_DOMAINS` (comma-separated, e.g.
`championsmail.com`). When set, the user's email must match; if the Clerk
session token carries no `email` claim, set `CLERK_SECRET_KEY` so the backend
can look it up (otherwise issuance fails closed). Non-permitted accounts get 403.

| Var                             | Purpose                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `CLERK_ISSUER`                  | Clerk Frontend API URL. Enables the `/keys/me` endpoints. Unset => 503.     |
| `CLERK_JWKS_URL`                | Optional override; defaults to `<CLERK_ISSUER>/.well-known/jwks.json`.      |
| `CLERK_SECRET_KEY`              | Optional; only for email-domain gating when the JWT lacks an `email` claim. |
| `CHAMPDF_API_KEY_EMAIL_DOMAINS` | Optional allowlist of email domains. Empty => any signed-in user.           |

## Auth

API keys look like `champdf_live_<32 hex chars>`. The raw value is shown
**only at creation**; the server stores SHA-256 hashes and cannot recover
the original.

## Rate limits

Two layers, both per-key:

- **Burst**: 30 requests / minute (in-memory sliding window). Returns 429
  with `{"code": "rate_limited"}`.
- **Monthly quota**: configurable per key (default 1000). Returns 429
  with `{"code": "quota_exceeded"}`. Quotas reset at the start of each
  UTC month.

## Storage

API keys live in SQLite at `/app/data/champdf.db` by default. Override
with `CHAMPDF_DB_PATH` env var. On Railway, mount a Volume at
`/app/data` so keys persist across deploys; otherwise the DB is
ephemeral and you'll need to re-issue keys after every redeploy.

## Required env vars

| Var                   | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `CHAMPDF_ADMIN_TOKEN` | Enables `/api/v1/admin/*`. Without it, admin endpoints return 503.  |
| `GEMINI_API_KEY`      | Enables `/api/v1/image/edit`. Without it, the endpoint returns 503. |
| `CHAMPDF_DB_PATH`     | SQLite path. Defaults to `/app/data/champdf.db`. Optional.          |

## Quickstart

```bash
# 1. Issue a key (server-side, with admin token)
curl -X POST https://champdf-backend.up.railway.app/api/v1/admin/keys \
  -H "X-Admin-Token: $CHAMPDF_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "marketing-team", "monthly_quota": 10000}'
# -> {"id": 1, "key": "champdf_live_...", ...}

# 2. Use it
curl -X POST https://champdf-backend.up.railway.app/api/v1/image/remove-bg \
  -H "Authorization: Bearer champdf_live_..." \
  -F "image=@photo.jpg" \
  -o photo-no-bg.png

# 3. Check usage
curl https://champdf-backend.up.railway.app/api/v1/whoami \
  -H "Authorization: Bearer champdf_live_..."
# -> {"id": 1, "label": "marketing-team", "monthly_quota": 10000,
#     "requests_used": 1, "month_bucket": "2026-04"}
```

## Test the AI-assistant chain right now

You don't need Clerk wired up to exercise the full
key → API → AI-assistant path. Hand-mint a key with the admin token, then
point the MCP server at it:

```bash
# Issue a key (needs CHAMPDF_ADMIN_TOKEN set on the backend)
curl -X POST https://champdf-backend.up.railway.app/api/v1/admin/keys \
  -H "X-Admin-Token: $CHAMPDF_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "test", "monthly_quota": 1000}'
# -> {"key": "champdf_live_...", ...}

# Register it with Claude Code and smoke-test
claude mcp add champdf \
  -e CHAMPDF_API_KEY=champdf_live_... \
  -e CHAMPDF_API_BASE_URL=https://champdf-backend.up.railway.app \
  -- npx -y @champ-deep/champdf-mcp
# then in Claude Code: "call champdf_whoami"
```

Once `CLERK_ISSUER` is set, users do the same thing self-serve from the
account menu (**API** pill) — no admin token needed.

## What's NOT in v1

Browser-only tools (LibreOffice WASM driven Office-to-PDF converters, the
client-side PDF Editor, OCR, Crop, Rotate, Compare). They could come in v2
if there's demand — most are tractable server-side with pdfium / poppler
but it would inflate the backend image significantly.

## Phase 2: MCP server

Planned. The MCP server will be a thin npm package
(`@champ-deep/champdf-mcp`) that wraps these v1 endpoints as MCP tools so
Claude Code, Claude Desktop, Cursor, etc. can call them natively. Users
install with `npx -y @champ-deep/champdf-mcp`, paste their `CHAMPDF_API_KEY`,
and ChamPDF tools become first-class agent tools. See
`/root/.claude/plans/champdf-api-and-mcp-server.md` for the design.
