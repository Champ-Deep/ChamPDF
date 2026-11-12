# ChamPDF Phase 1 cutover plan: stateless tools + API keys on Containers + D1 + R2 (local proof)

Planner card t_47dbdc45. Ruling: Decision 1 = A (Deep via main lane, 2026-11-06). Base: `ops/cf-container-proof` @ 11ad424 (PR #105, REPORT.md in this folder). Integration branch: `cf/phase1` (this commit). Everything here runs and verifies locally. Nothing touches a real Cloudflare account until Decision 2 (card t_dd6c9751) is ruled A.

## 1. Goal

After Phase 1, through the local Worker (`npx wrangler dev --env local`):

1. Every stateless tool (office to PDF, OCR, PDF ops, image, video, `/api/sign-pdf`, `/api/verify-signature`, `/api/v1/pdf/sign`, `/api/v1/pdf/verify`) runs in the container and keeps no durable state on container disk.
2. API keys and usage live in D1. A key issued on instance 0 is valid on instance 1 and survives container replacement.
3. Sign (`/api/sign/*`) never reaches the container. The Worker forwards it to `SIGN_ORIGIN` (the current Railway backend), or returns 503 when that is unset.
4. `npm run check:config` passes and `npm run check:config -- --deployable` still FAILS.

## 2. Non-goals (Phase 1 does not do these)

- Sign storage on D1. `backend/sign/store.py` (8 `immediate=True` sites) and `backend/sign/service.py` (15) are not edited. That port is card P2-SIGN, gated.
- Anything remote: no `wrangler deploy`, no `--remote`, no `wrangler containers push`, no account login, no purchase.
- Async job table for long video. Contingent on the staging result (section 7), not built now.
- Direct-to-R2 uploads. Held behind its own decision (card P1-R2, section 6).
- Hosted MCP (`mcp/`), COEP WASM watermark (PR #104 line), Sign UI defects.
- ChampBeam. Beam PR #43 (`ops/cf-env-overlays`) is closed unmerged and Beam's `worker/wrangler.jsonc` has no ChamPDF reference, so no Phase 1 card edits ChampBeam. Beam open PRs #60, #64, #65 all touch that file; leave it alone.

## 3. What breaks if done naively (holes found while probing)

| # | Hole | Evidence | Ruling in this plan |
|---|---|---|---|
| H1 | SSRF into the storage boundary. `/api/download-from-url` accepts any `http://` URL (`backend/main.py:646-649`), and the outbound handlers intercept by host (`src/index.ts`, `outboundByHost`). A user URL `http://d1.champdf.internal/` or `http://r2.champdf.internal/<key>` reaches D1/R2 from inside the container | `main.py:633-662`, `src/index.ts` d1/r2 handlers take any SQL and any key | Handlers require header `x-champdf-internal: <CHAMPDF_INTERNAL_TOKEN>`; D1 is POST only and runs named statements only (section 5); R2 is restricted to the `tmp/` prefix. Negative test required |
| H2 | The d1 handler executes arbitrary SQL from the request body | `src/index.ts` comment "proof-grade" | Replaced by the named statement registry `src/statements.json` |
| H3 | Prefix footgun: `/api/sign-pdf` starts with `/api/sign` | `main.py:919`, `sign/router.py:54` prefix `/api/sign` | Sign match is `path === "/api/sign" or path.startsWith("/api/sign/")`. Test both `/api/sign/status` (to Sign origin) and `/api/sign-pdf` (to container) |
| H4 | Sign inside the container would write to `/tmp` (container sets `CHAMPDF_DB_PATH=/tmp/champdf/champdf.db`) and lose legal records | `src/index.ts` envVars, REPORT section 3 | Worker never sends `/api/sign/*` to the DO. No `main.py` change |
| H5 | Store outage reported as an invalid key. `require_api_key` turns "no row" into 401 (`api_v1.py:327-329`); a D1 network error must not look like that | `api_v1.py:310-358` | D1 errors raise `HTTPException(503, {"code":"key_store_unavailable"})`, never 401 |
| H6 | First remove-bg per instance downloads ~176 MB (26.6 s) because the Dockerfile pre-download swallows failure | `backend/Dockerfile:30-34` (`|| echo`) | Card P1-3 bakes u2net and fails the build on error |
| H7 | Burst limiter and download buckets are per process | `api_v1.py:290`, `main.py:503` | Accepted for Phase 1: N instances give N x 30 req/min burst. Documented, not fixed |
| H8 | Existing keys live on the Railway volume SQLite | REPORT section 3 | Card P1-4: read-only export to SQL, import into D1, ids preserved. `request_log` is not migrated; it stays on the Railway volume as the archive |
| H9 | The production overlay has no `SIGN_ORIGIN` | `wrangler.json` env.production | Production overlay is not edited in Phase 1 (do-not-touch). Worker fails closed (503) for Sign when unset. Staging gets `TODO_SIGN_ORIGIN`, which keeps `--deployable` failing |
| H10 | The proof branch is behind `v3-test-ready` (now e6efdd6; `main.py` +64 lines, `api_v1.py` unchanged) | `git diff --stat` | Phase 1 cards do not edit `main.py`. The final `cf/phase1` PR into `v3-test-ready` resolves; no card merges it |

## 4. Paths and ownership

Hotspot: `cloudflare/containers/src/index.ts` and `cloudflare/containers/wrangler.json`. Only P1-1 edits them in Phase 1 (P1-R2 later, after P1-1). Every other card must not.

| Card | Lane | Edits | Branch (cut from) | PR target |
|---|---|---|---|---|
| P1-1 Worker hardening + Sign split | default | `cloudflare/containers/src/index.ts`, new `src/statements.json`, new `test/handlers.test.ts`, `wrangler.json` (env.local, env.deepify, env.staging vars only), `.dev.vars.example` | `cf/p1-worker` (`origin/cf/phase1`) | `cf/phase1` |
| P1-2 Key store D1 adapter | default | `backend/api_v1.py`, new `backend/tests/test_api_v1_keys_d1.py` | `cf/p1-keys-d1` (`origin/cf/p1-worker`) | `cf/p1-worker` |
| P1-3 Model weights | worker | `backend/Dockerfile` lines 30-34 only, new `proof/model_cold.py`, `proof/results/model-cold-*.json` | `cf/p1-weights` (`origin/cf/phase1`) | `cf/phase1` |
| P1-4 Key export/import + runbook | worker | new `scripts/export-keys.py`, new `proof/keys_import_check.sh`, `DEPLOY.md` (new section only) | `cf/p1-keys-import` (`origin/cf/p1-keys-d1`) | `cf/p1-keys-d1` |
| P1-5 Local end-to-end proof | worker | new `proof/phase1_e2e.sh`, `proof/results/phase1-e2e.json`, `REPORT.md` (append a Phase 1 section) | `cf/p1-e2e` (`origin/cf/p1-keys-import`, then merge `origin/cf/p1-weights`) | `cf/p1-keys-import` |
| P1-6 Real staging proof | default | `wrangler.json` env.staging ids only | gated on Decision 2 | n/a until ruled |
| P1-R2 Direct-to-R2 uploads | default | held | held | held |
| P2-SIGN Guarded D1 batch port | default | held, later phase | held | held |

All `cloudflare/containers/...` paths are relative to that folder unless they start with `backend/`. Lanes make their own worktree: `git -C ~/repos/champdf fetch origin && git -C ~/repos/champdf worktree add ~/repos/champdf/.worktrees/<card-id> -b <branch> <cut-from>`. The main checkout `~/repos/champdf` is on another branch with uncommitted work: never edit it. Commit on your branch, push it, open a draft PR into the target. Never merge.

## 5. Data contract: container to D1 (decided here, both P1-1 and P1-2 implement it)

Request (from the container, Python stdlib `urllib`, timeout 10 s):

```
POST http://d1.champdf.internal/
content-type: application/json
x-champdf-internal: <CHAMPDF_INTERNAL_TOKEN>

{"batch": [{"q": "<statement name>", "params": [ ... ]}, ...]}
```

The Worker maps each `q` to SQL from `src/statements.json`, binds `params`, runs all of them in one `env.DB.batch()` (atomic), and returns the D1 batch result as is: `200` with `[{"results": [...], "success": true, "meta": {"changes": n, "last_row_id": n, ...}}, ...]`, one entry per statement, in order.

Errors: `401` missing or wrong token (constant-time compare, reuse `safeEqual` from `src/gate.ts`), `405` any method but POST, `413` body over 65536 bytes, `400` unknown `q`, wrong param count, more than 8 statements, or a non-JSON body, `503` `CHAMPDF_INTERNAL_TOKEN` not configured. No other path on that host.

`src/statements.json` (SQL is the exact text from `backend/api_v1.py`, whitespace collapsed):

| q | params | SQL | Python caller |
|---|---|---|---|
| `keys.health` | 0 | `SELECT 1 FROM api_keys LIMIT 1` | `init_db` (`api_v1.py:71`) in d1 mode: probe only, schema is owned by `migrations/0001_champdf_init.sql` |
| `keys.insert` | 7 | `INSERT INTO api_keys (key_hash, label, monthly_quota, month_bucket, requests_used, created_at, clerk_user_id, scopes) VALUES (?, ?, ?, ?, 0, ?, ?, ?)` | `create_key` (`:188`), id from `meta.last_row_id` |
| `keys.active_for_clerk` | 1 | `SELECT * FROM api_keys WHERE clerk_user_id = ? AND disabled_at IS NULL ORDER BY id DESC LIMIT 1` | `get_active_key_for_clerk_user` (`:213`) |
| `keys.by_hash` | 1 | `SELECT * FROM api_keys WHERE key_hash = ? LIMIT 1` | `get_key_by_hash` (`:227`) |
| `keys.revoke` | 2 | `UPDATE api_keys SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL` | `revoke_key` (`:238`), result from `meta.changes > 0` |
| `keys.list` | 0 | `SELECT id, label, monthly_quota, month_bucket, requests_used, created_at, last_used_at, disabled_at, scopes FROM api_keys ORDER BY id DESC` | `list_keys` (`:248`) |
| `log.insert` | 5 | `INSERT INTO request_log (key_id, ts, endpoint, status, latency_ms) VALUES (?, ?, ?, ?, ?)` | `_record_request` (`:265`), statement 1 of 2 in ONE batch |
| `keys.bump_usage` | 4 | `UPDATE api_keys SET requests_used = CASE WHEN month_bucket = ? THEN requests_used + 1 ELSE 1 END, month_bucket = ?, last_used_at = ? WHERE id = ?` | `_record_request`, statement 2 of 2 |

Mode switch in `backend/api_v1.py`: env `CHAMPDF_KEYS_BACKEND`, `sqlite` (default, current behaviour byte for byte, what Railway keeps running) or `d1`. In d1 mode the container also needs `CHAMPDF_INTERNAL_TOKEN`; `CHAMPDF_D1_URL` defaults to `http://d1.champdf.internal/`. The Worker's Container class sets `CHAMPDF_KEYS_BACKEND=d1` and passes `CHAMPDF_INTERNAL_TOKEN` from the Worker secret of the same name into `envVars`.

R2 handler (P1-1): same token header, keys must start with `tmp/`, PUT capped at 100 MiB, GET and PUT only. Phase 1 Python code does not call it yet; it stays for P1-R2.

Sign split (P1-1): in the Worker `fetch`, after `gate()`: if `path === "/api/sign" || path.startsWith("/api/sign/")`, forward method, headers, body and query to `env.SIGN_ORIGIN + path` with `redirect: "manual"`, set response header `x-champdf-route: sign-origin`, and never call the DO. If `SIGN_ORIGIN` is empty, unset or starts with `TODO_`, return `503 {"detail":"sign origin not configured"}`. Local value: `http://127.0.0.1:8001` (a plain `docker run` of the same backend image with a named volume plays Railway).

Secrets: `CHAMPDF_INTERNAL_TOKEN` and `CHAMPDF_ADMIN_TOKEN` come from `cloudflare/containers/.dev.vars` (gitignored; create with `openssl rand -hex 24`). Never commit, print or log a value. Commit only `.dev.vars.example` with empty values.

## 6. Open decision held on its own card (P1-R2)

The app caps video at 100 MB (`backend/config.py:34-35`), PDF and office at 50 MB (`api_v1.py:1073-1074`), images at 10 MB (`config.py:36`). The zone request cap is 100 MB on Free and Pro. So direct-to-R2 only matters for the 95 to 100 MB video band (multipart overhead) unless the app caps rise. The REPORT listed it as a next card; the planner recommends holding it until P1-6 measures what the real edge does with a 99 MB upload. Card P1-R2 is created blocked with that decision (A hold until P1-6, B build now, C drop). Phase 1 does not depend on it.

## 7. Unverified until real staging (Decision 2), owned by P1-6

Local proof cannot close these. P1-6 closes each with a number. Thresholds are PROPOSED until Deep rules on them.

| Item | How P1-6 measures it | Ship | Kill / contingency |
|---|---|---|---|
| Managed D1 latency | p50/p95 of `/api/v1/whoami` minus a `/health` baseline, 100 calls | p95 added <= 50 ms | > 150 ms: card to defer or batch `_record_request` |
| Managed R2 latency | PUT and GET of a 10 MB `tmp/` object via the outbound handler, 20 runs | p95 <= 1 s | > 3 s: revisit before P1-R2 |
| Access JWT | real team domain: valid token 200, no token 403, wrong aud 403 | all three | any mismatch blocks cutover |
| Cron | confirm `wrangler.json` has no `triggers` and Phase 1 needs none (Sign sweeps stay on Railway) | recorded none | a found scheduled job gets its own card |
| Certificates | TLS on the staging hostname valid, chain and expiry recorded | valid | invalid blocks |
| Containers placement | colo from `cf-ray` and instance header over 50 calls, cold start with image pull | cold start <= 60 s | > 120 s: raise `sleepAfter` or min instances card |
| amd64 latency | `proof/container_probe.py` ops through staging vs the arm64 table in REPORT section 2 | each op <= 2x arm64 | > 3x on any op: instance type card |
| Whisper, LaMa, upscale | first and second call per op on a fresh instance (P1-3 measures locally first) | recorded | first call > 60 s: bake weights card |
| COEP WASM | owned by the PR #104 frontend line, not P1-6 | n/a | n/a |
| Uploads over 100 MB, direct-to-R2 | 99 MB and 101 MB video through the edge: record status and body | app-level JSON error or 200, never an opaque edge page | opaque edge error: unblock P1-R2 as B |
| 110 s synchronous video | 1080p 30 s fixture through the real Worker and DO, 3 runs | 3 x 200 | any 5xx or timeout: async job card (D1 job row + R2 output) |

## 8. Card graph

```
P1-1 Worker hardening -> P1-2 Keys D1 adapter -> P1-4 Key export/import -+
P1-3 Model weights ------------------------------------------------------+-> P1-5 Local e2e -+
Decision 2 (t_dd6c9751) ------------------------------------------------------------------------+-> P1-6 Staging -> P2-SIGN (gated)
P1-1 -> P1-R2 (blocked on its decision)
```

## 9. Standing checks every Phase 1 card runs before review

```
cd cloudflare/containers && npm ci
npm run typecheck && npm test
npm run check:config                      # must print OK (structure), exit 0
npm run check:config -- --deployable      # must exit 1 (gate stays failing)
git diff --name-only origin/cf/phase1... | grep -E '^backend/sign/|railway|Dockerfile.railway|nginx' && echo VIOLATION || echo clean
```

## 10. Do not touch

`backend/sign/**`, `railway.toml`, `backend/Dockerfile.railway`, `docker-compose.railway.yml`, `nginx*.conf*`, `scripts/check-config.mjs` (the gate logic), `env.production` in `wrangler.json`, `.env` and any credential file, ChampBeam. No remote Cloudflare command of any kind.
