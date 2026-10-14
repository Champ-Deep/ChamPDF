# Media upload and download verification

## Local regression checks

Use Node 24.15 or newer within the Node 24 release line.

```bash
npm ci
npx tsc --noEmit
npm run test:run
npm run build
python3 scripts/test-media-proxy.py
```

The Python check requires Docker and the `nginxinc/nginx-unprivileged:stable-alpine-slim`
image. It uses each production Dockerfile's actual template destination and
`NGINX_ENVSUBST_*` settings, then runs the official Nginx image entrypoint.
It verifies a 10 MiB image and a 100 MiB video plus multipart fields reach an
upstream byte-counting server, checks an API URL ending in `.json` does not hit
static routing, and verifies a 102 MiB request is still rejected with HTTP 413.
This is a real proxy test, not an ML processing test.

The Vitest page tests exercise upload, download buttons and filenames, the
remove-only video preset, HTML HTTP 413/502/504 responses, retry after failure,
and invalid or empty media responses. Fetch is mocked in these page tests.

## Deployment checks

The Railway frontend template contains top-level `pid`, `events`, and `http`
directives. It must be rendered to `/etc/nginx/nginx.conf`, not `conf.d/default.conf`.
The template substitution filter must preserve Nginx variables such as `$host`
and `$uri`, and substitute only `PORT` and `BACKEND_URL`.

Deploy the reviewed frontend image with `BACKEND_URL` pointing to a running
FastAPI backend. The 101 MiB proxy request cap reserves multipart headroom.
It does not change the backend's 10 MiB image or 100 MiB video file limits.

```bash
curl --fail-with-body https://<frontend-domain>/api/presets
curl --fail-with-body https://<frontend-domain>/api/capabilities
curl --fail-with-body https://<backend-domain>/health

curl --fail-with-body https://<frontend-domain>/api/remove-background \
  -F 'file=@portrait.png' -F 'output_format=png' -o portrait_no_bg.png

curl --fail-with-body https://<frontend-domain>/api/process-video \
  -F 'file=@watermarked.mp4' -F 'logo_preset=none' \
  -F 'watermark_position=bottom-right' -F 'quality=fast' \
  -o watermarked_rebranded.mp4
```

Then use each tool in the browser, process a file, and click Download. Verify the
PNG has transparency and the MP4 is playable with its original audio.
A 502 or 503 indicates an unavailable backend, not a successful processing job.
Check the frontend `BACKEND_URL`, private-network connectivity and backend logs
before diagnosing the media processor.

At implementation time, `https://champdf.up.railway.app/api/presets` returned
HTTP 502. This branch fixes reproducible local code/configuration failures;
it does not claim that the production service has been repaired or redeployed.
Production recovery needs deployment access and human release approval.
