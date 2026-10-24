import test from "node:test";
import assert from "node:assert/strict";
import { gate } from "../src/gate.ts";

const req = (h: Record<string, string> = {}) => new Request("https://x.test/api", { headers: h });
const base = { ENVIRONMENT: "deepify", ACCESS_MODE: "shared-token", STAGING_TOKEN: "s3cret" };

test("deepify/staging with ACCESS_MODE none fails closed (503)", async () => {
  for (const ENVIRONMENT of ["deepify", "staging"]) assert.equal((await gate(req(), { ENVIRONMENT, ACCESS_MODE: "none" }))?.status, 503);
});
test("local and production may run with no gate", async () => {
  for (const ENVIRONMENT of ["local", "production"]) assert.equal(await gate(req(), { ENVIRONMENT, ACCESS_MODE: "none" }), null);
});
test("shared-token: right token passes, wrong/missing/unset all 403", async () => {
  assert.equal(await gate(req({ "x-staging-token": "s3cret" }), base), null);
  assert.equal((await gate(req({ "x-staging-token": "s3cret!" }), base))?.status, 403);
  assert.equal((await gate(req(), base))?.status, 403);
  assert.equal((await gate(req({ "x-staging-token": "" }), { ...base, STAGING_TOKEN: undefined }))?.status, 403);
});
test("cf-access: no JWT, unset team, or TODO audience is 403 before any network call", async () => {
  const e = { ENVIRONMENT: "staging", ACCESS_MODE: "cf-access", ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" };
  assert.equal((await gate(req(), e))?.status, 403);
  assert.equal((await gate(req({ "cf-access-jwt-assertion": "a.b.c" }), { ...e, ACCESS_TEAM_DOMAIN: undefined }))?.status, 403);
  assert.equal((await gate(req({ "cf-access-jwt-assertion": "a.b.c" }), { ...e, ACCESS_AUD: "TODO_ACCESS_AUD" }))?.status, 403);
});
