// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../../cloudflare/frontend-worker.js';

const env = { BACKEND_ORIGIN: 'https://api.example.test' };

afterEach(() => vi.unstubAllGlobals());

describe('frontend worker /api proxy', () => {
  it('forwards path, query, body and nginx-equivalent headers', async () => {
    const seen: Request[] = [];
    vi.stubGlobal('fetch', async (r: Request) => {
      seen.push(r);
      return new Response('ok', { status: 201 });
    });
    const res = await worker.fetch(
      new Request('https://champdf.com/api/ocr-pdf?x=1', {
        method: 'POST',
        body: 'pdf-bytes',
        headers: { 'CF-Connecting-IP': '1.2.3.4' },
      }),
      env
    );
    expect(res.status).toBe(201);
    expect(seen[0].url).toBe('https://api.example.test/api/ocr-pdf?x=1');
    expect(seen[0].method).toBe('POST');
    expect(await seen[0].text()).toBe('pdf-bytes');
    expect(seen[0].headers.get('X-Forwarded-For')).toBe('1.2.3.4');
    expect(seen[0].headers.get('X-Forwarded-Host')).toBe('champdf.com');
    expect(seen[0].headers.get('X-Forwarded-Proto')).toBe('https');
    expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBe(
      'require-corp'
    );
  });

  it('returns 502 when the backend is unreachable and 500 without BACKEND_ORIGIN', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('down');
    });
    const req = () => new Request('https://champdf.com/api/capabilities');
    expect((await worker.fetch(req(), env)).status).toBe(502);
    expect((await worker.fetch(req(), {})).status).toBe(500);
  });

  it('serves the LibreOffice gzip files from R2 with manual encoding', async () => {
    const WASM = { get: vi.fn(async () => ({ body: 'gz' })) };
    const res = await worker.fetch(
      new Request('https://champdf.com/libreoffice-wasm/soffice.wasm.gz'),
      { ...env, WASM }
    );
    expect(WASM.get).toHaveBeenCalledWith('soffice.wasm.gz');
    expect(res.headers.get('Content-Encoding')).toBe('gzip');
    expect(res.headers.get('Content-Type')).toBe('application/wasm');
  });
});
