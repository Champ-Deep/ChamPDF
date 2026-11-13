// ChamPDF on Cloudflare Containers: feasibility Worker, NOT a migration.
//
// Worker -> Durable Object (Container class) -> existing backend image on :8000.
// The container disk is ephemeral. The only durable boundary is D1 + R2, which
// the container reaches through outbound handlers (virtual hosts below), so the
// Python code needs an HTTP store adapter, not a Cloudflare SDK.
import { Container } from "@cloudflare/containers";
// Required when the Container class uses outbound handlers (outboundByHost): the runtime resolves it from the entrypoint.
export { ContainerProxy } from "@cloudflare/containers";
import { gate } from "./gate";

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
}

export class ChamPdfBackend extends Container<Env> {
  defaultPort = 8000;
  // The image CMD binds "::" only. Proven unreachable over IPv4 under Docker/OrbStack (proof/RESULTS.md);
  // Cloudflare documents listening on 0.0.0.0. Override here instead of editing the Dockerfile.
  entrypoint = ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"];
  // Idle containers are stopped; their local disk (and any SQLite file on it) goes with them.
  sleepAfter = "10m";
  envVars = {
    // Deliberately a scratch path: nothing the app writes here survives a stop.
    CHAMPDF_DB_PATH: "/tmp/champdf/champdf.db",
    LOG_LEVEL: "INFO",
  };
}

type Handler = (req: Request, env: Env, ctx: { containerId: string }) => Promise<Response>;

// Virtual hosts the container may call. Proof-grade: one batch endpoint for D1
// (atomic via DB.batch) and plain object get/put for R2. A production adapter
// must add per-statement allow-listing and size caps before this ships.
const d1: Handler = async (req, env) => {
  const { statements } = (await req.json()) as { statements: { sql: string; params?: unknown[] }[] };
  const prepared = statements.map((s) => env.DB.prepare(s.sql).bind(...(s.params ?? [])));
  return Response.json(await env.DB.batch(prepared));
};
const r2: Handler = async (req, env) => {
  const key = new URL(req.url).pathname.slice(1);
  if (req.method === "PUT") {
    await env.FILES.put(key, req.body);
    return new Response(null, { status: 204 });
  }
  const obj = await env.FILES.get(key);
  return new Response(obj?.body ?? null, { status: obj ? 200 : 404 });
};
ChamPdfBackend.outboundByHost = { "d1.champdf.internal": d1, "r2.champdf.internal": r2 };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const denied = await gate(req, env);
    if (denied) return denied;

    const n = Math.max(1, Number(env.CONTAINER_INSTANCES) || 1);
    // ?instance=N pins an instance for tests; ignored in production.
    const pin = env.ENVIRONMENT === "production" ? null : new URL(req.url).searchParams.get("instance");
    const i = pin !== null ? Number(pin) % n : Math.floor(Math.random() * n);
    const res = await env.CHAMPDF.getByName(`champdf-${i}`).fetch(req);
    const out = new Response(res.body, res);
    out.headers.set("x-champdf-instance", String(i));
    return out;
  },
};
