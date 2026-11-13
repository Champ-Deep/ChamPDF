import { jwtVerify, createRemoteJWKSet } from "jose";

export interface GateEnv {
  ENVIRONMENT: string;
  ACCESS_MODE: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  STAGING_TOKEN?: string;
}

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

// Fails closed: every non-local, non-production env must have a configured gate.
export async function gate(req: Request, env: GateEnv): Promise<Response | null> {
  if (env.ACCESS_MODE === "none") {
    return env.ENVIRONMENT === "deepify" || env.ENVIRONMENT === "staging"
      ? new Response("staging gate not configured", { status: 503 })
      : null;
  }
  if (env.ACCESS_MODE === "shared-token") {
    const got = req.headers.get("x-staging-token") ?? "";
    return env.STAGING_TOKEN && safeEqual(got, env.STAGING_TOKEN) ? null : new Response("forbidden", { status: 403 });
  }
  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (!jwt || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || env.ACCESS_AUD.startsWith("TODO_")) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const jwks = createRemoteJWKSet(new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    await jwtVerify(jwt, jwks, { audience: env.ACCESS_AUD, issuer: `https://${env.ACCESS_TEAM_DOMAIN}` });
    return null;
  } catch {
    return new Response("forbidden", { status: 403 });
  }
}
