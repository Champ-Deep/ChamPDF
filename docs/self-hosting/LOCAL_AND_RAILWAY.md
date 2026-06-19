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

**champdf-frontend**
| Variable | Value | Notes |
|---|---|---|
| `BACKEND_URL` | `http://champdf-backend.railway.internal:8000` | Railway private networking; Nginx `proxy_pass` target |
| (do **not** set `VITE_API_URL`) | — | Leave empty so the app uses relative `/api/...` through the proxy |

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

---

## 3. Troubleshooting

| Symptom                                       | Fix                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| AI tool returns 400 "disabled on this server" | The matching `ENABLE_*` env var is false                                                       |
| Auto-detect says "no template installed"      | Add `backend/assets/watermark_templates/*.png` and redeploy                                    |
| CORS error in browser                         | Add the frontend origin to backend `ALLOWED_ORIGINS`                                           |
| Video tool 502 / long hang                    | First-run model download or under-provisioned memory; raise plan / lower `MAX_CONCURRENT_JOBS` |
| `/health` shows `"ffmpeg": false`             | ffmpeg missing — only happens outside Docker; the images install it                            |
