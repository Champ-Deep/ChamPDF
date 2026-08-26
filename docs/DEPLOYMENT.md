# Deploying ChamPDF

The single source of truth for how ChamPDF is deployed and operated.
Supersedes `DEPLOY_DEEPIFY_VERCEL.md`, `V2_DEPLOY_AND_TEST.md`, and
`V2_BRANCH_AUDIT.md` (removed — their history is in git).

## Production architecture (current)

```
cham-pdf.vercel.app        → Vercel: static Vite frontend (built from this repo)
  /api/*  /docs  /openapi.json ──rewritten by vercel.json──▶ backend
champdf-api.64.227.154.215.sslip.io
                           → host nginx (TLS) → 127.0.0.1:8005
                           → Coolify-managed container (backend/Dockerfile.railway)
```

- **Frontend**: Vercel project `cham-pdf`. Build env: `VITE_API_URL=<backend url>`,
  `NODE_OPTIONS=--max-old-space-size=4096` (i18n page generation is memory-hungry).
  Deploy with `vercel --prod` or Git integration.
- **Backend**: Coolify ("Deepify") app building `backend/Dockerfile.railway` with
  build context `/` (repo root). Port 8000, published to host port 8005
  (`ports_mappings: 8005:8000`). The public domain is served by the **host
  nginx** (config: `/etc/nginx/sites-available/champdf-api.…sslip.io`), which
  proxies to `127.0.0.1:8005` — a stable published port, deliberately not a
  container IP, so redeploys can't break routing.
- A planned `api.champdf.com` DNS record will front the same backend; clients
  should read the base URL from `public/llms.txt` rather than hard-coding it.

### Legacy: champdf.com on Railway

`champdf.com` still points at a Railway deployment (frontend + nginx `/api`
proxy + its own backend service) that predates the split stack above. It is
independent of the Vercel/Coolify deployment. `railway.toml`,
`Dockerfile.frontend`, and `docker-compose.railway.yml` exist for that stack.
The `--host ::` uvicorn default in `backend/Dockerfile.railway` is required on
Railway (IPv6-only private DNS) — non-Railway hosts must set
`UVICORN_HOST=0.0.0.0` (see below).

## Backend environment variables

| Variable                                                               | Required                       | Purpose                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAMPDF_ADMIN_TOKEN`                                                  | yes                            | Enables `/api/v1/admin/*` key issuance. Unset ⇒ those endpoints 503.                                                                               |
| `ALLOWED_ORIGINS`                                                      | yes                            | CORS allowlist, comma-separated. Must include every frontend origin.                                                                               |
| `UVICORN_HOST`                                                         | on Coolify/Docker-bridge hosts | Set `0.0.0.0`. Default `::` is IPv6-only (Railway needs it); on IPv4-published Docker ports it causes connection resets.                           |
| `PORT` / `WEB_CONCURRENCY`                                             | recommended                    | `8000` / `1` on a 2 GB box (AI models are memory-hungry).                                                                                          |
| `GROQ_API_KEY`                                                         | optional                       | Groq: hosted Whisper transcription + LLM video summaries.                                                                                          |
| `TRANSCRIBE_PROVIDER`                                                  | optional                       | `groq` \| `replicate` \| `cpu`. Unset = auto (Groq when credentialed, else Replicate, else CPU). Deliberately independent of `VIDEO_GPU_PROVIDER`. |
| `VIDEO_GPU_PROVIDER` + `REPLICATE_API_TOKEN`                           | optional                       | `replicate` enables GPU video watermark removal (ProPainter) and video matting. Groq has no video models — it can never serve these.               |
| `GEMINI_API_KEY`                                                       | optional                       | Edit Banana image editing + Gemini watermark detection/inpaint.                                                                                    |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL`                              | optional                       | Alternative LLM summaries (wider model choice than Groq).                                                                                          |
| `CLERK_ISSUER` (+ `CLERK_SECRET_KEY`, `CHAMPDF_API_KEY_EMAIL_DOMAINS`) | optional                       | Self-serve API keys from the site's account menu. Unset ⇒ `/api/v1/keys/me` 503s.                                                                  |
| `PDF_TSA_URL`                                                          | optional                       | RFC 3161 timestamp authority for signing (default DigiCert).                                                                                       |

Frontend build vars: `VITE_API_URL` (baked at build time), optional
`VITE_CLERK_PUBLISHABLE_KEY`.

**Persistent storage (don't skip):** mount a volume at `/app/data` — the API
key store (`champdf.db`, SQLite) lives there. Without it every redeploy wipes
all issued keys. Everything else is stateless.

## Operational notes (learned in production)

- **Memory**: the image needs ~2 GB at runtime. At 1 GB it crash-loops.
- **Disk**: image builds are large (torch, LibreOffice, ML model downloads
  baked into layers). On a small host, prune Docker build cache before big
  rebuilds — a build failing with `No space left on device` mid
  model-download is the disk telling you. Coolify: Server → Docker Cleanup →
  Trigger Manual Cleanup (leave the volume/network deletion toggles off).
- **Groq model retirements**: Groq removes hosted chat models without notice
  (`llama-3.3-70b-versatile` 404s since Aug 2026). `GET
https://api.groq.com/openai/v1/models` is the source of truth; default
  lives in `backend/groq_client.py` (`GROQ_MODEL` overrides). Note
  api.groq.com is behind Cloudflare and rejects Python's default urllib
  User-Agent — `groq_client` sends its own.
- **GPU cost control**: video inpainting crops a padded window around the
  watermark and composites only the masked box back (67–93 % fewer GPU pixels
  billed depending on resolution). Knobs: `GPU_VIDEO_CROP_*` in
  `backend/config.py`; `GPU_VIDEO_MAX_SECONDS` caps clip length.
- **Uptime**: an hourly external monitor checks `/health`,
  `/api/capabilities`, and the frontend, and opens a GitHub issue titled
  "CHAMPDF PRODUCTION DOWN" on sustained failure — watch repo notifications.

## Verify a deployment

```bash
BASE=https://champdf-api.64.227.154.215.sslip.io
curl $BASE/health                    # {"status":"healthy",...}
curl $BASE/api/capabilities          # feature map — check what's enabled
curl $BASE/docs -o /dev/null -w '%{http_code}\n'   # 200 (Swagger)

# Issue a key and smoke the enterprise API
curl -X POST $BASE/api/v1/admin/keys \
  -H "X-Admin-Token: $CHAMPDF_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"label":"smoke","monthly_quota":100}'
curl $BASE/api/v1/whoami -H "Authorization: Bearer champdf_live_..."
```

Full API reference: [`backend/API_V1.md`](../backend/API_V1.md) ·
public docs: `/developers.html` and `/llms.txt` on the deployed frontend.
