# Media providers: local, Replicate via treg, OpenRouter, Gemini

How ChamPDF's image capabilities are served, what was measured on the live
backend, what treg can and cannot do for them, and how to switch engines per
capability without a code change. Companion: `docs/DEPLOYMENT.md`.

## What the live backend actually does today (measured 2026-09-10)

Probe: a 256x192 PNG against the Coolify backend
(`champdf-api.64.227.154.215.sslip.io`, 2 GB, CPU only). champdf.com, www and
the Vercel deployment all proxy to this same backend.

| Capability                        | Endpoint                      | Result                                   | Wall time |
| --------------------------------- | ----------------------------- | ---------------------------------------- | --------- |
| Background removal (rembg, local) | `/api/remove-background`      | 200, RGBA PNG                            | 4.7 s     |
| Object removal (LaMa, local)      | `/api/inpaint`                | 200                                      | 11.5 s    |
| Watermark removal (LaMa, local)   | `/api/remove-image-watermark` | 200                                      | 5.8 s     |
| Mask inpaint, Gemini path         | `/api/inpaint-image`          | 200, **OpenCV fallback** (no Gemini key) | 1.5 s     |
| Upscale 2x (Real-ESRGAN, local)   | `/api/upscale-image`          | 200, 512x384                             | **51 s**  |
| Prompt editing (Edit Banana)      | `/api/edit-image`             | **503**, `GEMINI_API_KEY` not set        | -         |
| Template watermark detection      | `/api/detect-watermark`       | 200, no templates installed              | 1.6 s     |

So the local models are not broken. They are slow on a 2 GB CPU box, and
upscaling in particular is unusable at real photo sizes (51 s for a thumbnail
means minutes for a phone photo, past the proxy timeout). Prompt editing is
simply unconfigured.

Run the same probe yourself against any backend, including Railway:

```bash
python3 scripts/test-media-providers.py https://<backend-host>
```

It prints status, time, and the `X-ChamPDF-Provider` header so you can see
which engine served each call after changing a variable.

## What treg is, and what it can do for us

treg (https://treg.to) is a credential gateway with a catalogue: one token,
one base URL, 3,200 endpoints. Two ways it serves a call:

1. **Catalogue endpoints on treg's key**, metered per call from a prepaid
   balance. Verified live: `replicate.image-gen.flux-schnell` (text-to-image)
   cost $0.003 and completed in 4.4 s through the async task loop. Your org
   `champions-accelerator` had $0.98 of promo credit after the tests.
2. **Your own keys registered in treg**, injected server-side on any request
   to that provider's host (`https://treg.to/call/https://api.replicate.com/...`).
   Never metered by treg, always audited, and the key never lives on our box.

What the catalogue has for media, on treg's key:

| Job                  | Catalogue                                                                                           | Price                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Text-to-image        | `replicate.image-gen.flux-schnell`, `minimax.image-gen.from_text`                                   | $0.003 to $0.03                                              |
| Video generation     | 99 rows: MiniMax Hailuo, Seedance, Veo 3.1, Kling, Wan, Runway (via Replicate, MiniMax, OpenRouter) | $0.56 to $8 per clip                                         |
| Prompt image editing | `replicate.x.google-nano-banana`, `nano-banana-pro`, `flux-kontext-pro/max`, `gpt-image-2`          | **bring your own Replicate key** (rows exist, no treg price) |

What the catalogue does **not** have at all (searched: 0 results):
background removal, upscaling / super-resolution, LaMa / object removal,
watermark removal, video inpainting, speech-to-text. Those are exactly the
CPU-bound jobs we wanted to move.

**Verdict.** treg is worth using as the _credential proxy_ in front of
Replicate (and OpenRouter): every hosted model call then carries an audit
row, a call id, per-feature tags, and a spend ceiling, with no provider key
on the server. It is not, by itself, a hosted replacement for our cleanup
models. The replacement for those is Replicate's public models, reached
through treg with your own Replicate key connected. Treg's own-key catalogue
adds text-to-image and video generation, which ChamPDF does not currently
offer; that is a product decision, not a migration.

OpenRouter covers the prompt-editing case directly (Gemini 2.5 Flash Image,
"nano banana", through its Image API) and, through treg's
catalogue, video generation. OpenRouter does not host rembg, ESRGAN or LaMa.

## The switch

Each capability is routed independently by one environment variable. `auto`
(the default) takes the first configured engine in the listed order and never
fails because a key is missing; the capability just reports as unavailable.

| Variable                 | Values (order tried for `auto`)            | Default result today  |
| ------------------------ | ------------------------------------------ | --------------------- |
| `MEDIA_EDIT_PROVIDER`    | `gemini`, `openrouter`, `replicate`, `off` | unavailable (no keys) |
| `MEDIA_INPAINT_PROVIDER` | `local`, `replicate`, `gemini`, `opencv`   | local LaMa            |
| `MEDIA_BG_PROVIDER`      | `local`, `replicate`                       | local rembg           |
| `MEDIA_UPSCALE_PROVIDER` | `local`, `replicate`                       | local Real-ESRGAN     |

Engines:

| Engine       | Needs                                                                                                                                   | Notes                                                                                                                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`      | nothing                                                                                                                                 | the CPU models measured above                                                                                                                                                                                                                                                                |
| `replicate`  | `TREG_TOKEN` (+ `TREG_ORG` for an identity token) with a Replicate key connected in treg, **or** `REPLICATE_API_TOKEN` for direct calls | models: `MEDIA_REPLICATE_EDIT_MODEL` (google/nano-banana), `MEDIA_REPLICATE_INPAINT_MODEL` (allenhooo/lama), `MEDIA_REPLICATE_BG_MODEL` (cjwbw/rembg), `MEDIA_REPLICATE_UPSCALE_MODEL` (nightmareai/real-esrgan). `owner/name` uses the latest version; pin `owner/name:version` once tested |
| `openrouter` | `OPENROUTER_API_KEY`, or `OPENROUTER_VIA_TREG=true` with an OpenRouter key in treg                                                      | `OPENROUTER_IMAGE_MODEL` default `google/gemini-2.5-flash-image`                                                                                                                                                                                                                             |
| `gemini`     | `GEMINI_API_KEY`                                                                                                                        | the existing direct integration                                                                                                                                                                                                                                                              |

Guard rails: `MEDIA_MAX_COST_USD` (default 0.25) is sent as
`X-Treg-Route-Max-Cost` on treg-metered calls, and treg refuses with 402
rather than overspending. `MEDIA_HOSTED_TIMEOUT_S` (default 300) caps one
hosted job. Inpainting always falls back to OpenCV if the hosted engine fails,
so the watermark remover never returns a 500 for a provider outage.

The existing video offload (`VIDEO_GPU_PROVIDER=replicate`: ProPainter, video
matting, GPU Whisper) also rides through treg automatically when `TREG_TOKEN`
is set; `REPLICATE_VIA_TREG=false` forces the direct path.

`/api/capabilities` now reports `media_providers` (resolved provider, model,
via) and `treg.configured`, and every image response carries
`X-ChamPDF-Provider`.

## Recommended configuration for the test environment

1. In treg, connect the org's Replicate key once:
   `treg connections connect --provider replicate` (or `treg secret add replicate ...`).
   Until then every Replicate row answers "no replicate credential in this org".
2. Mint a per-org token for the server (`treg org agent-new champdf-backend`)
   rather than using a person's identity token. The identity token used for
   the tests works but is attributed to that person.
3. Railway backend variables:

   ```
   TREG_TOKEN=<per-org token>
   MEDIA_UPSCALE_PROVIDER=replicate
   MEDIA_BG_PROVIDER=auto            # local stays; flip to replicate to compare
   MEDIA_INPAINT_PROVIDER=auto       # local LaMa; flip to replicate to compare
   MEDIA_EDIT_PROVIDER=auto          # picks openrouter or replicate once a key exists
   OPENROUTER_API_KEY=<key>          # cheapest way to light up Edit Banana
   MEDIA_MAX_COST_USD=0.25
   ```

4. Run `scripts/test-media-providers.py <railway backend url>` before and after
   flipping each variable. Replicate's own pricing applies to own-key calls
   (roughly $0.002 to $0.01 per image for these models); treg shows each call
   in its Activity page with the `feature=` tag.

## Clerk and Resend on the test environment

Both integrations are code-complete on this branch; each needs one dashboard
step and a handful of variables.

**Clerk** (sender sign-in for ChampPDF Sign, and the self-serve API keys):

| Where                                                  | Variable                     | Value                                                                                            |
| ------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Frontend build (Railway `champdf-frontend` build args) | `VITE_CLERK_PUBLISHABLE_KEY` | `pk_...` from Clerk, API keys page                                                               |
| Backend                                                | `CLERK_ISSUER`               | the Clerk _Frontend API URL_ (`https://<app>.clerk.accounts.dev` or `https://clerk.champdf.com`) |
| Backend                                                | `CLERK_SECRET_KEY`           | optional, only for email lookup when the JWT carries no email claim                              |
| Backend                                                | `SIGN_SENDER_EMAIL_DOMAINS`  | `championsmail.com` (default)                                                                    |

Add a JWT template claim `champdf_sign_role` from user public metadata to
grant `legal` / `admin`; Clerk org admins are `admin` automatically. The
frontend image must be rebuilt for the publishable key to take effect (Vite
inlines it).

**Resend** (signing invitations, OTPs, executed copies):

| Where            | Variable                | Value                                                                                                              |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Resend dashboard | domain                  | `sign.championsmail.com` with its SPF, DKIM 2048 and DMARC (`p=quarantine`, then `p=reject` after two clean weeks) |
| Backend          | `RESEND_API_KEY`        | `re_...`                                                                                                           |
| Backend          | `SIGN_EMAIL_FROM`       | `Champions Superior Capital <notifications@sign.championsmail.com>`                                                |
| Backend          | `RESEND_WEBHOOK_SECRET` | from the webhook you point at `/api/sign/webhooks/resend` (delivered, bounced, complained)                         |
| Backend          | `SIGN_PUBLIC_BASE_URL`  | the frontend origin, e.g. `https://champdf-frontend.up.railway.app`                                                |

Until `RESEND_API_KEY` is set, mail is log-only: the Sign console shows the
signing link and the backend log prints the OTP, which is enough for an
internal dry run and not enough for an external one.

## What was not verified

- Replicate calls through treg with the org's own key: the org has no
  Replicate connection yet, so `replicate` routes are covered by mocked tests,
  not a live run. The model slugs are defaults to confirm on first use.
- OpenRouter image editing: no OpenRouter key was available; the request shape
  follows OpenRouter's documented image modality and is mocked in tests.
- Transcription and video endpoints were not probed (they need a video fixture);
  capabilities report them as available on the live backend.
