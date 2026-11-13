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
