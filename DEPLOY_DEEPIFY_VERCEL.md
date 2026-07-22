# Deploying ChamPDF V2 — split stack (Deepify backend + Vercel frontend)

This is the simplest path to running V2 as two separately-deployed pieces:

- **Backend (FastAPI + API v1)** → your Deepify instance (Coolify) at
  `https://deepify.64.227.154.215.sslip.io/`
- **Frontend (static Vite site)** → Vercel

The frontend already knows how to talk to a remote backend via one env var
(`VITE_API_URL`), and the backend already knows how to accept it via CORS
(`ALLOWED_ORIGINS`). That's the whole contract.

## Domain architecture (the API gateway picture)

```
champdf.com            → Vercel (static frontend)
champdf.com/api/*      → rewritten by Vercel to api.champdf.com  (vercel.json)
api.champdf.com        → Coolify/Deepify backend = the API gateway
                          • auth (champdf_live_… keys) + RBAC scopes
                          • per-key rate limits + monthly quotas + usage metering
                          • /api/v1/* document + media endpoints
                          • /docs (Swagger) + /api/v1/capabilities (feature discovery)
```

The FastAPI backend **is** the gateway — there's no separate gateway product
to run. Salesforce, scripts, and MCP agents all hit `api.champdf.com` (or
`champdf.com/api`, same thing after the rewrite) with a Bearer key.

DNS you need: point `api.champdf.com` (A record) at `64.227.154.215` and
attach that domain to the backend app in Deepify (Coolify provisions the
TLS cert automatically). The included `vercel.json` already rewrites
`champdf.com/api/*` and `/docs` to `api.champdf.com`.

> Heads-up: very large uploads are best sent directly to
> `api.champdf.com` — the Vercel rewrite path proxies through Vercel's
> edge and is subject to its body-size limits; direct-to-API has none
> beyond the backend's own 50–100MB caps.

**RBAC (role-based keys).** Keys can be scoped so each team/integration
gets exactly the access it needs — e.g. a signing-only key for the
Salesforce flow:

```bash
curl -X POST https://api.champdf.com/api/v1/admin/keys \
  -H "X-Admin-Token: $CHAMPDF_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"label": "sf-signing", "scopes": ["pdf.sign", "pdf.read"], "monthly_quota": 5000}'
```

Scopes: `pdf.read`, `pdf.write`, `pdf.sign`, `pdf` (all pdf), `convert`,
`image`, `video`, `*`. Full details: [`backend/API_V1.md`](backend/API_V1.md).

---

## Part 1 — Backend on Deepify (Coolify)

### 1. Create the app

1. Open Deepify → your project → **+ New** → **Resource** →
   **Public Repository** (or the GitHub app if you've connected the
   `Champ-Deep` org).
2. Repository: `https://github.com/Champ-Deep/ChamPDF`, branch: **`v2`**
   (the enterprise document API is merged in — this is the branch to deploy).
3. **Build Pack: Dockerfile.**
   - Dockerfile location: `backend/Dockerfile.railway`
   - Build context: `/` (repo root — the Dockerfile copies `backend/...` and
     `Images & Logos/`, so the context must be the root, not `/backend`).
4. Port: **8000**.

### 2. Persistent storage (don't skip)

API keys live in SQLite at `/app/data/champdf.db`. Add a **volume** in the
app's Storage tab mounted at **`/app/data`** — otherwise every redeploy wipes
all issued API keys.

### 3. Environment variables

Set these in the app's Environment tab:

| Variable                        | Value                                                | Required?                                |
| ------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| `CHAMPDF_ADMIN_TOKEN`           | a long random secret (`openssl rand -hex 32`)        | **Yes** — enables key issuance           |
| `ALLOWED_ORIGINS`               | `https://<your-app>.vercel.app,https://champpdf.com` | **Yes** — CORS for the frontend          |
| `PORT`                          | `8000`                                               | Recommended                              |
| `WEB_CONCURRENCY`               | `2`                                                  | Optional (uvicorn workers)               |
| `GEMINI_API_KEY`                | your Gemini key                                      | Optional — AI image edit/inpaint/detect  |
| `REPLICATE_API_TOKEN`           | your Replicate token                                 | Optional — GPU video offload             |
| `OPENROUTER_API_KEY`            | your OpenRouter key                                  | Optional — video summaries               |
| `CLERK_ISSUER`                  | your Clerk Frontend API URL                          | Optional — self-serve API keys           |
| `CHAMPDF_API_KEY_EMAIL_DOMAINS` | `championsmail.com`                                  | Optional — lock key minting to your team |
| `PDF_TSA_URL`                   | (default `http://timestamp.digicert.com`)            | Optional — signing timestamps            |

Everything optional degrades cleanly: unset ⇒ that feature reports
unavailable via `/api/v1/capabilities`, everything else works.

### 4. Domain + deploy

1. In the app's settings, Deepify will assign a domain like
   `https://<app>.64.227.154.215.sslip.io` — or attach your own
   (e.g. `api.champpdf.com`, recommended for Salesforce later). HTTPS is
   handled by Coolify's proxy automatically.
2. Hit **Deploy**. First build is slow (~10–15 min: torch CPU wheels,
   LibreOffice, the rembg model download). Subsequent builds cache.
3. Note: the image needs **~2GB RAM** at runtime (AI models). If the box is
   tight, set `WEB_CONCURRENCY=1`.

### 5. Verify

```bash
BACKEND=https://<your-backend-domain>

curl $BACKEND/health                      # -> {"status": "..."}

# Issue your first API key
curl -X POST $BACKEND/api/v1/admin/keys \
  -H "X-Admin-Token: $CHAMPDF_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "sales-team", "monthly_quota": 10000}'
# -> {"key": "champdf_live_...", ...}   (shown only once — store it)

# Smoke-test the document API
curl $BACKEND/api/v1/capabilities -H "Authorization: Bearer champdf_live_..."
curl -X POST $BACKEND/api/v1/convert/to-pdf \
  -H "Authorization: Bearer champdf_live_..." \
  -F "file=@contract.docx" -o contract.pdf
```

Interactive API docs (Swagger): `https://<backend>/docs`.

---

## Part 2 — Frontend on Vercel

The frontend is a static Vite build; every server call goes to
`VITE_API_URL` (baked in at build time).

1. Vercel → **Add New Project** → import `Champ-Deep/ChamPDF`, branch `v2`.
2. Framework preset: **Vite**. Settings:
   - Build command: `npm run build`
   - Output directory: `dist`
   - Install command: `npm install`
   - Node.js: 20.x or 22.x
3. Environment variables (Build):
   - `VITE_API_URL` = `https://<your-backend-domain>` (no trailing slash)
   - `NODE_OPTIONS` = `--max-old-space-size=4096` (the i18n page generation
     is memory-hungry)
   - `VITE_CLERK_PUBLISHABLE_KEY` = your Clerk publishable key (optional —
     enables sign-in + the self-serve API panel)
4. Deploy. Then go back to **Deepify** and make sure the final Vercel domain
   (and any custom domain) is listed in the backend's `ALLOWED_ORIGINS`,
   then restart the backend.

### End-to-end test of the split stack

1. Open the Vercel URL — client-side tools (merge, compress, editor) work
   immediately (no backend involved).
2. Open a server-backed tool (Remove Background, Compliance Sign, Server
   OCR) and run a file through it — this proves the CORS + `VITE_API_URL`
   wiring.
3. `curl https://<backend>/api/v1/whoami -H "Authorization: Bearer <key>"` —
   proves the enterprise API path.

---

## Part 3 — Wiring Salesforce

Salesforce talks to the **backend only**, server-to-server (no CORS):

1. Issue a key per team: `POST /api/v1/admin/keys` with a `label` and
   `monthly_quota`.
2. In Salesforce Setup, create a **Named Credential** pointing at
   `https://<your-backend-domain>` with an `Authorization: Bearer
champdf_live_...` header (or add the domain to Remote Site Settings).
3. Call the document endpoints from Apex/Flow: `convert/to-pdf`,
   `pdf/merge`, `pdf/sign`, `pdf/watermark`, `pdf/to-text`,
   `pdf/extract-tables`, ... Full endpoint table + a working Apex multipart
   example: [`backend/API_V1.md`](backend/API_V1.md).

Recommended for production: put the backend on a real domain
(`api.champdf.com`) rather than the sslip.io one before rolling out to
teams — Salesforce Named Credentials shouldn't chase changing hosts.

---

## Part 4 — MCP server for agents

The repo ships an MCP server ([`mcp/`](mcp/)) that turns the whole document
API into agent tools — Claude Code, Claude Desktop, and Cursor can sign,
merge, convert, and OCR documents natively.

**Per-user (stdio)** — each teammate runs it locally with their own key:

```bash
claude mcp add champdf \
  -e CHAMPDF_API_KEY=champdf_live_... \
  -e CHAMPDF_API_BASE_URL=https://api.champdf.com \
  -- npx -y @champ-deep/champdf-mcp
```

(Until the package is published to npm, clone the repo and use
`node <repo>/mcp/dist/index.js` as the command instead of `npx`.)

**Team-hosted (HTTP)** — deploy one more small app on Deepify from
`mcp/Dockerfile.railway` (context: repo root), set:

| Env var                  | Value                                             |
| ------------------------ | ------------------------------------------------- |
| `CHAMPDF_API_KEY`        | a v1 key for the backend (scope it appropriately) |
| `CHAMPDF_API_BASE_URL`   | `https://api.champdf.com`                         |
| `CHAMPDF_MCP_AUTH_TOKEN` | a shared secret your team's clients must send     |

then clients connect with
`{"type": "http", "url": "https://mcp.champdf.com/mcp", "headers": {"Authorization": "Bearer <token>"}}`.
Healthcheck: `/healthz`, port 8081.

Pair MCP with scoped keys for safe agent automation: give an agent a
`pdf.sign`-only key and it can sign documents but can't touch anything
else — out-of-scope calls return a structured `insufficient_scope` error.

---

## Troubleshooting

| Symptom                                | Fix                                                                                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend tool says backend unreachable | `VITE_API_URL` wrong/missing at build time (it's baked in — rebuild), or the browser console shows a CORS error ⇒ add the frontend origin to `ALLOWED_ORIGINS` and restart the backend. |
| API keys disappear after redeploy      | The `/app/data` volume isn't mounted.                                                                                                                                                   |
| `/api/v1/admin/keys` returns 503       | `CHAMPDF_ADMIN_TOKEN` not set on the backend.                                                                                                                                           |
| `convert/to-pdf` returns 503           | Image built from an old Dockerfile without LibreOffice — redeploy from `v2`.                                                                                                            |
| Build OOMs on Vercel                   | Set `NODE_OPTIONS=--max-old-space-size=4096`.                                                                                                                                           |
| Backend container OOMs                 | Give it ≥2GB RAM or set `WEB_CONCURRENCY=1`.                                                                                                                                            |
