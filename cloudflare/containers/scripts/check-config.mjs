// Release gate: every env must declare its own bindings, staging/prod must have no
// TODO_ placeholders, no env may share a D1 database or R2 bucket, production must
// pin its image by digest, and Access gating must be on for every non-prod remote env.
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));
const errs = [];
const gated = ["staging", "production"]; // envs that may deploy to Cloudflare
const seen = { d1: new Map(), r2: new Map() };
for (const [name, e] of Object.entries(cfg.env)) {
  const d1 = e.d1_databases?.[0], r2 = e.r2_buckets?.[0];
  if (!d1 || !r2 || !e.containers?.length || !e.durable_objects) errs.push(`${name}: missing d1/r2/containers/durable_objects (bindings are not inherited)`);
  for (const [kind, key, m] of [["d1", d1?.database_name, seen.d1], ["r2", r2?.bucket_name, seen.r2]]) {
    if (key && m.has(key)) errs.push(`${name}: shares ${kind} '${key}' with ${m.get(key)}`);
    m.set(key, name);
  }
  if (e.vars?.ENVIRONMENT !== name) errs.push(`${name}: vars.ENVIRONMENT must equal the env name`);
  if (gated.includes(name) && /TODO_/.test(JSON.stringify(e))) errs.push(`${name}: unresolved TODO_ placeholder (fill the overlay before deploying)`);
  if (name === "production" && !/@sha256:[0-9a-f]{64}$/.test(e.containers?.[0]?.image ?? "")) errs.push("production: container image must be pinned as <ref>@sha256:<digest>");
  if (name !== "production" && name !== "local" && e.vars?.ACCESS_MODE === "none") errs.push(`${name}: ACCESS_MODE none is only allowed in local/production`);
}
if (JSON.stringify(cfg.compatibility_flags) !== '["nodejs_compat"]' || !/^\d{4}-\d\d-\d\d$/.test(cfg.compatibility_date)) errs.push("compatibility date/flags not pinned");
const full = process.argv.includes("--deployable"); // staging/prod deploy gate
const out = full ? errs : errs.filter((x) => !/^(staging|production): (unresolved TODO_|container image must be pinned)/.test(x));
console.log(out.length ? out.map((x) => "FAIL " + x).join("\n") : `OK (${full ? "deployable" : "structure"})`);
process.exit(out.length ? 1 : 0);
