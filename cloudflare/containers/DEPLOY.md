# ChamPDF Containers: deploy recipe (staging only)

Scope: this is a rehearsal and staging recipe. Nothing here deploys production, changes DNS, reads secrets or merges. Every remote step needs scoped approval from Deep first.

## Topology

```
local (wrangler dev + Docker)
  -> CI (.github/workflows/cloudflare-containers.yml: tsc, overlay check, bundle per env, local D1 migration, manifest)
  -> Deepify rehearsal (same Worker bundle + same image on pinned workerd; isolated persisted bindings; NOT the Cloudflare control plane)
  -> Cloudflare staging (real D1, R2, Access, cron, Containers)           <- needs the entitlement on the decision card
  -> gated production (image pinned by digest, migrations applied by a human)
```

ChamPDF production must not depend on Deepify. The `production` overlay has no Deepify reference, and `scripts/check-config.mjs --deployable` fails if its image is not `<ref>@sha256:<digest>`.

## 1. Local (already run in this proof)

```
cd cloudflare/containers && npm ci            # wrangler 4.152.0, @cloudflare/containers 0.3.7, jose 6.2.13 pinned
npm run check:config                          # overlay isolation
npx wrangler d1 migrations apply champdf-local --local --env local
node proof/d1-selftest.mjs                    # D1 semantics the Sign store depends on
npx wrangler dev --env local                  # builds the backend image for linux/amd64 via Docker, serves on :8787
```

## 2. Deepify rehearsal (access-gated)

Prerequisites on the Deepify host: Docker, Node 24, repo checkout at the tested SHA. No server changes are made by this repo.

```
npm ci
printf 'STAGING_TOKEN=%s\n' "$(openssl rand -hex 24)" > .dev.vars     # file is gitignored; never commit it
npx wrangler d1 migrations apply champdf-deepify --local --env deepify --persist-to /srv/champdf-deepify/state
npx wrangler dev --env deepify --ip 127.0.0.1 --port 8787 --persist-to /srv/champdf-deepify/state
```

Gate: the Worker returns 403 unless `x-staging-token` equals `STAGING_TOKEN`, and 503 if `ACCESS_MODE` is `none` in a deepify or staging env (fails closed). Bind to loopback and publish only through Deepify's existing authenticated reverse proxy. `persist-to` gives isolated persisted D1/R2 state that is separate from the Cloudflare ones.

What Deepify proves: the Worker bundle and the image run together on workerd, outbound handlers reach D1/R2 bindings. What it does not prove: managed D1/R2 latency, Access, cron delivery, custom hostnames, certificates, Container placement or limits (`max_instances` is not enforced locally). Those need step 3.

## 3. Cloudflare staging (blocked on entitlement and approval)

1. Entitlement: Workers Paid plan with Containers enabled on the target account (see decision card in REPORT.md). Nothing is bought here.
2. Create `champdf-staging` (D1) and `champdf-files-staging` (R2) and an Access application for the staging hostname; put the real IDs into `env.staging` in a reviewed commit (the TODO_ placeholders fail `check-config.mjs --deployable`).
3. Build once, record the digest, promote that artifact:
   ```
   docker buildx build --platform linux/amd64 -t champdf-api:$SHA -f ../../backend/Dockerfile ../../backend
   npx wrangler containers push champdf-api:$SHA --env staging
   npm run bundle -- staging && node scripts/release-manifest.mjs staging --image <registry-ref>@sha256:<digest>
   ```
4. `npx wrangler d1 migrations apply champdf-staging --remote --env staging` is a human step, never run by CI on push.
5. `npx wrangler deploy --env staging`, then test through the Access-gated hostname with non-production Clerk identities and masked fixtures. Staging transport records only.

## 4. Production

Not covered. Gate: staging evidence for every item in REPORT.md section "Still unproven", plus Deep's explicit approval. The production overlay must be filled with the digest-pinned image from the staging manifest, not rebuilt.

## 5. Phase 1 key cutover (blocked on Decision 2 and Deep's approval)

Docs only. Every remote step below is a human step, not run by agents. Agents may run only the local proof: `bash proof/keys_import_check.sh`.

Order: freeze, copy, export, import, parity, cutover. The copy does not carry usage counters (`requests_used`, `last_used_at`) or any revoke done on Railway after the copy. Re-apply any such revoke on D1 before cutover. `execute --file` size limit on a large key set is untested; split keys.sql if the import is refused.

1. Freeze key issuance on Railway first, so no key is created after the copy. Human step, not run by agents.
   - Admin issuance: unset `CHAMPDF_ADMIN_TOKEN` on the backend service (`backend/api_v1.py` returns "Admin endpoints disabled" when it is unset).
   - Self-serve issuance: unset `CLERK_ISSUER` and `CLERK_JWKS_URL`. There is no narrower switch: `require_clerk_user` gates on the same `clerk_configured()`.
   - Side effect: with Clerk unconfigured, `backend/sign/auth.py:110-115` returns 503 "Sign-in is not configured" for every non-admin Sign call. Sign stays on Railway in Phase 1 (`src/index.ts:23`), so Sign sign-in is down for the whole freeze window. The human decides whether that window is acceptable. Existing API keys keep working.
   - Redeploy and confirm `POST /api/v1/admin/keys` and the self-serve route both refuse.
2. Copy the Railway volume DB (`CHAMPDF_DB_PATH`, default `/app/data/champdf.db`) to a local file, read only. Human step, not run by agents. Treat the copy as secret (it holds key hashes). Do not edit the original.
3. Export: `python3 scripts/export-keys.py --db <copy> --out keys.sql`. Expect `exported N keys` on stderr. `request_log` is not exported and stays on the Railway volume as the archive.
4. Import into remote D1 (human step, not run by agents): `npx wrangler d1 migrations apply <db> --remote --env <env>` then `npx wrangler d1 execute <db> --remote --env <env> --file keys.sql`.
5. Verify parity (human step, not run by agents). Run the same query against the copy and remote D1 and compare:
   `SELECT id, key_hash, label, monthly_quota, disabled_at, clerk_user_id, scopes FROM api_keys ORDER BY id`
   (remote: `npx wrangler d1 execute <db> --remote --env <env> --json --command "<query>"`). Counts and rows must be equal.
6. Cut over (human step, not run by agents):
   - Frontend: set `BACKEND_URL` (read by `nginx.conf:31-38` `proxy_pass ${BACKEND_URL}` and the envsubst filter in `Dockerfile.frontend:59-72`) to the new API origin. The brief called this `BACKEND_ORIGIN`; that name does not exist in the repo.
   - Hosted MCP service: set `CHAMPDF_API_BASE_URL` to the new public https origin. The `railway.toml` comment shows the private `http://champdf-backend.railway.internal`, which the Cloudflare API cannot be reached on. Check its `CHAMPDF_API_KEY` is one of the imported keys and is not disabled.
   - `CHAMPDF_KEYS_BACKEND=d1` is already set by the Worker (`src/index.ts:42`). Confirm, do not set it again.
   - Restore `CLERK_ISSUER` and `CLERK_JWKS_URL` on Railway now. Sign keeps running there after cutover and needs them. Issuance on the new API is then governed by its own config.
7. Rollback: point `BACKEND_URL` and `CHAMPDF_API_BASE_URL` back at Railway and restore `CHAMPDF_ADMIN_TOKEN` and the CLERK vars unset in step 1. The Railway SQLite is untouched, so keys issued before the freeze still work. Keys issued on D1 after cutover are not copied back.
