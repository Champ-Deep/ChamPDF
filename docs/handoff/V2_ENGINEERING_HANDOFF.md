# ChamPDF V2 — Engineering Handoff & Design Direction

> **Audience:** backend dev, frontend dev, and frontend designer.
> **Status:** the three V2 AI features below are built, verified, and live on the
> `v2` branch (deployed to the Railway test environment). This doc is the
> contract + roadmap + design direction to take it from here.
>
> Companion docs (do not duplicate — extend them):
> `docs/design/V2_UX_BLUEPRINT.md`, `docs/design/CLAUDE_DESIGN_BRIEF.md`,
> `docs/design/prototype/index.html`, `docs/self-hosting/LOCAL_AND_RAILWAY.md`.

---

## 0. The product in one paragraph

ChamPDF is a privacy-first PDF + media toolkit (a Champions Group fork of
BentoPDF). Most tools run **100% in the browser**. V2 adds a **self-hosted AI
engine** (FastAPI backend) for the things the browser can't do well — the
headline being the **"Rebrand Studio"**: take AI-generated media (NotebookLM
videos, AI images, watermarked PDFs), **strip the watermark cleanly, and
rebrand it with a company logo**. The differentiator vs. consumer tools is
**trust**: the heavy lifting runs on _our own servers_, not a third party,
unless a feature explicitly opts into an external model (and we say so).

---

## 1. Architecture at a glance

```
Browser ──relative /api/*──▶ champdf-frontend (Nginx, Dockerfile.frontend)
                                   │ proxy_pass $BACKEND_URL
                                   ▼
                            champdf-backend (FastAPI, backend/Dockerfile.railway)
                                   │  (self-hosted: LaMa, Whisper, Real-ESRGAN, rembg, OpenCV/FFmpeg)
                                   └──opt-in external──▶ Gemini · OpenRouter · Replicate(GPU)
```

- The browser **never** calls the backend directly — it calls relative `/api/*`
  on the frontend origin; Nginx reverse-proxies to `BACKEND_URL`. Swapping the
  compute server is one env var, no rebuild. (`nginx.railway.conf.template`)
- **Everything heavy is env-gated** and reported by `GET /api/capabilities`, so
  a missing key leaves a feature _off_ rather than throwing a 500.
- Concurrency is bounded by a global `process_semaphore`
  (`MAX_CONCURRENT_JOBS`, default 2); the URL endpoints have a per-IP sliding
  window rate limit (`_check_rate_limit`).
- Frontend: Vite + TypeScript + Tailwind, multi-page (`src/pages/*.html` +
  `src/js/logic/*-page.ts`), tools registry in `src/js/config/tools.ts`
  (`pillar`: documents | images | video, plus `keywords`).

---

## 2. Backend API contract (for the backend dev + frontend dev)

All under the frontend origin as `/api/...`. JSON errors follow either FastAPI's
`{ "detail": "..." }` (HTTPException) or the structured
`{ "code", "message" }` shape (URL/insights endpoints).

| Endpoint                      | Method | Inputs                                                                                              | Returns                         | Gated by                                   |
| ----------------------------- | ------ | --------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------ |
| `/health`                     | GET    | —                                                                                                   | `{status, ffmpeg}`              | always                                     |
| `/api/capabilities`           | GET    | —                                                                                                   | feature flags (see §3)          | always                                     |
| `/api/presets`                | GET    | —                                                                                                   | available logo presets          | always                                     |
| `/api/remove-background`      | POST   | `image`                                                                                             | PNG (cutout)                    | rembg/U2Net                                |
| `/api/process-video`          | POST   | `file`, `logo_preset`, `watermark_position`, `logo_scale` (0.5–2.0), **`quality` = `fast`\|`best`** | MP4                             | always (best→GPU offload, auto-falls back) |
| `/api/edit-image`             | POST   | `image`, `prompt`                                                                                   | edited PNG                      | `GEMINI_API_KEY`                           |
| `/api/inpaint`                | POST   | `file`, `mask` (white=remove)                                                                       | PNG                             | `ENABLE_INPAINT` (LaMa)                    |
| `/api/inpaint-image`          | POST   | `image`, `mask`, `prompt?`, `radius?`                                                               | PNG                             | Gemini inpaint w/ OpenCV fallback          |
| `/api/remove-image-watermark` | POST   | `file`, `regions?` (JSON), `auto_detect?`                                                           | PNG                             | `ENABLE_INPAINT` (LaMa)                    |
| `/api/detect-watermark`       | POST   | `file`                                                                                              | `{detections[], has_templates}` | OpenCV template match                      |
| `/api/detect-watermarks`      | POST   | `image`                                                                                             | `{boxes[]}`                     | Gemini/OpenCV (v2)                         |
| `/api/upscale-image`          | POST   | `file`, `scale` (2/4), `output_format`                                                              | image                           | `ENABLE_UPSCALE` (Real-ESRGAN)             |
| `/api/transcribe-video`       | POST   | `file`, `language?`                                                                                 | `.srt`                          | `ENABLE_CAPTIONS` (Whisper)                |
| `/api/download-from-url`      | POST   | `url`, `format` (mp4/mp3)                                                                           | media                           | yt-dlp + rate limit                        |
| `/api/video-insights`         | POST   | `url`, `transcript`, `summary`, **`multimodal`**, `model?`                                          | see below                       | Whisper + opt. OpenRouter / Gemini         |

**`/api/video-insights` response** depends on the path taken:

- `multimodal:true` + YouTube URL + `GEMINI_API_KEY` → `{source:"gemini", summary, learnings[], chapters[]}` (no download).
- otherwise → `{source:"whisper", transcript, srt, summary?, model?}` (download + Whisper, optional OpenRouter summary). The Gemini path **falls through** to Whisper on failure.

### New in V2 (the three just shipped)

1. **Gemini YouTube analysis** — `backend/video_analyzer.py`; URL → summary + key
   learnings + chapters via Gemini's native video understanding.
2. **AI Image Editor brush-remove** — frontend `edit-banana-page.ts` now has a
   **Remove (brush)** mode that paints a mask and POSTs to the existing
   **`/api/inpaint`** (self-hosted LaMa). Prompt-edit mode (Gemini) unchanged.
3. **GPU video watermark removal** — `backend/gpu_video_remover.py`; the
   `quality=best` path offloads inpainting to **Replicate (hosted ProPainter)**,
   then re-muxes audio + overlays the logo locally. Auto-falls back to CPU.

---

## 3. `/api/capabilities` flags (drive show/hide in the UI)

```jsonc
{
  "background_removal": true,
  "video_rebrand": true,
  "inpaint": true,              // LaMa (self-hosted) — brush remove, PDF/image watermark
  "upscale": true,              // Real-ESRGAN
  "captions": true,             // Whisper transcribe
  "watermark_autodetect": false,// true once a template PNG is installed
  "gemini_inpaint": false,      // GEMINI_API_KEY present → editor "Prompt edit", inpaint-image
  "video_transcript": true,
  "video_summary": false,       // OPENROUTER_API_KEY present
  "video_analyze": false,       // GEMINI_API_KEY present → "Analyze video (AI)"
  "gpu_video": false,           // VIDEO_GPU_PROVIDER=replicate + REPLICATE_API_TOKEN → "Best (GPU)"
  "summary_models": [ ... ]     // OpenRouter model picker options
}
```

> **Frontend dev — important:** several pages already hide/disable on these flags;
> some (editor, rebrander, downloader) currently always show the new options and
> rely on graceful backend fallback. Standardize this: **fetch `/api/capabilities`
> once on load**, cache it, and render unavailable features in a "needs setup"
> state (see §6 design note), never as a hard error.

---

## 4. Deployment & environment (for the backend dev / devops)

- **Deploy model:** Railway's native GitHub integration watches the **`v2`**
  branch (there is no deploy workflow in-repo). **Push to `v2` → both
  `champdf-frontend` and `champdf-backend` rebuild and redeploy to the test
  environment.** `railway.toml` defines the services + a third optional
  `champdf-mcp`. Confirm the deploy branch is `v2` (service → Settings →
  Source/Branch); else point it there or hit Redeploy.
- **The frontend image must rebuild** to pick up Nginx/`dist` changes; the
  backend reinstalls `requirements.txt` (now includes `replicate`).

### Environment variables (champdf-backend) — all optional, additive

| Variable                                                                                                    | Enables                                                         | Default / note             |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------- |
| `GEMINI_API_KEY`                                                                                            | Editor _Prompt edit_ + YouTube _Analyze video_ + Gemini inpaint | —                          |
| `GEMINI_VIDEO_MODEL`                                                                                        | analysis model                                                  | `gemini-2.5-flash`         |
| `OPENROUTER_API_KEY`                                                                                        | Video Downloader _AI summary_                                   | transcript is keyless      |
| `OPENROUTER_MODEL`                                                                                          | summary model                                                   | `openai/gpt-4o-mini`       |
| `VIDEO_GPU_PROVIDER`                                                                                        | `replicate` to enable _Best (GPU)_                              | `none`                     |
| `REPLICATE_API_TOKEN`                                                                                       | required when provider=replicate                                | —                          |
| `REPLICATE_PROPAINTER_MODEL`                                                                                | override model slug                                             | `jd7h/propainter`          |
| `GPU_VIDEO_TIMEOUT`                                                                                         | wait cap for the GPU job                                        | `840` (keep < Nginx 900s)  |
| `GPU_VIDEO_MAX_SECONDS`                                                                                     | refuse to offload longer clips (cost guard)                     | `120`                      |
| `DEVICE`, `ENABLE_INPAINT/CAPTIONS/UPSCALE`, `WHISPER_MODEL_SIZE`, `MAX_CONCURRENT_JOBS`, `ALLOWED_ORIGINS` | core tuning                                                     | see `backend/.env.example` |

**champdf-frontend:** `BACKEND_URL` (already set to the private backend URL); do
**not** set `VITE_API_URL`.

### Gotchas to hand off explicitly

- **Long GPU jobs vs proxy:** Nginx `/api` `proxy_read_timeout` is now **900s**
  (`nginx.railway.conf.template`), backend `GPU_VIDEO_TIMEOUT=840s`. If Railway's
  **public edge** still 504s on long clips, the reliable lever is to lower
  `GPU_VIDEO_MAX_SECONDS`.
- **Semaphore starvation:** a multi-minute GPU job holds 1 of 2 concurrency
  permits the whole time. For real traffic this argues for an **async job
  queue** (see §5 roadmap).
- **Cold starts / model weights:** LaMa/Whisper/Real-ESRGAN download on first use;
  mount a Railway volume on the cache dirs to avoid re-downloading on redeploy.
- **Replicate billing** is per GPU-second; first call cold-boots the model.

---

## 5. Roadmap — more functionality (intentional, in priority order)

### A. Unify the "Rebrand Studio" (headline; design-led)

The backend already has every piece: detect → inpaint (LaMa) → logo overlay →
(video) audio mux → (optional) analyze. **Build one guided flow** that picks the
right engine by input type:

- **PDF** → render pages → detect/brush → `/api/inpaint` per page → drag/size
  logo → apply to **all pages** (this is **issue #41**; the drag+scale logo
  overlay already exists in `remove-image-watermark-page.ts`, generalize it).
- **Image** → `/api/inpaint` (brush) or `/api/remove-image-watermark` → logo.
- **Video** → `/api/process-video` (fast/best) → logo + audio preserved.
  One entry, one "choose your logo / place it / size it" step, one result screen.

### B. Convert dedup (deferred — do next)

Bidirectional, auto-detecting converters that collapse duplicate tools:
**Word ⇄ PDF, PowerPoint ⇄ PDF, Images ⇄ PDF**. Detect direction from the
dropped file type; fix the mismatched tool descriptions. (LibreOffice WASM is
already in the bundle; service-worker caching of the big `.gz` files was the
issue #16 root cause — already fixed.)

### C. Async job model for long tasks

Move GPU video + long Whisper jobs to a **submit → poll/notify** pattern
(`POST` returns a `job_id`; `GET /api/jobs/{id}` for status; optional SSE). Frees
the semaphore, removes the 15-min held HTTP connection, and unlocks honest
progress UI. Prereq for scaling the GPU path.

### D. Per-tool "where your data goes" transparency

Backend already knows whether a path is self-hosted vs external. Expose a
per-tool privacy descriptor (extend `/api/capabilities` or a small
`/api/tool-meta`) so the UI can render a truthful privacy badge automatically.

### E. Smaller wins

- Auto-detect prefill in the editor brush mode (call `/api/detect-watermark`
  then pre-paint) — endpoint already wired, just needs a default template PNG
  installed (`backend/assets/watermark_templates/notebooklm.png`).
- Moving-watermark support for video (current GPU mask is static — fine for
  fixed NotebookLM marks, weak for moving ones).
- Batch mode (multiple files through the same rebrand settings).

---

## 6. Design suggestions grounded in what the backend can do (for the designer)

These are _backend-driven_ design intents — things the engine now makes possible
that the visual design should express. Pair with the directions in
`CLAUDE_DESIGN_BRIEF.md` (recommend **Direction A "Editorial Calm"**, trust/calm,
**no mascot**).

1. **Capability-aware UI, never dead ends.** The backend tells you exactly which
   features are on (`/api/capabilities`). Design three states for every AI
   action: **available**, **"needs setup"** (key not configured — quiet, not an
   error), and **running**. No feature should ever render a raw 500.

2. **Make the speed/quality/privacy trade-off legible.** We have _three_ removal
   engines with different properties. The **Fast (CPU) / Best (GPU)** toggle is
   the template: pair each option with a one-line "what you trade" and a
   **privacy chip** — `On our servers` (LaMa/Whisper/Real-ESRGAN) vs
   `External GPU` (Replicate) vs `External AI` (Gemini/OpenRouter). Trust is the
   brand; surface it at the point of choice.

3. **One canvas-editor component, reused everywhere.** Brush-mask (editor),
   rectangle-select (image watermark), and draggable/resizable **logo overlay**
   (issue #41) are the same interaction family. Spec a single
   **"Mark & Place"** component (paint / box / move-resize, touch + mouse,
   crosshair, clear, auto-detect) and reuse it in PDF watermark, image watermark,
   and the editor. It already exists piecemeal — unify the visual language.

4. **Honest long-running states.** GPU video + transcription can take minutes and
   run _externally_. Design a **real progress/standby pattern** (stages:
   "Uploading → Cleaning on GPU → Re-adding audio & logo → Done"), not a spinner
   held for 10 minutes. This pairs with roadmap §5C (async jobs) — design it now
   so engineering can build toward it.

5. **Rebrand Studio as the hero, the rest as a calm grid.** The studio is one
   guided flow (input → remove → choose/place/size logo → result) that should
   feel like a product, while the 40+ utility tools stay a fast,
   **search + task + browse** grid (⌘K palette already specced). Reserve motion
   and richness for the studio; keep the grid quiet with subtle per-tool hover
   micro-animations.

6. **Result screens should invite the next step.** The editor already pipes a
   result back in as a new source (remove → prompt → remove). Design result
   screens with **"do more"** affordances (re-edit, add logo, upscale, download)
   rather than a dead "Download" terminus — the backend supports chaining.

7. **Show the logo, let them own it.** Logo selection isn't a dropdown — it's
   place + scale on a live preview (drag, %-size). Make logo identity (Champions
   / LakeB2B / Ampliz / upload-your-own) a first-class, branded step.

---

## 7. Handoff notes / where to start

- **Backend dev:** the contract in §2/§3 is stable; the highest-leverage next
  build is the **async job model (§5C)** because the GPU path needs it to scale.
  Then generalize per-page PDF inpaint for the Rebrand Studio (§5A / issue #41).
  All new modules follow the existing `*_available()` + `/api/capabilities`
  pattern — keep it.
- **Frontend dev:** standardize the **capabilities fetch + 3-state rendering**
  (§3 note), then wire the unified **Rebrand Studio** flow over existing
  endpoints (no new backend needed for v1 of it). Reuse `formatBytes`,
  `downloadFile`, `showAlert`, the `$<T>()`/show/hide helpers, and the existing
  canvas/drag code rather than re-inventing.
- **Designer:** start from `CLAUDE_DESIGN_BRIEF.md` Direction A + the §6 intents
  here. The two artifacts engineering needs most: the unified **Mark & Place**
  component spec (§6.3) and the **Rebrand Studio** flow (§5A / §6.5).
- **Verify a deploy is live:** `GET /api/capabilities` should show the flags for
  whatever keys are set; the UI should show the **Prompt edit / Remove (brush)**
  toggle (editor), **Fast / Best** toggle (rebrander), and **Analyze video (AI)**
  option (downloader).

```
git log --oneline -5 origin/v2   # fcba08f, 1c2453e, 5f26e74, b61f4f1 should be present
```
