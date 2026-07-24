/**
 * Self-serve API key panel (Clerk-gated).
 *
 * A signed-in user opens this from the navbar "API" pill (see clerk-auth.ts,
 * which dispatches `champdf:open-api-access`). It talks to the backend's
 * /api/v1/keys/me endpoints using the Clerk session token, lets the user
 * create / rotate / revoke their personal ChamPDF API key, and shows a
 * ready-to-paste MCP config so they can wire it into their AI assistant
 * (Claude Code, Claude Desktop, Cursor, …).
 *
 * The raw key is only ever returned once (it's hashed at rest on the server),
 * so we surface it prominently right after create/rotate and otherwise show a
 * placeholder with a "rotate to reveal a new key" hint.
 */

import { getClerkSessionToken } from './clerk-auth.js';
import { toast } from '../utils/toast.js';

// Backend root. MCP's CHAMPDF_API_BASE_URL is this same root (it appends /api/v1).
const API_BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ||
  window.location.origin;

const MCP_PACKAGE = '@champ-deep/champdf-mcp';
const KEY_PLACEHOLDER = 'champdf_live_…';

interface KeyStatus {
  has_key: boolean;
  label?: string | null;
  monthly_quota?: number | null;
  requests_used?: number | null;
  created_at?: string | null;
  last_used_at?: string | null;
  email?: string | null;
}

let initialized = false;
let modal: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;

export function initApiAccessPanel(): void {
  if (initialized) return;
  initialized = true;
  document.addEventListener('champdf:open-api-access', () => void open());
}

// --------------------------------------------------------------------------
// Backend calls
// --------------------------------------------------------------------------

async function api(
  path: string,
  method: 'GET' | 'POST' | 'DELETE'
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const token = await getClerkSessionToken();
  if (!token) {
    return {
      ok: false,
      status: 401,
      data: { detail: 'Please sign in first.' },
    };
  }
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { ok: res.ok, status: res.status, data };
}

function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'detail' in data) {
    const d = (data as { detail: unknown }).detail;
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object' && 'message' in d) {
      return String((d as { message: unknown }).message);
    }
  }
  return fallback;
}

// --------------------------------------------------------------------------
// UI
// --------------------------------------------------------------------------

function ensureModal(): void {
  if (modal) return;
  modal = document.createElement('div');
  modal.id = 'api-access-modal';
  modal.className =
    'hidden fixed inset-0 z-[100] flex items-center justify-center p-4';
  modal.innerHTML = `
    <div id="api-access-backdrop" class="absolute inset-0 bg-black/60 backdrop-blur-sm"></div>
    <div class="relative w-full max-w-lg rounded-xl bg-gray-800 border border-gray-700 shadow-2xl max-h-[90vh] overflow-y-auto">
      <div class="flex items-center justify-between px-5 py-4 border-b border-gray-700">
        <div>
          <h2 class="text-white text-lg font-semibold">API access</h2>
          <p class="text-gray-400 text-xs mt-0.5">Use ChamPDF from your AI assistant</p>
        </div>
        <button id="api-access-close" class="text-gray-400 hover:text-white text-2xl leading-none" aria-label="Close">&times;</button>
      </div>
      <div id="api-access-body" class="px-5 py-4 space-y-4 text-sm"></div>
    </div>`;
  document.body.appendChild(modal);
  bodyEl = modal.querySelector('#api-access-body');

  const close = () => modal?.classList.add('hidden');
  modal.querySelector('#api-access-close')?.addEventListener('click', close);
  modal.querySelector('#api-access-backdrop')?.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      close();
    }
  });
}

async function open(): Promise<void> {
  ensureModal();
  modal?.classList.remove('hidden');
  renderLoading();
  await refresh();
}

function renderLoading(): void {
  if (bodyEl) {
    bodyEl.innerHTML = `<p class="text-gray-400">Loading your API access…</p>`;
  }
}

async function refresh(): Promise<void> {
  const { ok, status, data } = await api('/api/v1/keys/me', 'GET');
  if (!ok) {
    if (status === 503) {
      renderDisabled();
      return;
    }
    renderError(errorMessage(data, `Could not load API status (${status}).`));
    return;
  }
  renderStatus(data as KeyStatus);
}

function renderDisabled(): void {
  if (!bodyEl) return;
  bodyEl.innerHTML = `
    <div class="rounded-lg bg-gray-900/60 border border-gray-700 p-4">
      <p class="text-white font-medium mb-1">Self-serve keys aren't enabled yet</p>
      <p class="text-gray-400">
        This ChamPDF server hasn't been configured for Clerk-issued API keys
        (<code class="text-orange-400">CLERK_ISSUER</code> is unset). Once the
        backend has it set, you'll be able to mint a key here.
      </p>
    </div>`;
}

function renderError(message: string): void {
  if (!bodyEl) return;
  bodyEl.innerHTML = '';
  const box = document.createElement('div');
  box.className =
    'rounded-lg bg-red-500/10 border border-red-500/40 p-4 text-red-300';
  box.textContent = message;
  bodyEl.appendChild(box);
}

function renderStatus(status: KeyStatus, freshKey?: string): void {
  if (!bodyEl) return;
  bodyEl.innerHTML = '';

  // Key state row
  const card = document.createElement('div');
  card.className = 'rounded-lg bg-gray-900/60 border border-gray-700 p-4';
  if (status.has_key) {
    const used = status.requests_used ?? 0;
    const quota = status.monthly_quota ?? 0;
    const created = status.created_at
      ? new Date(status.created_at).toLocaleDateString()
      : '—';
    card.innerHTML = `
      <p class="text-white font-medium mb-1">You have an active API key</p>
      <p class="text-gray-400 text-xs">
        Created ${escapeHtml(created)} ·
        ${used}/${quota} requests used this month
      </p>`;
  } else {
    card.innerHTML = `
      <p class="text-white font-medium mb-1">No API key yet</p>
      <p class="text-gray-400 text-xs">
        Generate one to let your AI assistant call ChamPDF on your behalf.
      </p>`;
  }
  bodyEl.appendChild(card);

  // Fresh key reveal (only right after create/rotate)
  if (freshKey) {
    const reveal = document.createElement('div');
    reveal.className =
      'rounded-lg bg-orange-500/10 border border-orange-500/40 p-4';
    reveal.innerHTML = `
      <p class="text-orange-300 font-medium mb-2">Your new API key</p>
      <p class="text-gray-400 text-xs mb-2">
        Copy it now — for security it won't be shown again. Rotate any time to
        replace it.
      </p>`;
    reveal.appendChild(copyRow(freshKey));
    bodyEl.appendChild(reveal);
  }

  // MCP config
  bodyEl.appendChild(mcpConfigSection(freshKey ?? KEY_PLACEHOLDER, !freshKey));

  // Actions
  const actions = document.createElement('div');
  actions.className = 'flex flex-wrap gap-2 pt-1';
  if (status.has_key) {
    actions.appendChild(
      button('Rotate key', 'primary', async () => {
        if (
          !confirm(
            'Rotate your API key? The current key stops working immediately and any assistant using it must be updated.'
          )
        ) {
          return;
        }
        await mutate('/api/v1/keys/me/rotate', 'POST', 'Key rotated');
      })
    );
    actions.appendChild(
      button('Revoke', 'danger', async () => {
        if (
          !confirm(
            'Revoke your API key? It stops working immediately. You can generate a new one later.'
          )
        ) {
          return;
        }
        await mutate('/api/v1/keys/me', 'DELETE', 'Key revoked');
      })
    );
  } else {
    actions.appendChild(
      button('Generate API key', 'primary', async () => {
        await mutate('/api/v1/keys/me', 'POST', 'API key created');
      })
    );
  }
  bodyEl.appendChild(actions);
}

async function mutate(
  path: string,
  method: 'POST' | 'DELETE',
  successMsg: string
): Promise<void> {
  const { ok, status, data } = await api(path, method);
  if (!ok) {
    toast.error(errorMessage(data, `Request failed (${status}).`));
    // 409 (already exists) — just refresh to show current state.
    if (status === 409) await refresh();
    return;
  }
  toast.success(successMsg);
  const key =
    data && typeof data === 'object' && 'key' in data
      ? String((data as { key: unknown }).key)
      : undefined;
  if (key) {
    // Re-read status (for usage/quota) then reveal the fresh key.
    const statusRes = await api('/api/v1/keys/me', 'GET');
    renderStatus(
      statusRes.ok ? (statusRes.data as KeyStatus) : { has_key: true },
      key
    );
  } else {
    await refresh();
  }
}

function mcpConfigSection(key: string, masked: boolean): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'space-y-2';

  const heading = document.createElement('p');
  heading.className = 'text-white font-medium';
  heading.textContent = 'Connect your AI assistant';
  wrap.appendChild(heading);

  const hint = document.createElement('p');
  hint.className = 'text-gray-400 text-xs';
  hint.textContent = masked
    ? 'Generate or rotate a key to fill these in with your real key.'
    : 'Paste into Claude Code, or add the JSON to Claude Desktop / Cursor.';
  wrap.appendChild(hint);

  const docsLine = document.createElement('p');
  docsLine.className = 'text-gray-400 text-xs';
  docsLine.innerHTML =
    'Full endpoint reference: ' +
    '<a href="developers.html" class="text-orange-400 hover:text-orange-300">Developers guide</a>' +
    ' · ' +
    '<a href="/llms.txt" class="text-orange-400 hover:text-orange-300">llms.txt</a>' +
    ' (paste into an AI tool) · ' +
    '<a href="/docs" class="text-orange-400 hover:text-orange-300">Swagger</a>';
  wrap.appendChild(docsLine);

  const cli =
    `claude mcp add champdf \\\n` +
    `  -e CHAMPDF_API_KEY=${key} \\\n` +
    `  -e CHAMPDF_API_BASE_URL=${API_BASE_URL} \\\n` +
    `  -- npx -y ${MCP_PACKAGE}`;
  wrap.appendChild(codeBlock('Claude Code', cli));

  const json = JSON.stringify(
    {
      mcpServers: {
        champdf: {
          command: 'npx',
          args: ['-y', MCP_PACKAGE],
          env: {
            CHAMPDF_API_KEY: key,
            CHAMPDF_API_BASE_URL: API_BASE_URL,
          },
        },
      },
    },
    null,
    2
  );
  wrap.appendChild(codeBlock('Claude Desktop / Cursor', json));

  return wrap;
}

// --------------------------------------------------------------------------
// Small DOM helpers
// --------------------------------------------------------------------------

function button(
  label: string,
  variant: 'primary' | 'danger',
  onClick: () => void | Promise<void>
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  const base = 'px-3 py-1.5 rounded-md text-sm font-medium transition-colors';
  b.className =
    variant === 'primary'
      ? `${base} bg-orange-500 hover:bg-orange-600 text-white`
      : `${base} border border-red-500/50 text-red-400 hover:bg-red-500/10`;
  b.addEventListener('click', () => void onClick());
  return b;
}

function copyRow(value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'flex items-center gap-2';
  const code = document.createElement('code');
  code.className =
    'flex-1 truncate rounded bg-gray-900 border border-gray-700 px-2 py-1.5 text-xs text-orange-300';
  code.textContent = value;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Copy';
  btn.className =
    'shrink-0 px-2.5 py-1.5 rounded-md text-xs font-medium bg-gray-700 hover:bg-gray-600 text-white';
  btn.addEventListener('click', () => void copy(value));
  row.appendChild(code);
  row.appendChild(btn);
  return row;
}

function codeBlock(title: string, content: string): HTMLElement {
  const wrap = document.createElement('div');
  const header = document.createElement('div');
  header.className = 'flex items-center justify-between mb-1';
  const label = document.createElement('span');
  label.className = 'text-gray-400 text-xs';
  label.textContent = title;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Copy';
  btn.className =
    'px-2 py-0.5 rounded text-xs bg-gray-700 hover:bg-gray-600 text-white';
  btn.addEventListener('click', () => void copy(content));
  header.appendChild(label);
  header.appendChild(btn);

  const pre = document.createElement('pre');
  pre.className =
    'rounded bg-gray-900 border border-gray-700 p-3 text-xs text-gray-200 overflow-x-auto whitespace-pre';
  pre.textContent = content;

  wrap.appendChild(header);
  wrap.appendChild(pre);
  return wrap;
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  } catch {
    toast.error('Copy failed — select and copy manually.');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
