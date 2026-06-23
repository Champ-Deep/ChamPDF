# Local Testing & Railway Deployment (V2 AI features)

This guide covers testing the AI media features (LaMa watermark removal, NotebookLM
auto-detect, Whisper captions, Real-ESRGAN upscaling) locally, then deploying to Railway.

> The AI features need the **backend** (FastAPI). They require `torch`, `ffmpeg`, etc.,
> which only exist inside the Docker images — so test via Docker, not bare `npm`/`uvicorn`.

---

## 1. Test locally (Docker Compose — recommended)

This builds the frontend (`:8080`) and the backend (`:8000`) together.

```bash
# from repo root
docker compose -f docker-compose.dev.yml up --build
```

- Frontend: http://localhost:8080
- Backend: http://localhost:8000 (Swagger UI at http://localhost:8000/docs)

The first backend build is large (CPU torch + Real-ESRGAN + faster-whisper + rembg).
The **first request to each AI tool** also downloads that model once (LaMa ~200MB,
Whisper base ~150MB, Real-ESRGAN ~70MB), so it will be slow the first time.

### Smoke-test the backend

```bash
curl localhost:8000/health                 # {"status":"healthy","ffmpeg":true}
curl localhost:8000/api/capabilities       # which AI features are enabled
```

### Test each feature in the UI (http://localhost:8080)

- **Image Watermark Remover** → choose **AI Inpaint**, draw a box (or **Auto-detect**), Process.
- **Video Logo Remover** → upload a clip, keep **Auto-detect** on, optionally **Burn in captions**.
- **AI Image Upscaler** → upload an image, pick 2x/4x.

### Enable NotebookLM auto-detection

Auto-detect needs a reference crop. Add one and rebuild:

```bash
# Save a tight PNG crop of the NotebookLM mark here:
backend/assets/watermark_templates/notebooklm.png
```

Then `curl localhost:8000/api/capabilities` should show `"watermark_autodetect": true`.

### Frontend-only (no AI) quick check

```bash
npm install
npm run dev            # http://localhost:5173  (PDF/image tools work; AI tools need the backend)
npm run test:run       # 214 tests
npm run build          # full production build
```

---

## 2. Deploy to Railway

`railway.toml` defines two services: **champdf-frontend** (`Dockerfile.frontend`,
Nginx) and **champdf-backend** (`backend/Dockerfile.railway`, FastAPI). Nginx proxies
`/api/*` to the backend, so the browser only ever talks to the frontend origin.

### Steps

1. Push this branch and create the Railway project from the repo (or `railway up`).
2. Railway will build both services from `railway.toml`.
3. Set environment variables (Dashboard → each service → Variables):

**champdf-backend**
| Variable | Value | Notes |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://<your-frontend-domain>` | Comma-separated; your public frontend URL(s) |
| `DEVICE` | `cpu` | or `cuda` on a GPU host |
| `WHISPER_MODEL_SIZE` | `base` | `tiny` for speed, `small`/`medium` for accuracy |
| `MAX_CONCURRENT_JOBS` | `2` | Lower if memory-constrained |
| `ENABLE_UPSCALE` / `ENABLE_CAPTIONS` / `ENABLE_INPAINT` | `true` | Turn features off to save memory |
| `GEMINI_API_KEY` | `...` | Optional. Enables AI Image Editor (prompt mode) + multimodal YouTube **Analyze video** |
| `OPENROUTER_API_KEY` | `sk-or-...` | Optional. Enables the Video Downloader's transcript → **AI summary** |
| `VIDEO_GPU_PROVIDER` | `replicate` | Optional. Enables **Best (GPU)** video removal. Default `none` |
| `REPLICATE_API_TOKEN` | `r8_...` | Required when `VIDEO_GPU_PROVIDER=replicate` |
| `REPLICATE_PROPAINTER_MODEL` | `jd7h/propainter` | Optional. Override the hosted ProPainter model slug |
| `GPU_VIDEO_TIMEOUT` / `GPU_VIDEO_MAX_SECONDS` | `600` / `120` | Optional. Wait cap and max clip length to offload |

**champdf-frontend**
| Variable | Value | Notes |
|---|---|---|
| `BACKEND_URL` | `http://champdf-backend.railway.internal:8000` | Railway private networking; Nginx `proxy_pass` target |
| (do **not** set `VITE_API_URL`) | — | Leave empty so the app uses relative `/api/...` through the proxy |
| `VITE_CLERK_PUBLISHABLE_KEY` | `pk_test_…` / `pk_live_…` | Optional. Enables Clerk sign-in. **Build-time** var — Vite bakes it in, so it must be set on the frontend service before the build. Publishable key is public/safe. Unset → falls back to the built-in auth modal. Get it from clerk.com → your app → API keys. |

4. Verify after deploy:

```bash
curl https://<frontend-domain>/api/capabilities   # proxied to backend
curl https://<backend-domain>/health              # if backend is publicly exposed
```

### Deployment notes (important)

- **Memory:** torch + Whisper + Real-ESRGAN are heavy. Use **≥ 2 GB** (4 GB recommended).
  Models load lazily (only when a feature is first used), so idle memory stays low.
- **Model caching / cold starts:** model weights download on first use to the container
  filesystem, which Railway resets on redeploy. To avoid repeated downloads, either
  mount a **Railway Volume** at the cache dirs (`/root/.cache`, `/root/.u2net`,
  `/root/.realesrgan`) or pre-download them in `backend/Dockerfile.railway`.
- **Upload size:** Nginx allows `client_max_body_size 100M` for `/api/`; matches the
  backend's 100 MB video / 10 MB image limits.
- **Healthcheck:** backend uses `/health` (responds instantly — it does not block on
  model loading), with a 120 s timeout configured in `railway.toml`.
- **GPU:** for much faster inference, deploy the backend on a GPU host and install the
  CUDA torch build (change the `--index-url` in `backend/Dockerfile.railway`) and set
  `DEVICE=cuda`.

### GPU video watermark removal without owning a GPU (Best quality)

Railway has **no GPU**, and the local CPU path (OpenCV/FFmpeg) is only good on flat
backgrounds. The Video Logo Remover's **Best (GPU)** option offloads the heavy
inpainting to a hosted GPU provider (Replicate's ProPainter) while Railway stays the
orchestrator — it extracts the audio, sends the video + a static watermark mask to the
provider, then re-muxes the audio and overlays your logo locally.

To enable it on **champdf-backend**:

```bash
VIDEO_GPU_PROVIDER=replicate
REPLICATE_API_TOKEN=r8_xxx          # from replicate.com/account/api-tokens
# optional overrides:
# REPLICATE_PROPAINTER_MODEL=jd7h/propainter
# GPU_VIDEO_TIMEOUT=600             # seconds to wait for the remote job
# GPU_VIDEO_MAX_SECONDS=120         # refuse to offload longer clips (cost guard)
```

Then `curl https://<frontend-domain>/api/capabilities` should show `"gpu_video": true`,
and the UI's **Best (GPU)** option becomes effective. Notes:

- **Cost + latency:** Replicate bills per second of GPU time and runs asynchronously,
  so Best is slower (and not free). Keep `GPU_VIDEO_MAX_SECONDS` modest.
- **Graceful fallback:** if the token is missing or the remote job fails, the backend
  automatically falls back to the Fast (CPU) path — Best never hard-errors.
- **Static mask:** one mask is applied to every frame, which is correct for
  fixed-position marks (NotebookLM, etc.); moving marks are weaker.
- **Privacy:** only the **Best** path leaves your infrastructure. Fast (CPU) and all
  other AI tools stay entirely on your own servers.

---

## 3. Troubleshooting

| Symptom                                       | Fix                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| AI tool returns 400 "disabled on this server" | The matching `ENABLE_*` env var is false                                                       |
| Auto-detect says "no template installed"      | Add `backend/assets/watermark_templates/*.png` and redeploy                                    |
| CORS error in browser                         | Add the frontend origin to backend `ALLOWED_ORIGINS`                                           |
| Video tool 502 / long hang                    | First-run model download or under-provisioned memory; raise plan / lower `MAX_CONCURRENT_JOBS` |
| `/health` shows `"ffmpeg": false`             | ffmpeg missing — only happens outside Docker; the images install it                            |

---

## 4. Connecting a backend compute server (server-side processing)

**How it works.** The browser never calls the backend directly. It calls
relative `/api/*` paths on the **frontend** origin; the frontend's Nginx
reverse-proxies every `/api/*` request to whatever `BACKEND_URL` points at:

```
Browser ──/api/process-video──▶ Frontend (Nginx)  ──proxy_pass $BACKEND_URL──▶ Backend (FastAPI + FFmpeg + torch)
```

So **connecting a compute server is a single env var**: set `BACKEND_URL` on the
**frontend** service. No frontend rebuild is needed — it's applied at container
start. The proxy is already tuned for server-side jobs: **300 s** timeouts,
request buffering off (true streaming uploads), and `client_max_body_size 100M`.

### Option A — Two Railway services (recommended, easiest)

This is what `railway.toml` already defines (`champdf-frontend` +
`champdf-backend`). Use Railway's **private networking** so the backend never
needs a public URL:

1. Deploy both services from the repo (branch `v2`).
2. On **champdf-frontend**, set:
   `BACKEND_URL = http://champdf-backend.railway.internal:8000`
   (private DNS name = the backend service name + `.railway.internal`).
3. On **champdf-backend**, set `ALLOWED_ORIGINS = https://<frontend-domain>`.
4. Give the backend **≥ 2 GB RAM** (video + torch). Done — `/api/*` now flows to it.

> `BACKEND_URL` is tolerant: a value with no scheme (e.g. pasted as
> `champdf-backend.railway.internal:8000`) is auto-prefixed with `http://`, and
> an empty value falls back to `http://localhost:8000`, so the frontend never
> crash-loops on a bad value.

### Option B — Bring your own compute box (e.g. a GPU server)

To offload heavy video/AI to a dedicated machine (GPU box, another host, even a
different Railway project):

1. Run the backend image (`backend/Dockerfile.railway`) anywhere that exposes an
   HTTPS (or internal HTTP) URL. For GPU: build torch with the CUDA index in the
   Dockerfile and set `DEVICE=cuda`.
2. Point the frontend at it: `BACKEND_URL = https://my-compute-box.example.com`.
   External **HTTPS** backends now work — Nginx sends SNI (`proxy_ssl_server_name on`).
3. Set the backend's `ALLOWED_ORIGINS` to your frontend domain.

You can swap compute servers any time by changing `BACKEND_URL` and redeploying
the frontend — the app code never changes.

---

## 5. Verify the Video Logo Remover end-to-end

This is the tool that previously failed on Railway (issue #19). Run these in
order after deploying:

```bash
# 1. Backend is up and sees ffmpeg (must be true inside Docker)
curl https://<frontend-domain>/api/health
#    → {"status":"healthy","ffmpeg":true}

# 2. The proxy reaches the backend (not the SPA fallback)
curl https://<frontend-domain>/api/capabilities
#    → JSON with video_rebrand:true  (if you get HTML, BACKEND_URL is wrong)

# 3. Real video job through the proxy
curl -X POST https://<frontend-domain>/api/process-video \
  -F "file=@sample.mp4" -F "logo_preset=none" -F "watermark_position=bottom-right" \
  -o out.mp4 -D -      # -D - prints response headers
```

Then in the UI: **Video Logo Remover** → upload a short clip → Process →
download. Expect 10 s–a few minutes on CPU for the first run (model/ffmpeg warm-up).

### Why it failed before → what's fixed in v2

| Old failure                              | Cause                                              | Fix in v2                                      |
| ---------------------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| `413` on `/api/process-video`            | Nginx default ~1 MB body cap                       | `client_max_body_size 100M` on `/api/`         |
| `504` / "unknown error" after ~60 s      | Nginx default 60 s proxy timeout < processing time | `proxy_*_timeout 300s` + buffering off         |
| "server-side operation not running"      | Frontend couldn't reach the backend                | `BACKEND_URL` → backend via private networking |
| Frontend crash-loop on bad `BACKEND_URL` | scheme-less/empty value                            | normalize script auto-fixes it                 |

If `/api/health` returns HTML instead of JSON, `BACKEND_URL` is unset/wrong on
the frontend service — fix that first; it's the #1 cause of "video doesn't work."
