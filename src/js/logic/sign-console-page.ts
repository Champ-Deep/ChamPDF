/**
 * ChampPDF Sign: the sender console (/sign.html).
 *
 * Clerk-gated when the build has VITE_CLERK_PUBLISHABLE_KEY (the backend
 * verifies the session JWT and the sender's email domain). Without Clerk the
 * console falls back to the backend admin token so the spine can be exercised
 * locally. Pick a template, fill the counterparty block, preview, send, then
 * watch the document move through sent / viewed / signed / executed with its
 * audit trail.
 */

import { createIcons, icons } from 'lucide';
import {
  clerkEnabled,
  getClerkSessionToken,
} from '../components/clerk-auth.js';
import { downloadFile } from '../utils/helpers.js';
import { toast } from '../utils/toast.js';
import {
  escapeHtml,
  formatDateTime,
  shortHash,
  signApi,
  signApiBlob,
  statusChip,
} from '../utils/sign-api.js';

interface TemplateField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  placeholder: string;
  help: string;
  default: string;
  options?: string[];
}

interface TemplateInfo {
  id: string;
  version: number;
  name: string;
  short_name: string;
  description: string;
  fields: TemplateField[];
  source: string;
}

interface Recipient {
  id: string;
  role: string;
  name: string;
  email: string;
  designation: string | null;
  status: string;
  locked: boolean;
  viewed_at: string | null;
  signed_at: string | null;
}

interface DocumentView {
  id: string;
  title: string;
  status: string;
  template_id: string;
  template_version: number;
  counterparty_entity: string;
  sender: { email: string | null; name: string | null };
  page_count: number | null;
  draft_sha256: string | null;
  content_sha256: string | null;
  chain_head_at_execution: string | null;
  seal: { sealed: boolean; timestamped: boolean; self_signed: boolean } | null;
  expires_at: string;
  created_at: string;
  sent_at: string | null;
  executed_at: string | null;
  void_reason: string | null;
  recipients: Recipient[];
  events?: {
    id: number;
    event_type: string;
    occurred_at: string;
    ip_address: string | null;
    actor_email: string | null;
    event_hash: string;
  }[];
  chain?: { ok: boolean; events: number; head: string };
  dev_links?: Record<string, string>;
}

interface SignStatus {
  enabled: boolean;
  provider: { name: string; hosted_signing: boolean };
  mail_configured: boolean;
  seal_self_signed: boolean | null;
  entity: string;
}

const ADMIN_KEY = 'champdf:sign:admin-token';

let templates: TemplateInfo[] = [];
let authHeaders: Record<string, string> = {};
let authMode: 'clerk' | 'admin' | null = null;
let selectedDoc: string | null = null;

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

function feedback(id: string, message: string | null): void {
  const node = el(id);
  node.textContent = message || '';
  node.classList.toggle('hidden', !message);
}

async function api<T>(
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown } = {}
) {
  await refreshAuthHeaders();
  return signApi<T>(path, { ...opts, headers: authHeaders });
}

async function refreshAuthHeaders(): Promise<void> {
  if (authMode === 'clerk') {
    const t = await getClerkSessionToken();
    authHeaders = t ? { Authorization: `Bearer ${t}` } : {};
  }
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void init());
} else {
  void init();
}

async function init(): Promise<void> {
  createIcons({ icons });
  el('back-to-tools').addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });
  wireEvents();
  await loadStatus();
  await authenticate();
}

async function loadStatus(): Promise<void> {
  const res = await signApi<SignStatus>('/api/sign/status');
  const box = el('sign-status');
  if (!res.ok || !res.data) {
    box.innerHTML = '<span class="text-red-300">Backend unreachable</span>';
    return;
  }
  const s = res.data;
  box.innerHTML = [
    `<span>engine <b class="text-gray-300">${escapeHtml(s.provider.name)}</b></span>`,
    `<span>mail <b class="${s.mail_configured ? 'text-green-300' : 'text-amber-300'}">${s.mail_configured ? 'on' : 'log only'}</b></span>`,
    `<span>entity <b class="text-gray-300">${escapeHtml(s.entity)}</b></span>`,
  ].join(' · ');
  el('mail-warning').classList.toggle('hidden', s.mail_configured);
  el('seal-warning').classList.toggle('hidden', !s.seal_self_signed);
  if (!s.enabled) {
    box.innerHTML +=
      ' · <span class="text-red-300">signing disabled on this server</span>';
  }
}

async function authenticate(): Promise<void> {
  el('auth-gate').classList.remove('hidden');
  if (clerkEnabled()) {
    authMode = 'clerk';
    el('auth-clerk').classList.remove('hidden');
    // Clerk loads asynchronously from main.ts; watch for a session.
    const tryOpen = async (): Promise<boolean> => {
      const t = await getClerkSessionToken();
      if (!t) return false;
      authHeaders = { Authorization: `Bearer ${t}` };
      return openConsole();
    };
    if (await tryOpen()) return;
    const timer = window.setInterval(async () => {
      if (await tryOpen()) window.clearInterval(timer);
    }, 1500);
    return;
  }
  authMode = 'admin';
  el('auth-dev').classList.remove('hidden');
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(ADMIN_KEY);
  } catch {
    /* ignore */
  }
  if (stored) {
    authHeaders = { 'X-Admin-Token': stored };
    await openConsole();
  }
}

async function openConsole(): Promise<boolean> {
  feedback('auth-feedback', null);
  const res = await api<{ templates: TemplateInfo[]; role: string }>(
    '/api/sign/templates'
  );
  if (!res.ok || !res.data) {
    feedback('auth-feedback', res.error?.message || 'Could not authenticate.');
    if (authMode === 'admin') {
      try {
        sessionStorage.removeItem(ADMIN_KEY);
      } catch {
        /* ignore */
      }
    }
    return false;
  }
  templates = res.data.templates;
  el('auth-gate').classList.add('hidden');
  el('console').classList.remove('hidden');
  renderTemplates();
  await loadDocuments();
  const verify = new URLSearchParams(window.location.search).get('verify');
  if (verify) await openDetail(verify, true);
  return true;
}

// --------------------------------------------------------------------------
// Form
// --------------------------------------------------------------------------

function renderTemplates(): void {
  const select = el<HTMLSelectElement>('template');
  select.innerHTML = templates
    .map(
      (t) =>
        `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)} (v${t.version})</option>`
    )
    .join('');
  renderFields();
}

function currentTemplate(): TemplateInfo | undefined {
  const id = el<HTMLSelectElement>('template').value;
  return templates.find((t) => t.id === id);
}

function renderFields(): void {
  const t = currentTemplate();
  const box = el('template-fields');
  if (!t) {
    box.innerHTML = '';
    return;
  }
  el('template-description').textContent =
    `${t.description} Source: ${t.source === 'docx' ? 'Master .docx' : 'HTML body'}.`;
  const input =
    'w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent';
  box.innerHTML = t.fields
    .map((f) => {
      const id = `field-${f.key}`;
      const req = f.required ? '<span class="text-orange-400">*</span>' : '';
      let control: string;
      if (f.type === 'textarea') {
        control = `<textarea id="${id}" rows="3" placeholder="${escapeHtml(f.placeholder)}" class="${input}">${escapeHtml(f.default)}</textarea>`;
      } else if (f.type === 'select' && f.options) {
        control = `<select id="${id}" class="${input}">${f.options
          .map(
            (o) =>
              `<option value="${escapeHtml(o)}" ${o === f.default ? 'selected' : ''}>${escapeHtml(o)}</option>`
          )
          .join('')}</select>`;
      } else {
        const type =
          f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text';
        control = `<input id="${id}" type="${type}" value="${escapeHtml(f.default)}" placeholder="${escapeHtml(f.placeholder)}" class="${input}" />`;
      }
      return `<div>
        <label for="${id}" class="block text-sm font-medium text-gray-300 mb-1">${escapeHtml(f.label)} ${req}</label>
        ${control}
        ${f.help ? `<p class="text-xs text-gray-500 mt-1">${escapeHtml(f.help)}</p>` : ''}
      </div>`;
    })
    .join('');
}

function collectFields(): Record<string, string> {
  const t = currentTemplate();
  const out: Record<string, string> = {};
  for (const f of t?.fields || []) {
    const node = document.getElementById(`field-${f.key}`) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement
      | null;
    if (node) out[f.key] = node.value;
  }
  return out;
}

function collectSigner(): { name: string; email: string; designation: string } {
  return {
    name: el<HTMLInputElement>('signer-name').value.trim(),
    email: el<HTMLInputElement>('signer-email').value.trim(),
    designation: el<HTMLInputElement>('signer-designation').value.trim(),
  };
}

function highlightField(key?: string): void {
  document
    .querySelectorAll('[id^="field-"], #signer-name, #signer-email')
    .forEach((n) => n.classList.remove('ring-2', 'ring-red-500'));
  if (!key) return;
  const id = key.startsWith('signer.')
    ? `signer-${key.split('.')[1]}`
    : `field-${key}`;
  document.getElementById(id)?.classList.add('ring-2', 'ring-red-500');
}

async function preview(): Promise<void> {
  const t = currentTemplate();
  if (!t) return;
  feedback('form-feedback', null);
  highlightField();
  await refreshAuthHeaders();
  const res = await signApiBlob('/api/sign/documents/preview', {
    body: {
      template_id: t.id,
      fields: collectFields(),
      signer: signerOrNull(),
    },
    headers: authHeaders,
  });
  if (!res.ok || !res.blob) {
    feedback('form-feedback', res.error?.message || 'Preview failed.');
    highlightField(res.error?.field as string | undefined);
    return;
  }
  const url = URL.createObjectURL(res.blob);
  el<HTMLIFrameElement>('preview-frame').src = url;
  el('preview-modal').classList.remove('hidden');
}

function signerOrNull() {
  const s = collectSigner();
  return s.name || s.email
    ? {
        name: s.name || 'Signer',
        email: s.email || 'signer@example.com',
        designation: s.designation,
      }
    : null;
}

async function send(): Promise<void> {
  const t = currentTemplate();
  if (!t) return;
  feedback('form-feedback', null);
  highlightField();
  const signer = collectSigner();
  if (!signer.name || !signer.email) {
    feedback('form-feedback', 'Signer name and email are required.');
    highlightField(!signer.name ? 'signer.name' : 'signer.email');
    return;
  }
  const btn = el<HTMLButtonElement>('btn-send');
  btn.disabled = true;
  btn.textContent = 'Rendering and sending…';
  const res = await api<DocumentView>('/api/sign/documents', {
    body: {
      template_id: t.id,
      fields: collectFields(),
      signer,
      expires_in_days: Number(el<HTMLSelectElement>('expires').value),
    },
  });
  btn.disabled = false;
  btn.textContent = 'Send for signature';
  if (!res.ok || !res.data) {
    feedback('form-feedback', res.error?.message || 'Sending failed.');
    highlightField(res.error?.field as string | undefined);
    return;
  }
  toast.success('Document sent');
  renderSendResult(res.data);
  await loadDocuments();
  await openDetail(res.data.id);
}

function renderSendResult(doc: DocumentView): void {
  const box = el('send-result');
  const rec = doc.recipients[0];
  let html = `<p class="text-green-300 font-medium mb-1">Sent ${statusChip(doc.status)}</p>
    <p class="text-gray-300">${escapeHtml(doc.title)}</p>
    <p class="text-gray-500 text-xs mt-1">Invitation to ${escapeHtml(rec?.email || '')} · valid until ${escapeHtml(formatDateTime(doc.expires_at))}</p>`;
  if (doc.dev_links) {
    for (const [rid, link] of Object.entries(doc.dev_links)) {
      const r = doc.recipients.find((x) => x.id === rid);
      html += `<div class="mt-3 bg-amber-500/10 border border-amber-500/40 rounded p-3">
        <p class="text-amber-200 text-xs mb-1">Mail is log-only on this server. Hand this link to ${escapeHtml(r?.name || 'the signer')}:</p>
        <div class="flex items-center gap-2">
          <code class="flex-1 truncate text-xs text-orange-300">${escapeHtml(link)}</code>
          <button data-copy="${escapeHtml(link)}" class="shrink-0 px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-white">Copy</button>
        </div></div>`;
    }
  }
  box.innerHTML = html;
  box.classList.remove('hidden');
  box
    .querySelectorAll<HTMLButtonElement>('button[data-copy]')
    .forEach((b) =>
      b.addEventListener('click', () => void copy(b.dataset.copy || ''))
    );
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied');
  } catch {
    toast.error('Copy failed');
  }
}

// --------------------------------------------------------------------------
// Documents list and detail
// --------------------------------------------------------------------------

async function loadDocuments(): Promise<void> {
  const res = await api<{ documents: DocumentView[]; role: string }>(
    '/api/sign/documents'
  );
  const list = el('doc-list');
  if (!res.ok || !res.data) {
    list.innerHTML = `<p class="py-3 text-red-300">${escapeHtml(res.error?.message || 'Could not load documents.')}</p>`;
    return;
  }
  const docs = res.data.documents;
  if (!docs.length) {
    list.innerHTML = '<p class="py-3 text-gray-500">Nothing sent yet.</p>';
    return;
  }
  list.innerHTML = docs
    .map((d) => {
      const signer = d.recipients.find((r) => r.role === 'signer');
      const stale =
        ['sent', 'viewed'].includes(d.status) &&
        d.sent_at &&
        Date.now() - new Date(d.sent_at).getTime() > 5 * 86400e3;
      return `<button data-open="${escapeHtml(d.id)}" class="w-full text-left py-3 flex items-start justify-between gap-3 hover:bg-gray-700/40 px-2 rounded ${selectedDoc === d.id ? 'bg-gray-700/40' : ''}">
        <div class="min-w-0">
          <p class="text-gray-100 font-medium truncate">${escapeHtml(d.counterparty_entity)}</p>
          <p class="text-gray-500 text-xs truncate">${escapeHtml(signer?.email || '')} · ${escapeHtml(d.template_id)} · sent ${escapeHtml(formatDateTime(d.sent_at || d.created_at))}</p>
        </div>
        <div class="shrink-0 text-right space-y-1">
          ${statusChip(d.status)}
          ${stale ? '<p class="text-[10px] text-amber-300">not opened in 5+ days</p>' : ''}
          ${signer?.locked ? '<p class="text-[10px] text-red-300">link locked</p>' : ''}
        </div>
      </button>`;
    })
    .join('');
  list
    .querySelectorAll<HTMLButtonElement>('button[data-open]')
    .forEach((b) =>
      b.addEventListener('click', () => void openDetail(b.dataset.open || ''))
    );
}

async function openDetail(id: string, runVerify = false): Promise<void> {
  selectedDoc = id;
  const res = await api<DocumentView>(
    `/api/sign/documents/${encodeURIComponent(id)}`
  );
  const box = el('doc-detail');
  box.classList.remove('hidden');
  if (!res.ok || !res.data) {
    box.innerHTML = `<p class="text-red-300">${escapeHtml(res.error?.message || 'Could not load the document.')}</p>`;
    return;
  }
  const d = res.data;
  const canVoid = !['executed', 'voided', 'expired'].includes(d.status);
  const canResend = ['sent', 'viewed', 'signed', 'countersigned'].includes(
    d.status
  );
  const recipients = d.recipients
    .map(
      (
        r
      ) => `<li class="flex flex-wrap items-center justify-between gap-2 py-2">
        <span><span class="text-gray-100">${escapeHtml(r.name)}</span> <span class="text-gray-500 text-xs">${escapeHtml(r.email)} · ${escapeHtml(r.role)}${r.designation ? ' · ' + escapeHtml(r.designation) : ''}</span></span>
        <span class="text-xs text-gray-400">${statusChip(r.status)} ${r.locked ? '<span class="text-red-300 ml-1">locked</span>' : ''} ${r.signed_at ? 'signed ' + escapeHtml(formatDateTime(r.signed_at)) : r.viewed_at ? 'viewed ' + escapeHtml(formatDateTime(r.viewed_at)) : ''}</span>
      </li>`
    )
    .join('');
  const events = (d.events || [])
    .slice()
    .reverse()
    .map(
      (e) => `<li class="grid grid-cols-[auto_1fr_auto] gap-3 py-1.5 text-xs">
        <span class="text-gray-500 font-mono whitespace-nowrap">${escapeHtml(formatDateTime(e.occurred_at))}</span>
        <span class="text-gray-200">${escapeHtml(e.event_type)} <span class="text-gray-500">${escapeHtml(e.actor_email || '')} ${escapeHtml(e.ip_address || '')}</span></span>
        <span class="text-gray-600 font-mono" title="${escapeHtml(e.event_hash)}">${escapeHtml(shortHash(e.event_hash, 8))}</span>
      </li>`
    )
    .join('');
  box.innerHTML = `
    <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
      <div class="min-w-0">
        <h2 class="text-lg font-semibold text-white truncate">${escapeHtml(d.title)}</h2>
        <p class="text-xs text-gray-500 font-mono">${escapeHtml(d.id)}</p>
      </div>
      <div>${statusChip(d.status)}</div>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs mb-4">
      <div class="bg-gray-900/60 border border-gray-700 rounded p-2"><p class="text-gray-500">Template</p><p class="text-gray-200">${escapeHtml(d.template_id)} v${d.template_version}</p></div>
      <div class="bg-gray-900/60 border border-gray-700 rounded p-2"><p class="text-gray-500">Sent</p><p class="text-gray-200">${escapeHtml(formatDateTime(d.sent_at))}</p></div>
      <div class="bg-gray-900/60 border border-gray-700 rounded p-2"><p class="text-gray-500">Expires</p><p class="text-gray-200">${escapeHtml(formatDateTime(d.expires_at))}</p></div>
      <div class="bg-gray-900/60 border border-gray-700 rounded p-2"><p class="text-gray-500">Executed</p><p class="text-gray-200">${escapeHtml(formatDateTime(d.executed_at))}</p></div>
    </div>
    ${d.content_sha256 ? `<p class="text-xs text-gray-500 mb-1">Sealed file SHA-256</p><p class="text-xs font-mono text-gray-300 break-all mb-3">${escapeHtml(d.content_sha256)}</p>` : ''}
    ${d.chain ? `<p class="text-xs mb-4 ${d.chain.ok ? 'text-green-300' : 'text-red-300'}">Audit chain ${d.chain.ok ? 'intact' : 'BROKEN'} · ${d.chain.events} events · head ${escapeHtml(shortHash(d.chain.head))}</p>` : ''}
    ${d.seal ? `<p class="text-xs text-gray-500 mb-4">Seal: ${d.seal.sealed ? 'PAdES' : 'none'}${d.seal.timestamped ? ' + RFC 3161 timestamp' : ''}${d.seal.self_signed ? ' (self-signed certificate)' : ''}</p>` : ''}
    ${d.void_reason ? `<p class="text-xs text-red-300 mb-4">Voided: ${escapeHtml(d.void_reason)}</p>` : ''}
    <h3 class="text-sm font-semibold text-gray-300 mb-1">Recipients</h3>
    <ul class="divide-y divide-gray-700 mb-4">${recipients}</ul>
    <div class="flex flex-wrap gap-2 mb-4">
      <button id="act-download" class="px-3 py-1.5 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 text-white">Download ${d.status === 'executed' ? 'sealed PDF' : 'current draft'}</button>
      <button id="act-verify" class="px-3 py-1.5 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 text-white">Verify integrity</button>
      ${canResend ? '<button id="act-resend" class="px-3 py-1.5 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 text-white">Resend (new link)</button>' : ''}
      ${canVoid ? '<button id="act-void" class="px-3 py-1.5 rounded text-xs font-medium border border-red-500/50 text-red-300 hover:bg-red-500/10">Void</button>' : ''}
    </div>
    <div id="verify-report" class="hidden text-xs bg-gray-900/60 border border-gray-700 rounded p-3 mb-4 font-mono whitespace-pre-wrap"></div>
    <h3 class="text-sm font-semibold text-gray-300 mb-1">Audit trail (newest first)</h3>
    <ul class="divide-y divide-gray-700/60 max-h-72 overflow-y-auto">${events}</ul>`;

  document
    .getElementById('act-download')
    ?.addEventListener('click', () => void downloadDoc(d.id));
  document
    .getElementById('act-verify')
    ?.addEventListener('click', () => void verifyDoc(d.id));
  document
    .getElementById('act-resend')
    ?.addEventListener('click', () => void resendDoc(d.id));
  document
    .getElementById('act-void')
    ?.addEventListener('click', () => void voidDoc(d.id));
  if (runVerify) await verifyDoc(d.id);
  await loadDocuments();
}

async function downloadDoc(id: string): Promise<void> {
  await refreshAuthHeaders();
  const res = await signApiBlob(
    `/api/sign/documents/${encodeURIComponent(id)}/download`,
    { headers: authHeaders }
  );
  if (!res.ok || !res.blob) {
    toast.error(res.error?.message || 'Download failed');
    return;
  }
  downloadFile(res.blob, res.filename || 'document.pdf');
}

async function verifyDoc(id: string): Promise<void> {
  const box = document.getElementById('verify-report');
  if (!box) return;
  box.classList.remove('hidden');
  box.textContent = 'Verifying…';
  const res = await api<Record<string, unknown>>(
    `/api/sign/documents/${encodeURIComponent(id)}/verify`
  );
  if (!res.ok || !res.data) {
    box.textContent = res.error?.message || 'Verification failed.';
    return;
  }
  const r = res.data as { ok: boolean };
  box.className = `text-xs rounded p-3 mb-4 font-mono whitespace-pre-wrap border ${r.ok ? 'bg-green-500/10 border-green-500/40 text-green-200' : 'bg-red-500/10 border-red-500/40 text-red-200'}`;
  box.textContent = JSON.stringify(res.data, null, 2);
}

async function resendDoc(id: string): Promise<void> {
  if (
    !confirm(
      'Issue a fresh signing link and email it again? The previous link stops working immediately.'
    )
  )
    return;
  const res = await api<DocumentView>(
    `/api/sign/documents/${encodeURIComponent(id)}/resend`,
    { body: {} }
  );
  if (!res.ok || !res.data) {
    toast.error(res.error?.message || 'Resend failed');
    return;
  }
  toast.success('Invitation resent');
  if (res.data.dev_links) renderSendResult(res.data);
  await openDetail(id);
}

async function voidDoc(id: string): Promise<void> {
  const reason = prompt(
    'Void this document? The signing link will return 410. Reason (optional):'
  );
  if (reason === null) return;
  const res = await api<DocumentView>(
    `/api/sign/documents/${encodeURIComponent(id)}/void`,
    { body: { reason } }
  );
  if (!res.ok) {
    toast.error(res.error?.message || 'Void failed');
    return;
  }
  toast.success('Document voided');
  await openDetail(id);
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------

function wireEvents(): void {
  el('template').addEventListener('change', renderFields);
  el('btn-preview').addEventListener('click', () => void preview());
  el('btn-send').addEventListener('click', () => void send());
  el('btn-refresh').addEventListener('click', () => void loadDocuments());
  el('auth-sign-in').addEventListener('click', () =>
    document.getElementById('login-btn')?.click()
  );
  el('auth-admin-save').addEventListener('click', () => {
    const t = el<HTMLInputElement>('auth-admin-token').value.trim();
    if (!t) return;
    try {
      sessionStorage.setItem(ADMIN_KEY, t);
    } catch {
      /* ignore */
    }
    authHeaders = { 'X-Admin-Token': t };
    void openConsole();
  });
  el<HTMLInputElement>('auth-admin-token').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el('auth-admin-save').click();
  });
  const closePreview = () => {
    el('preview-modal').classList.add('hidden');
    const frame = el<HTMLIFrameElement>('preview-frame');
    if (frame.src.startsWith('blob:')) URL.revokeObjectURL(frame.src);
    frame.src = 'about:blank';
  };
  el('preview-close').addEventListener('click', closePreview);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('preview-modal').classList.contains('hidden'))
      closePreview();
  });
}
