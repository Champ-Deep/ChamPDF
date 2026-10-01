/**
 * Shared client helpers for ChampPDF Sign (the sender console and the
 * signer page). Thin on purpose: the backend owns every rule.
 */

export const SIGN_API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined) || '';

const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

export function isLinkTokenShape(t: string | null | undefined): t is string {
  return !!t && TOKEN_RE.test(t);
}

/**
 * The signing link is /s/<token> (rewritten to sign-document.html by Vercel
 * or nginx). ?t=<token> is accepted as a fallback for static hosts without
 * rewrites.
 */
export function parseSigningToken(
  pathname: string,
  search: string
): string | null {
  const m = pathname.match(/\/s\/([A-Za-z0-9_-]+)\/?$/);
  if (m && isLinkTokenShape(m[1])) return m[1];
  const q = new URLSearchParams(search).get('t');
  return isLinkTokenShape(q) ? q : null;
}

export interface ApiErrorDetail {
  code: string;
  message: string;
  [k: string]: unknown;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: ApiErrorDetail | null;
}

export interface BlobResult {
  ok: boolean;
  status: number;
  blob: Blob | null;
  filename: string | null;
  error: ApiErrorDetail | null;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  session?: string | null;
}

function parseError(status: number, data: unknown): ApiErrorDetail {
  if (data && typeof data === 'object' && 'detail' in data) {
    const d = (data as { detail: unknown }).detail;
    if (d && typeof d === 'object' && 'code' in d) return d as ApiErrorDetail;
    if (typeof d === 'string') return { code: `http_${status}`, message: d };
    if (Array.isArray(d) && d.length && typeof d[0] === 'object') {
      const first = d[0] as { msg?: string; loc?: unknown[] };
      return {
        code: 'validation_error',
        message: `${(first.loc || []).slice(-1)[0] ?? 'input'}: ${first.msg ?? 'invalid'}`,
      };
    }
  }
  return {
    code: `http_${status}`,
    message: status === 0 ? 'Network error' : `Request failed (${status})`,
  };
}

function buildHeaders(
  opts: RequestOptions,
  json: boolean
): Record<string, string> {
  const h: Record<string, string> = { ...(opts.headers || {}) };
  if (json) h['Content-Type'] = 'application/json';
  if (opts.session) h['Authorization'] = `Bearer ${opts.session}`;
  return h;
}

export async function signApi<T>(
  path: string,
  opts: RequestOptions = {}
): Promise<ApiResult<T>> {
  const hasBody = opts.body !== undefined;
  let res: Response;
  try {
    res = await fetch(`${SIGN_API_BASE}${path}`, {
      method: opts.method || (hasBody ? 'POST' : 'GET'),
      headers: buildHeaders(opts, hasBody),
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      credentials: 'omit',
    });
  } catch {
    return { ok: false, status: 0, data: null, error: parseError(0, null) };
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      data: null,
      error: parseError(res.status, data),
    };
  }
  return { ok: true, status: res.status, data: data as T, error: null };
}

export async function signApiBlob(
  path: string,
  opts: RequestOptions = {}
): Promise<BlobResult> {
  const hasBody = opts.body !== undefined;
  let res: Response;
  try {
    res = await fetch(`${SIGN_API_BASE}${path}`, {
      method: opts.method || (hasBody ? 'POST' : 'GET'),
      headers: buildHeaders(opts, hasBody),
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      credentials: 'omit',
    });
  } catch {
    return {
      ok: false,
      status: 0,
      blob: null,
      filename: null,
      error: parseError(0, null),
    };
  }
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    return {
      ok: false,
      status: res.status,
      blob: null,
      filename: null,
      error: parseError(res.status, data),
    };
  }
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename="?([^";]+)"?/);
  return {
    ok: true,
    status: res.status,
    blob: await res.blob(),
    filename: m ? m[1] : null,
    error: null,
  };
}

// --------------------------------------------------------------------------
// Signer session (per link, per tab)
// --------------------------------------------------------------------------

const SESSION_PREFIX = 'champdf:sign:session:';

export function sessionKey(token: string): string {
  return SESSION_PREFIX + token.slice(0, 16);
}

export function loadSession(token: string): string | null {
  try {
    return sessionStorage.getItem(sessionKey(token));
  } catch {
    return null;
  }
}

export function saveSession(token: string, session: string): void {
  try {
    sessionStorage.setItem(sessionKey(token), session);
  } catch {
    /* private mode etc. */
  }
}

export function clearSession(token: string): void {
  try {
    sessionStorage.removeItem(sessionKey(token));
  } catch {
    /* ignore */
  }
}

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------

export function formatDateTime(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function shortHash(h?: string | null, n = 12): string {
  return h ? `${h.slice(0, n)}…` : '-';
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const STATUS_CHIP: Record<string, string> = {
  draft: 'bg-gray-700 text-gray-200',
  sent: 'bg-blue-500/15 text-blue-300 border border-blue-500/40',
  viewed: 'bg-amber-500/15 text-amber-300 border border-amber-500/40',
  signed: 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/40',
  countersigned: 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/40',
  executed: 'bg-green-500/15 text-green-300 border border-green-500/40',
  voided: 'bg-red-500/15 text-red-300 border border-red-500/40',
  expired: 'bg-red-500/15 text-red-300 border border-red-500/40',
};

export function statusChip(status: string): string {
  const cls = STATUS_CHIP[status] || STATUS_CHIP.draft;
  return `<span class="inline-block rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cls}">${escapeHtml(status)}</span>`;
}
