// ChamPDF frontend Worker. Static assets are served by the assets binding;
// this code only runs for /api/* (wrangler run_worker_first). It replaces
// nginx.railway.conf.template: same /api/ path, same forwarded headers.
// shortcut: Host cannot be overridden on a Worker subrequest, so the backend
// sees its own hostname; the original host is sent in X-Forwarded-Host.
// Upgrade when: the backend starts routing on the Host header.

const SECURITY_HEADERS = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export async function proxyToBackend(request, env) {
  const url = new URL(request.url);
  const origin = new URL(env.BACKEND_ORIGIN);
  const target = new URL(url.pathname + url.search, origin);

  const headers = new Headers(request.headers);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  headers.set('X-Real-IP', ip);
  headers.set('X-Forwarded-For', ip);
  headers.set('X-Forwarded-Proto', 'https');
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Port', '443');

  // redirect: 'manual' mirrors nginx proxy_redirect off (Location passes through).
  const upstream = await fetch(
    new Request(target, {
      method: request.method,
      headers,
      body: request.body,
      duplex: 'half', // streaming body; required by the Fetch spec and by Node (tests)
      redirect: 'manual',
    })
  );

  const response = new Response(upstream.body, upstream);
  for (const [k, v] of Object.entries(SECURITY_HEADERS))
    response.headers.set(k, v);
  return response;
}

// The two LibreOffice WASM files exceed the 25 MiB Workers asset cap, so they
// live in R2 (bucket champdf-wasm) and are served gzip-encoded like nginx did.
const WASM_TYPES = {
  '/libreoffice-wasm/soffice.wasm.gz': 'application/wasm',
  '/libreoffice-wasm/soffice.data.gz': 'application/octet-stream',
};

async function serveWasm(request, env, type) {
  const object = await env.WASM.get(
    new URL(request.url).pathname.split('/').pop()
  );
  if (!object) return new Response('Not Found', { status: 404 });
  return new Response(object.body, {
    encodeBody: 'manual', // body is already gzip; stop the edge gzipping it twice
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding',
      'Cache-Control': 'public, immutable, max-age=31536000',
    },
  });
}

export default {
  async fetch(request, env) {
    const wasmType = WASM_TYPES[new URL(request.url).pathname];
    if (wasmType) return serveWasm(request, env, wasmType);
    if (!env.BACKEND_ORIGIN) {
      return new Response('BACKEND_ORIGIN is not set', { status: 500 });
    }
    try {
      return await proxyToBackend(request, env);
    } catch {
      return new Response('Bad Gateway', { status: 502 });
    }
  },
};
