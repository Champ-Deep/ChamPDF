import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";

// src/index.ts targets workerd: stub @cloudflare/containers (it imports cloudflare:workers), add the
// .ts extension bundler-style imports omit, and load the JSON registry without an import attribute.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@cloudflare/containers") {
      const stub = "export class Container { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class ContainerProxy {}";
      return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL?.includes("/src/") && !/\.\w+$/.test(specifier)) return next(specifier + ".ts", context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".json")) {
      return { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")};`, shortCircuit: true };
    }
    return next(url, context);
  },
});
const { d1, r2, ChamPdfBackend, default: worker } = await import("../src/index.ts");
const statements: Record<string, string> = (await import("../src/statements.json")).default;

const TOKEN = "t0ken-for-tests";
const auth = { "x-champdf-internal": TOKEN };

function fakeDB() {
  const prepared: { sql: string; params: unknown[] }[] = [];
  const DB = {
    prepare: (sql: string) => ({ bind: (...params: unknown[]) => { const s = { sql, params }; prepared.push(s); return s; } }),
    batch: async (stmts: unknown[]) => stmts.map((_, i) => ({ results: [], success: true, meta: { changes: 1, last_row_id: i + 1 } })),
  };
  return { DB, prepared };
}
function fakeBucket() {
  const store = new Map<string, string>();
  return {
    store,
    put: async (k: string, body: ReadableStream | null) => { store.set(k, await new Response(body).text()); },
    get: async (k: string) => (store.has(k) ? { body: new Response(store.get(k)).body } : null),
  };
}
const env = (over: Record<string, unknown> = {}) => ({ CHAMPDF_INTERNAL_TOKEN: TOKEN, ...fakeDB(), FILES: fakeBucket(), ...over }) as any;
const d1req = (body: unknown, h: Record<string, string> = auth, method = "POST") =>
  new Request("http://d1.champdf.internal/", { method, headers: h, body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body) });

test("statements.json: exactly the 8 contract statements, arity computed from ?", () => {
  const want = { "keys.health": 0, "keys.insert": 7, "keys.active_for_clerk": 1, "keys.by_hash": 1, "keys.revoke": 2, "keys.list": 0, "log.insert": 5, "keys.bump_usage": 4 };
  assert.deepEqual(Object.fromEntries(Object.entries(statements).map(([k, v]) => [k, v.split("?").length - 1])), want);
});

test("d1: 503 when CHAMPDF_INTERNAL_TOKEN is not configured", async () => {
  for (const t of [undefined, ""]) assert.equal((await d1(d1req({ batch: [] }), env({ CHAMPDF_INTERNAL_TOKEN: t }))).status, 503);
});
test("d1: 401 on missing or wrong token (SSRF from the container carries none)", async () => {
  assert.equal((await d1(d1req({ batch: [{ q: "keys.list" }] }, {}), env())).status, 401);
  assert.equal((await d1(d1req({ batch: [{ q: "keys.list" }] }, { "x-champdf-internal": TOKEN + "x" }), env())).status, 401);
  assert.equal((await d1(d1req({ batch: [{ q: "keys.list" }] }, { "x-champdf-internal": "" }), env())).status, 401);
});
test("d1: 405 for any method but POST", async () => {
  for (const m of ["GET", "PUT", "DELETE"]) assert.equal((await d1(d1req(null, auth, m), env())).status, 405);
});
test("d1: 413 over 65536 bytes, by header and by measured body", async () => {
  const big = JSON.stringify({ batch: [{ q: "keys.list", params: [], pad: "x".repeat(65536) }] });
  assert.equal((await d1(d1req(big), env())).status, 413);
  assert.equal((await d1(d1req("{}", { ...auth, "content-length": "65537" }), env())).status, 413);
});
test("d1: 400 for bad JSON, unknown q, wrong param count, bad param type, empty or > 8 statements", async () => {
  const cases: unknown[] = [
    "not json",
    "null",
    { statements: [{ sql: "DELETE FROM api_keys" }] }, // the old proof-grade shape
    { batch: [{ q: "DROP TABLE api_keys" }] },
    { batch: [{ q: "__proto__" }] },
    { batch: [{ q: "toString" }] },
    { batch: [{ q: "keys.by_hash", params: [] }] },
    { batch: [{ q: "keys.by_hash", params: ["a", "b"] }] },
    { batch: [{ q: "keys.by_hash", params: "a" }] },
    { batch: [{ q: "keys.by_hash", params: [{ sql: "x" }] }] },
    { batch: [null] },
    { batch: [] },
    { batch: Array(9).fill({ q: "keys.list" }) },
  ];
  for (const c of cases) assert.equal((await d1(d1req(c), env())).status, 400, JSON.stringify(c));
});
test("d1: 200 runs named statements in one batch and returns the D1 result as is", async () => {
  const e = env();
  const res = await d1(d1req({ batch: [{ q: "log.insert", params: [1, "2026-11-26T00:00:00Z", "/api/v1/x", 200, 12] }, { q: "keys.bump_usage", params: ["2026-11", "2026-11", "t", 1] }] }), e);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [
    { results: [], success: true, meta: { changes: 1, last_row_id: 1 } },
    { results: [], success: true, meta: { changes: 1, last_row_id: 2 } },
  ]);
  assert.deepEqual(e.prepared.map((s: { sql: string }) => s.sql), [statements["log.insert"], statements["keys.bump_usage"]]);
  assert.equal((await d1(d1req({ batch: Array(8).fill({ q: "keys.list" }) }), env())).status, 200);
  assert.equal((await d1(d1req({ batch: [{ q: "keys.health" }] }), env())).status, 200); // params may be omitted at arity 0
});

const r2req = (key: string, method = "GET", h: Record<string, string> = auth, body?: string) =>
  new Request(`http://r2.champdf.internal/${key}`, { method, headers: h, body });

test("r2: 503 unconfigured token, 401 missing/wrong token", async () => {
  assert.equal((await r2(r2req("tmp/a"), env({ CHAMPDF_INTERNAL_TOKEN: undefined }))).status, 503);
  assert.equal((await r2(r2req("tmp/a", "GET", {}), env())).status, 401);
  assert.equal((await r2(r2req("tmp/a", "GET", { "x-champdf-internal": "nope" }), env())).status, 401);
});
test("r2: 405 for methods other than GET and PUT", async () => {
  for (const m of ["DELETE", "POST", "HEAD"]) assert.equal((await r2(r2req("tmp/a", m), env())).status, 405);
});
test("r2: 400 for keys outside tmp/", async () => {
  for (const k of ["keys.db", "tmpx/a", "", "tmp/../secret"]) assert.equal((await r2(r2req(k), env())).status, 400, k);
});
test("r2: 413 for PUT over 100 MiB or without content-length", async () => {
  assert.equal((await r2(r2req("tmp/a", "PUT", { ...auth, "content-length": String(100 * 1024 * 1024 + 1) }, "x"), env())).status, 413);
  assert.equal((await r2(r2req("tmp/a", "PUT", auth, "x"), env())).status, 413);
});
test("r2: PUT then GET round-trips under tmp/, missing key is 404", async () => {
  const e = env();
  assert.equal((await r2(r2req("tmp/a.pdf", "PUT", { ...auth, "content-length": "5" }, "hello"), e)).status, 204);
  const got = await r2(r2req("tmp/a.pdf"), e);
  assert.equal(got.status, 200);
  assert.equal(await got.text(), "hello");
  assert.equal((await r2(r2req("tmp/missing"), e)).status, 404);
});

test("container: envVars carry d1 mode and both tokens from the Worker env, entrypoint kept", () => {
  const c = new ChamPdfBackend({} as any, { CHAMPDF_INTERNAL_TOKEN: "i", CHAMPDF_ADMIN_TOKEN: "a" } as any);
  assert.deepEqual(c.envVars, { CHAMPDF_DB_PATH: "/tmp/champdf/champdf.db", LOG_LEVEL: "INFO", CHAMPDF_KEYS_BACKEND: "d1", CHAMPDF_INTERNAL_TOKEN: "i", CHAMPDF_ADMIN_TOKEN: "a" });
  assert.deepEqual(c.entrypoint, ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]);
  assert.equal(ChamPdfBackend.outboundByHost["d1.champdf.internal"], d1);
  assert.equal(ChamPdfBackend.outboundByHost["r2.champdf.internal"], r2);
});

// Sign split: mocked global fetch stands in for SIGN_ORIGIN, a fake namespace for the DO.
function routing(SIGN_ORIGIN: string | undefined) {
  const doCalls: string[] = [], originCalls: { url: string; init: RequestInit }[] = [];
  const CHAMPDF = { getByName: (n: string) => ({ fetch: async (req: Request) => { doCalls.push(`${n} ${new URL(req.url).pathname}`); return new Response("from-do"); } }) };
  const e = { ENVIRONMENT: "local", ACCESS_MODE: "none", CONTAINER_INSTANCES: "1", SIGN_ORIGIN, CHAMPDF } as any;
  return { e, doCalls, originCalls };
}
async function withFetch<T>(calls: { url: string; init: RequestInit }[], fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(`origin saw ${await new Response(init.body).text()}`, { status: 302, headers: { location: "/elsewhere" } });
  }) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test("sign: /api/sign/status goes to SIGN_ORIGIN with query, body and manual redirects, never the DO", async () => {
  const { e, doCalls, originCalls } = routing("http://127.0.0.1:8001");
  const res = await withFetch(originCalls, () =>
    worker.fetch(new Request("https://api.test/api/sign/status?id=7", { method: "POST", headers: { "x-a": "1" }, body: "payload" }), e));
  assert.equal(res.headers.get("x-champdf-route"), "sign-origin");
  assert.equal(res.status, 302); // redirect passed through, not followed
  assert.equal(await res.text(), "origin saw payload");
  assert.equal(originCalls.length, 1);
  assert.equal(originCalls[0].url, "http://127.0.0.1:8001/api/sign/status?id=7");
  assert.equal(originCalls[0].init.method, "POST");
  assert.equal(originCalls[0].init.redirect, "manual");
  assert.equal(new Headers(originCalls[0].init.headers).get("x-a"), "1");
  assert.deepEqual(doCalls, []);
  await withFetch(originCalls, () => worker.fetch(new Request("https://api.test/api/sign"), e));
  assert.equal(originCalls[1].url, "http://127.0.0.1:8001/api/sign");
});
test("sign: percent-encoded slashes (/api/sign%2Fstatus, /api%2Fsign/status) still go to SIGN_ORIGIN with the raw path", async () => {
  // uvicorn decodes %2F before routing, so these would hit the container's sign router.
  for (const p of ["/api/sign%2Fstatus", "/api%2Fsign/status", "/api%2fsign%2fstatus"]) {
    const { e, doCalls, originCalls } = routing("http://127.0.0.1:8001");
    const res = await withFetch(originCalls, () => worker.fetch(new Request(`https://api.test${p}?x=1`), e));
    assert.equal(res.headers.get("x-champdf-route"), "sign-origin", p);
    assert.equal(originCalls[0]?.url, `http://127.0.0.1:8001${p}?x=1`, p);
    assert.deepEqual(doCalls, [], p);
  }
});
test("sign: malformed percent-encoding is 400 and reaches neither SIGN_ORIGIN nor the DO", async () => {
  const { e, doCalls, originCalls } = routing("http://127.0.0.1:8001");
  const res = await withFetch(originCalls, () => worker.fetch(new Request("https://api.test/api/sign%E0%A4%A/status"), e));
  assert.equal(res.status, 400);
  assert.equal(originCalls.length + doCalls.length, 0);
});
test("sign: /api/sign-pdf and /api/verify-signature stay on the container DO", async () => {
  const { e, doCalls, originCalls } = routing("http://127.0.0.1:8001");
  for (const p of ["/api/sign-pdf", "/api/verify-signature", "/api/signature"]) {
    const res = await withFetch(originCalls, () => worker.fetch(new Request(`https://api.test${p}`), e));
    assert.equal(await res.text(), "from-do");
    assert.equal(res.headers.get("x-champdf-route"), null);
  }
  assert.deepEqual(doCalls, ["champdf-0 /api/sign-pdf", "champdf-0 /api/verify-signature", "champdf-0 /api/signature"]);
  assert.equal(originCalls.length, 0);
});
test("sign: SIGN_ORIGIN TODO_, empty or unset is 503 and nothing is forwarded", async () => {
  for (const o of ["TODO_SIGN_ORIGIN", "", undefined]) {
    const { e, doCalls, originCalls } = routing(o);
    const res = await withFetch(originCalls, () => worker.fetch(new Request("https://api.test/api/sign/status"), e));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { detail: "sign origin not configured" });
    assert.equal(originCalls.length + doCalls.length, 0);
  }
});
