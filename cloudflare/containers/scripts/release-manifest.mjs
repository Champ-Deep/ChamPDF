// Release manifest: the facts a promotion must be able to reproduce.
//   node scripts/release-manifest.mjs <env> [--image <local-or-registry-ref>]
// Requires `npm run bundle -- <env>` first (reads dist/<env>/index.js). Writes dist/<env>/release-manifest.json.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const env = process.argv[2];
if (!env) { console.error("usage: release-manifest.mjs <env> [--image ref]"); process.exit(2); }
const imgRef = process.argv.includes("--image") ? process.argv[process.argv.indexOf("--image") + 1] : null;
const root = new URL("..", import.meta.url).pathname;
const cfg = JSON.parse(readFileSync(root + "wrangler.json", "utf8"));
const e = cfg.env[env];
if (!e) { console.error(`unknown env ${env}`); process.exit(2); }

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const bundle = readFileSync(`${root}dist/${env}/index.js`);

let digest = null;
if (imgRef) {
  // A registry ref carries its digest; a local image only has an image id (the config digest), labelled as such.
  const m = imgRef.match(/@(sha256:[0-9a-f]{64})$/);
  digest = m ? { kind: "registry-digest", value: m[1] }
    : { kind: "local-image-id", value: execFileSync("docker", ["image", "inspect", imgRef, "--format", "{{.Id}}"], { encoding: "utf8" }).trim() };
}

const manifest = {
  env,
  git_sha: git("rev-parse", "HEAD"),
  git_dirty: git("status", "--porcelain", "--", ".", "../../backend").length > 0,
  worker_bundle_sha256: sha256(bundle),
  wrangler_version: JSON.parse(readFileSync(root + "node_modules/wrangler/package.json", "utf8")).version,
  lockfile_sha256: sha256(readFileSync(root + "package-lock.json")),
  compatibility_date: cfg.compatibility_date,
  compatibility_flags: cfg.compatibility_flags,
  container_image: e.containers[0].image,
  container_instance_type: e.containers[0].instance_type,
  container_digest: digest,
  d1_migrations: readdirSync(root + "migrations").filter((f) => f.endsWith(".sql")).sort().map((f) => ({ file: f, sha256: sha256(readFileSync(root + "migrations/" + f)) })),
  do_migrations: cfg.migrations.map((m) => m.tag),
  bindings: { d1: e.d1_databases.map((d) => d.database_name), r2: e.r2_buckets.map((r) => r.bucket_name) },
  generated_at: new Date().toISOString(),
};
writeFileSync(`${root}dist/${env}/release-manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
