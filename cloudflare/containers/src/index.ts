// ChamPDF on Cloudflare Containers: feasibility Worker, NOT a migration.
//
// Worker -> Durable Object (Container class) -> existing backend image on :8000.
// The container disk is ephemeral. The only durable boundary is D1 + R2, which
// the container reaches through outbound handlers (virtual hosts below), so the
// Python code needs an HTTP store adapter, not a Cloudflare SDK.
import { Container } from "@cloudflare/containers";
// Required when the Container class uses outbound handlers (outboundByHost): the runtime resolves it from the entrypoint.
export { ContainerProxy } from "@cloudflare/containers";
import { gate, safeEqual } from "./gate";
import statements from "./statements.json";

export interface Env {
  CHAMPDF: DurableObjectNamespace<ChamPdfBackend>;
  DB: D1Database;
  FILES: R2Bucket;
  ENVIRONMENT: "local" | "deepify" | "staging" | "production";
  ACCESS_MODE: "none" | "shared-token" | "cf-access";
  CONTAINER_INSTANCES: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  STAGING_TOKEN?: string; // secret, shared-token mode only
  SIGN_ORIGIN?: string; // Sign stays on its stateful origin (Railway) in Phase 1
  CHAMPDF_INTERNAL_TOKEN?: string; // secret, guards the d1/r2 outbound handlers
  CHAMPDF_ADMIN_TOKEN?: string; // secret, passed through to the backend admin API
}

export class ChamPdfBackend extends Container<Env> {
  defaultPort = 8000;
  // The image CMD binds "::" only. Proven unreachable over IPv4 under Docker/OrbStack (proof/RESULTS.md);
  // Cloudflare documents listening on 0.0.0.0. Override here instead of editing the Dockerfile.
  entrypoint = ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"];
  // Idle containers are stopped; their local disk (and any SQLite file on it) goes with them.
  sleepAfter = "10m";

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      // Deliberately a scratch path: nothing the app writes here survives a stop.
      CHAMPDF_DB_PATH: "/tmp/champdf/champdf.db",
      LOG_LEVEL: "INFO",
      CHAMPDF_KEYS_BACKEND: "d1",
      // "" reads as unset in the backend (both are checked with `if not`).
      CHAMPDF_INTERNAL_TOKEN: env.CHAMPDF_INTERNAL_TOKEN ?? "",
      CHAMPDF_ADMIN_TOKEN: env.CHAMPDF_ADMIN_TOKEN ?? "",
    };
  }
}

type Handler = (req: Request, env: Env) => Promise<Response>;

const STATEMENTS: Record<string, string> = statements;
const MAX_D1_BODY = 65536;
const MAX_D1_STATEMENTS = 8;
const MAX_R2_PUT = 100 * 1024 * 1024;

const detail = (status: number, msg: string) => Response.json({ detail: msg }, { status });

// The container fetches user URLs (/api/download-from-url), so these hosts are reachable by
// SSRF. Every call must carry the internal token; checked before anything else.
function internalAuth(req: Request, env: Env): Response | null {
  if (!env.CHAMPDF_INTERNAL_TOKEN) return detail(503, "internal token not configured");
  return safeEqual(req.headers.get("x-champdf-internal") ?? "", env.CHAMPDF_INTERNAL_TOKEN) ? null : detail(401, "unauthorized");
}

const isParam = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

// D1: named statements only (src/statements.json), all in one atomic DB.batch(). Contract: PHASE1.md section 5.
export const d1: Handler = async (req, env) => {
  const denied = internalAuth(req, env);
  if (denied) return denied;
  if (req.method !== "POST") return detail(405, "method not allowed");
  if (new URL(req.url).pathname !== "/") return detail(404, "not found");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_D1_BODY) return detail(413, "body too large");
  const raw = await req.arrayBuffer(); // content-length may be absent (chunked), so measure too
  if (raw.byteLength > MAX_D1_BODY) return detail(413, "body too large");
  let batch: unknown;
  try {
    batch = (JSON.parse(new TextDecoder().decode(raw)) as { batch?: unknown } | null)?.batch;
  } catch {
    return detail(400, "body is not JSON");
  }
  if (!Array.isArray(batch) || batch.length < 1 || batch.length > MAX_D1_STATEMENTS) {
    return detail(400, `batch must be an array of 1 to ${MAX_D1_STATEMENTS} statements`);
  }
  const prepared = [];
  for (const s of batch as ({ q?: unknown; params?: unknown } | null)[]) {
    const q = s?.q;
    if (typeof q !== "string" || !Object.hasOwn(STATEMENTS, q)) return detail(400, `unknown statement: ${String(q)}`);
    const params = s?.params ?? [];
    const sql = STATEMENTS[q];
    if (!Array.isArray(params) || params.length !== sql.split("?").length - 1 || !params.every(isParam)) {
      return detail(400, `wrong params for ${q}`);
    }
    prepared.push(env.DB.prepare(sql).bind(...params));
  }
  try {
    return Response.json(await env.DB.batch(prepared));
  } catch (e) {
    return detail(500, `d1 batch failed: ${(e as Error).message}`);
  }
};

// R2: scratch objects under tmp/ only. Phase 1 Python does not call it yet (kept for P1-R2).
export const r2: Handler = async (req, env) => {
  const denied = internalAuth(req, env);
  if (denied) return denied;
  if (req.method !== "GET" && req.method !== "PUT") return detail(405, "method not allowed");
  const key = new URL(req.url).pathname.slice(1);
  if (!key.startsWith("tmp/")) return detail(400, "key must start with tmp/");
  if (req.method === "PUT") {
    // Missing length is refused too: R2 needs a known length and the cap must hold.
    if (!(Number(req.headers.get("content-length") ?? NaN) <= MAX_R2_PUT)) return detail(413, "content-length required, max 100 MiB");
    await env.FILES.put(key, req.body);
    return new Response(null, { status: 204 });
  }
  const obj = await env.FILES.get(key);
  return new Response(obj?.body ?? null, { status: obj ? 200 : 404 });
};
ChamPdfBackend.outboundByHost = { "d1.champdf.internal": d1, "r2.champdf.internal": r2 };

// /api/sign/* writes legal records; the container disk is scratch, so Sign never reaches the DO.
async function sign(req: Request, env: Env, url: URL): Promise<Response> {
  const origin = env.SIGN_ORIGIN;
  if (!origin || origin.startsWith("TODO_")) return detail(503, "sign origin not configured");
  const res = await fetch(origin + url.pathname + url.search, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: "manual",
    duplex: "half",
  } as RequestInit);
  const out = new Response(res.body, res);
  out.headers.set("x-champdf-route", "sign-origin");
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const denied = await gate(req, env);
    if (denied) return denied;

    const url = new URL(req.url);
    // Match the decoded path: uvicorn decodes %2F, so "/api%2Fsign/x" would reach the container's sign router.
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { return detail(400, "bad path"); }
    // Exact match or "/api/sign/": "/api/sign-pdf" and "/api/verify-signature" are stateless and stay in the container.
    if (path === "/api/sign" || path.startsWith("/api/sign/")) return sign(req, env, url);

    const n = Math.max(1, Number(env.CONTAINER_INSTANCES) || 1);
    // ?instance=N pins an instance for tests; ignored in production.
    const pin = env.ENVIRONMENT === "production" ? null : url.searchParams.get("instance");
    const i = pin !== null ? Number(pin) % n : Math.floor(Math.random() * n);
    const res = await env.CHAMPDF.getByName(`champdf-${i}`).fetch(req);
    const out = new Response(res.body, res);
    out.headers.set("x-champdf-instance", String(i));
    return out;
  },
};
