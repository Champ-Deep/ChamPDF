# ChamPDF on Cloudflare Containers: production proof report

Task t_a85d6acb. Base: ChamPDF `origin/v3-test-ready` @ fa74159. Branch: `ops/cf-container-proof` (config and proof only, no app code changed). Beam companion: `ops/cf-env-overlays` @ 28d08d9 on top of `origin/cloudflare` (PR #41).

## Verdict

Stateless ChamPDF tools run fine in a Cloudflare-shaped container. Stateful ones do not, and the blocker is specific: D1 has no interactive transactions, and Sign takes a write-locked transaction in 23 places (15 in `sign/service.py`, 8 in `sign/store.py`).

| Area | Result | Evidence |
|---|---|---|
| Native image (LibreOffice, tesseract, ffmpeg, torch CPU, rembg) in a standard-4 shaped container | Works. Every op returned valid output. Peak 1.3 GiB RAM of 12, 4.5 vCPU of 4 | section 2 |
| linux/amd64 build (what Cloudflare runs) | Builds and starts through `wrangler dev` (3.53 GB) | section 2 |
| Container disk as database | Fails. API key gone after replacement, interrupted request has no record, two instances never see each other's keys | section 2 |
| D1 + R2 as the durable boundary, reached from the container | Works for single statements and objects. Survived container replacement | section 4 |
| Sign store on D1 | Blocked as a 1:1 port. `BEGIN IMMEDIATE` is rejected by D1 (proved). Chain forks without a new unique index (proved) | section 4 |
| Deepify as production | Not used anywhere. `production` overlay has no Deepify reference and must pin its image by digest | section 1 |

Hold on release: Deep has not approved any remote deploy, no Cloudflare account has been touched, and nothing here has run on real Cloudflare. All of it is local.

## 1. Pinned config, overlays, manifest, CI (deliverables 1 and 4)

Files in `cloudflare/containers/`:

| File | Purpose |
|---|---|
| `package.json` + `package-lock.json` | wrangler 4.152.0, @cloudflare/containers 0.3.7, jose 6.2.13, workers-types 5.20261023.1, exact pins |
| `wrangler.json` | compatibility_date 2026-10-01, flags `["nodejs_compat"]`, envs `local`, `deepify`, `staging`, `production`; every env declares its own DO, container, D1, R2, vars because wrangler does not inherit bindings |
| `src/index.ts`, `src/gate.ts` | Worker -> Durable Object -> container on :8000; outbound handlers `d1.champdf.internal` and `r2.champdf.internal`; fail-closed access gate |
| `migrations/0001_champdf_init.sql` | generated from the Python schemas by `scripts/gen-d1-migration.py` (CI fails on hand edits) |
| `scripts/check-config.mjs` | no shared D1/R2 between envs, ENVIRONMENT equals env name, gate on for every remote non-prod env, production image must be `<ref>@sha256:<digest>`, `--deployable` rejects TODO placeholders |
| `scripts/release-manifest.mjs` | git SHA (+dirty flag), Worker bundle sha256, wrangler version, lockfile sha256, compatibility date/flags, container digest, D1 migration file hashes, DO migration tags, bindings |
| `.github/workflows/cloudflare-containers.yml` | tsc, gate tests, overlay check, migration regeneration diff, per-env bundle, local D1 migration, manifest artifact. No secrets, no deploy |
| `DEPLOY.md` | local, Deepify (token gated), Cloudflare staging, production gate |

Real output:

- `check-config.mjs`: structure OK. `--deployable` correctly FAILS today: staging TODO placeholders, production TODO image. That is the intended gate.
- `wrangler deploy --dry-run --containers-rollout none` bundles `local`, `deepify`, `staging` (90.42 KiB, gzip 23.02 KiB, identical across envs). `production` is rejected by wrangler itself: "image ... does not appear to be a valid path to a Dockerfile, or a valid image registry path". So an unfilled production overlay cannot deploy.
- `wrangler d1 migrations apply champdf-local --local --env local`: 18 commands executed; 8 tables, both append-only triggers and the new unique index present.
- `proof/results/release-manifest.local.json`: sample manifest. Note `container_digest.kind` is `local-image-id` locally; a real promotion needs `registry-digest` from `wrangler containers push`.
- Gate unit tests: 4 pass. With the fail-closed branch deleted the test fails (1 of 4), restored it passes. The gate is armed.
- Beam: `worker/wrangler.jsonc` had one environment pointing at the production D1 id. Added `env.deepify` and `env.staging` with their own D1/R2/vars (bundle size identical to the default, 1538.61 KiB) and `scripts/check-env-overlays.mjs`. Proven by breaking it: pointing staging at the production D1 name fails the check, restored passes.

Environment honesty. Deepify (pinned wrangler/workerd, local persisted bindings, same image) is a runtime rehearsal. It does not prove managed D1/R2 latency, Access, cron, Queues, custom hostnames, certificates, Container placement or `max_instances` (documented as not enforced locally). Those need a real Cloudflare staging account.

Installed tooling note: the global `wrangler` is 4.125.0, Beam and this proof pin 4.152.0. Use `npx wrangler` from the lockfile, not the global.

## 2. Container proof (deliverable 2)

Image built from `backend/Dockerfile` unchanged. Harness: `proof/container_probe.py`, fixtures: `proof/gen_fixtures.py` (generated inside the image, no user files, throwaway signer certificate, no paid providers). Raw results: `proof/results/container-probe-arm64.json`.

Host caveat: Docker (OrbStack) on Apple silicon, so the measured image is arm64, limits set to `--cpus 4 --memory 12g` to match standard-4. Cloudflare runs linux/amd64 on its own hardware: sizes, memory and failure behaviour carry over, absolute latencies do not. Do not read these as Cloudflare benchmarks.

| Measure | Value |
|---|---|
| Image size, arm64 / amd64 (built by wrangler) | 3.22 GB / 3.53 GB (limit 20 GB disk on standard-4, 50 GB per account) |
| Build time, arm64, cold cache | 6 min 40 s |
| Cold start, `docker run` to /health 200 | 6.06 s (image already local, no pull). Via Worker + DO + emulated amd64: 8.5 s first request, 5.8 s after replacement |
| Idle memory | 258 MiB |
| Peak memory / CPU over all ops | 1303 MiB / 451% of 4 vCPU |

Operation latency (one run each, native arm64, 4 vCPU):

| Operation | Fixture | Status | Latency | Output check |
|---|---|---|---|---|
| Office to PDF (LibreOffice) | 120 paragraph docx | 200 | 2.80 s | `%PDF-1.7` |
| PDF to text | 10 page PDF | 200 | 0.99 s | JSON |
| OCR | 11.6 MB scanned PDF | 200 | 4.52 s | `%PDF-1.7` |
| PDF sign (PAdES, no TSA) | 10 page PDF | 200 | 0.81 s | `%PDF-1.7` |
| Signature verify | signed PDF / byte-flipped copy | 200 / 200 | 0.13 s / 0.03 s | `intact:true` / `intact:false` |
| Image background removal | 1024x1024 PNG, first call | 200 | 26.59 s | PNG |
| Image background removal | transparent PNG input, second call | 200 | 2.68 s | PNG |
| Video remove-logo | 720p 5 s | 200 | 9.32 s | MP4 |
| Video remove-logo | 1080p 30 s, 21.6 MB in, 32.2 MB out | 200 | 110.7 s | MP4 |
| Repeat request, warm | PDF to text x5 | 200 | 0.01 to 0.05 s | |
| 4 concurrent OCR | same scan | 4x200 | 2.4, 4.7, 7.0, 9.2 s, wall 9.18 s | serialised |

Failure and scale tests:

| Test | Result |
|---|---|
| `docker restart` (same writable layer) | API key still valid (200). Not what Cloudflare does, shown for contrast |
| Replace container (new disk) | same key now 401. Keys vanished |
| Kill container mid 1080p video request | client got `RemoteDisconnected` after 5 s. After replacement the key is 401 and `/api/jobs/*` is 404. There is no job table: every heavy op is a synchronous request, so "recover an interrupted job" has nothing to recover. The caller must retry |
| Two instances | key issued on A: 200 on A, 401 on B. Split brain by construction |
| Through Worker + DO, two named instances | `?instance=0` and `?instance=1` hit two distinct containers (verified by header and `docker ps`) |

Surprises found by running it, none visible from reading code:

1. The image CMD binds `::` only. Under OrbStack that was unreachable over IPv4 (`curl` 000, connection reset), and Cloudflare documents listening on 0.0.0.0. Fixed with `entrypoint` on the Container class, not by editing the Dockerfile.
2. A Container class with `outboundByHost` fails to start unless the Worker also exports `ContainerProxy` ("ctx.exports.ContainerProxy is undefined"). Fixed.
3. The rembg model is not in the image. The Dockerfile pre-download swallows failure (`|| echo`) and startup logs "U2Net model not cached". First remove-bg call costs 26.6 s and downloads ~176 MB, per new instance, because disk is ephemeral. Whisper, LaMa and Real-ESRGAN weights also download on first use (`caption_processor.py:46`, `upscale_processor.py:47`). Not exercised here, so their cold costs are unmeasured.
4. `wrangler deploy --dry-run` builds the container image unless `--containers-rollout none` is passed.
5. Without `SIGN_SEAL_P12_B64` or `SIGN_SEAL_P12_PATH`, Sign generates a self-signed seal into the data dir. On Containers that is a new sealing identity on every cold start. It must be a secret before any use.

Not measured, so not claimed: Whisper/captions, LaMa inpaint, upscaling, COEP-dependent WASM watermark in a browser (PR #104's known failure), uploads over the zone request cap (100 MB on Free and Pro per the Workers limits page), direct-to-R2 signed uploads, GPU paths, how a 110 s synchronous response behaves through real Cloudflare, real amd64 latency, CPU contention with Cloudflare's actual vCPU share.

## 3. Durable-state inventory (deliverable 2, inventory)

| State | Where it lives now | Durable? | On Containers |
|---|---|---|---|
| API keys (hash, scopes, quota, clerk_user_id, disabled_at) | SQLite `api_keys`, `api_v1.py:76` | Yes | Lost on replacement (proved) |
| Per-call usage and request log | `request_log` + `api_keys.requests_used`, written by `_record_request` on every v1 call | Yes (quota, billing) | Lost |
| Sign documents, recipients (token, OTP, session hashes), templates flags | SQLite `sign_documents`, `sign_recipients`, `sign_templates` | Yes (legal) | Lost |
| Sign audit chain | `sign_audit_events`, hash chained, append-only triggers | Yes (legal evidence) | Lost |
| Webhook dedupe, Sign rate hits | `sign_webhook_seen`, `sign_rate_hits` | Yes / soft | Lost |
| Sealed, draft, working PDFs | `Storage`: `LocalStorage` under the data dir by default, `S3Storage` when `SIGN_STORAGE_BUCKET` is set (R2 capable, `storage.py:107`) | Yes | Lost unless S3/R2 backend is configured |
| Seal certificate and password | env `SIGN_SEAL_P12_*`, else generated into data dir | Yes | Regenerated per cold start unless env set |
| Uploaded inputs and outputs of the PDF, image, video tools | `tempfile` dirs, deleted by background tasks | No | Fine |
| Per-key burst limiter, download buckets, per-document asyncio locks | process memory (`api_v1.py:290`, `main.py:503`, `sign/service.py:70`) | No | Per instance: N instances give N times the burst budget and no cross-instance locking |
| Model weights (u2net, whisper, LaMa, ESRGAN) | downloaded to container disk on first use | No | Re-downloaded per instance |
| Clerk, Resend, MaxMind | external services | n/a | Unchanged |

## 4. Smallest durable storage candidate (deliverable 3)

Boundary: D1 for metadata, R2 for bytes, both reached from the container through Worker outbound handlers (`outboundByHost`), so no Cloudflare SDK and no storage credentials inside the container. Proved from inside a running container: one batched D1 write plus an R2 PUT returned `{"d1_rows":[{"n":1}],"r2_put":204}`; after the container was removed and replaced, the local-disk marker file was gone and a read returned D1 `n=1` and the R2 object `%PDF-1.7 synthetic`. (`proof/d1_from_container.py`, local workerd and miniflare, not managed D1.)

Rejected: copying or syncing an active SQLite file to R2 (single writer, multi-instance divergence, loss window), a Docker volume on Deepify (not Cloudflare), a rewrite of Python tools to TypeScript.

Affected code, counted from the tree:

| Place | Sites | Change |
|---|---|---|
| `backend/api_v1.py` | 7 `sqlite3.connect` sites: `init_db`, `create_key`, `get_active_key_for_clerk_user`, `get_key_by_hash`, `revoke_key`, `list_keys`, `_record_request` | Single statements. Mechanical swap to an HTTP D1 adapter. No cross-statement transaction needed |
| `backend/sign/store.py` | 23 `connect()` call sites, 8 with `immediate=True`, including `append_event` (chain head) | Needs redesign, see risks |
| `backend/sign/service.py` | 16 `store.connect` blocks, 15 `immediate=True` | Each is read-modify-write under a write lock |
| `backend/sign/storage.py` | `S3Storage` exists and takes an R2 endpoint | Zero code if R2 S3 tokens are injected as secrets. Or a ~40 line `Storage` class over `r2.champdf.internal` and no credentials in the container |
| `backend/sign/seal.py` | seal loading | Set `SIGN_SEAL_P12_B64` as a Worker secret passed through `envVars` |

Transaction risks, each with a test result:

| Risk | Result |
|---|---|
| D1 rejects `BEGIN IMMEDIATE` | Proved: "To execute a transaction, please use the state.storage.transaction() ... APIs". The Sign `connect(immediate=True)` pattern cannot be ported one to one |
| `DB.batch()` atomicity | Proved: a failing second statement rolls back the first (0 rows left) |
| Append-only triggers | Proved: UPDATE and DELETE on `sign_audit_events` both abort in D1 |
| Audit chain race | Proved: without a guard two events with the same `prev_hash` are both accepted (chain forks, 2 children of one head). With `uq_sign_audit_chain UNIQUE(document_id, prev_hash)` the second is rejected, so the adapter must re-read the head and retry. The index is the only schema change versus SQLite |
| 15 other read-modify-write blocks | Not yet rewritten. Pattern: `UPDATE ... WHERE status = :expected`, check `meta.changes`, put the state change and its audit event in one batch. Needs a per-block review and a concurrent-signing test suite. Not estimated because I have not enumerated the blocks one by one |
| In-process `asyncio.Lock` per document | Meaningless across instances. Correctness must come from the guarded statements above |
| Latency | Each former local transaction becomes one or two network round trips. `_record_request` runs per API call and should be deferred or batched. Unmeasured on managed D1 |

Command evidence: `proof/d1-selftest.mjs` (exit 0, 6 of 6 checks, includes a negative control that the race is real), `proof/results/d1-selftest.json`.

Alternative considered: a SQLite Durable Object per document gives true `transactionSync`, but moving those 23 write-locked transaction bodies behind a DO means rewriting Sign's business logic in TypeScript. That is the big port the brief rules out, so it is option B territory below, not the default.

## 5. Still unproven (missing capabilities)

1. Anything on real Cloudflare: managed D1/R2 latency, Containers placement and cold start with image pull, Access JWT verification against a real team domain (only the negative paths are unit tested), cron, Queue delivery, custom hostnames, certificates.
2. Real amd64 performance. Only that it builds and starts (emulated).
3. Large uploads: the zone body cap (100 MB Free and Pro, 200 MB Business per the Workers limits page) versus the app's own 100 MB cap, and direct-to-R2 signed uploads with completion validation. Not built.
4. Long synchronous jobs (110 s video here) through the Worker and DO path. A job table in D1 plus output in R2 is the likely shape and is new work, not a config change.
5. The three existing signature UI defects and the device-versus-account persistence choice (Spec section 4.2): separate integration step, untouched.
6. Hosted MCP: not touched, not dropped.
7. COEP-dependent WASM watermark: a frontend/browser matter owned by the PR #104 line.
8. Sign port: the 15 guarded-update rewrites and the concurrent-signing suite.

## 6. Decision cards

Decision 1. ChamPDF cutover scope. Reply A, B, C. Silence = C.

- A (recommended): Phase 1 only. Move the stateless tools and API keys to Containers + D1 + R2 (7 mechanical sites, keys survive replacement, proven pattern). Sign stays on its current Railway volume, not on Deepify, until its guarded-batch port passes a concurrent-signing suite. Cost: two homes for a while. Next cards: key adapter, direct-to-R2 upload path, real staging proof.
- B: Port Sign first, cut everything over together. Rewrite 15 transaction blocks as guarded D1 batches plus the chain retry before any cutover. One home at the end, longest path, highest risk on legal evidence.
- C: Hold. Stay on the PR #104 hybrid (frontend on Workers, API on Deepify) and its known nginx 1 MB and COEP defects.

Decision 2. Entitlement for a real Cloudflare preview (no purchase made). Needed on the account that will own ChamPDF staging: Workers Paid plan ($5 per month base; Containers are not offered on Free, usage is metered per vCPU-second, GiB-second and disk beyond the included amounts), plus D1 and R2 enabled, plus a Cloudflare Access application on the staging hostname. Which account owns it is Deep's call: the prior Beam handoff says champbeam.com is not visible in his current account. Reply A approve on named account, C hold. Silence = hold.

## 7. Reproduce

```
cd cloudflare/containers && npm ci
npm test && npm run check:config && node proof/d1-selftest.mjs
docker build -t champdf-backend-proof ../../backend
docker run --rm -v $PWD/proof:/fx champdf-backend-proof python /fx/gen_fixtures.py   # then point FX at proof/out
python3 proof/container_probe.py champdf-backend-proof <fixtures>/out result.json
npx wrangler dev --env local          # Worker + DO + container, builds linux/amd64
docker exec -i <container> python - write abc < proof/d1_from_container.py
```
