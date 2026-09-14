/**
 * ChampPDF Sign: the admin portal (/sign-admin.html).
 *
 * Clerk-gated for admins and legal when the build has
 * VITE_CLERK_PUBLISHABLE_KEY; otherwise it falls back to the backend admin
 * token so the portal can be exercised locally. Shows everything the sender
 * console deliberately hides: every document and recipient, the full
 * hash-chained audit log, geo context for each recorded IP (MaxMind), the
 * templates access-control switch, and the send-outs still awaiting a
 * signature so they can be re-sent.
 */

import { createIcons, icons } from 'lucide';
import {
  clerkEnabled,
  getClerkSessionToken,
} from '../components/clerk-auth.js';
import { toast } from '../utils/toast.js';
import {
  escapeHtml,
  formatDateTime,
  shortHash,
  signApi,
  statusChip,
} from '../utils/sign-api.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Geo {
  provider: string;
  is_private?: boolean;
  ip?: string | null;
  country_code?: string;
  country?: string;
  region?: string;
  city?: string;
  asn?: number;
  isp?: string;
  time_zone?: string;
}

interface RecipientAdmin {
  id: string;
  role: string;
  name: string;
  email: string;
  designation: string | null;
  status: string;
  viewed_at: string | null;
  signed_at: string | null;
  ip?: string | null;
  user_agent?: string | null;
  geo?: Geo;
}

interface AdminDoc {
  id: string;
  title: string;
  status: string;
  template_id: string;
  template_version: number;
  counterparty_entity: string;
  sender: { email: string | null; name: string | null };
  expires_at: string;
  created_at: string;
  sent_at: string | null;
  executed_at: string | null;
  days_to_expiry: number | null;
  needs_resend: boolean;
  recipients: RecipientAdmin[];
  events?: AdminEvent[];
  chain?: { ok: boolean; events: number; head: string };
}

interface AdminEvent {
  id: number;
  event_type: string;
  occurred_at: string;
  recipient_id: string | null;
  actor_email: string | null;
  ip_address: string | null;
  user_agent?: string | null;
  metadata?: Record<string, unknown> | null;
  geo?: Geo;
  event_hash?: string;
}

interface NeedsResendItem {
  id: string;
  title: string;
  status: string;
  template_id: string;
  sender: { name: string | null; email: string | null };
  sent_at: string;
  expires_at: string;
  days_since_sent: number | null;
  days_to_expiry: number | null;
  overdue: boolean;
  last_activity_at: string | null;
  pending: RecipientAdmin[];
}

interface TemplateAdmin {
  id: string;
  name: string;
  version: number;
  category: string;
  instrument_class: string;
  description: string;
  source: string;
  is_active: boolean;
  approved_by?: string | null;
  updated_at?: string | null;
  used: number;
  fields: { key: string; label: string; required: boolean }[];
}

interface Summary {
  role: string;
  documents: { total: number; by_status: Record<string, number> };
  recipients: { total: number; pending: number; signed: number };
  templates: { total: number; active: number; inactive: number };
  outstanding: { needs_resend: number };
  geo: { provider: string };
  now: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ADMIN_KEY = 'champdf:sign:admin-token';
let authHeaders: Record<string, string> = {};
let authMode: 'clerk' | 'admin' | null = null;

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

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

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
  wireTabs();
  await loadStatus();
  await authenticate();
}

async function loadStatus(): Promise<void> {
  const res = await signApi<{ enabled: boolean; provider: { name: string } }>(
    '/api/sign/status'
  );
  const box = el('sign-status');
  if (!res.ok || !res.data) {
    box.innerHTML = '<span class="text-red-300">Backend unreachable</span>';
    return;
  }
  const s = res.data;
  box.innerHTML = `<span>engine <b class="text-gray-300">${escapeHtml(
    s.provider.name
  )}</b></span><span>${s.enabled ? '' : '<span class="text-red-300">signing disabled here</span>'}</span>`;
}

async function authenticate(): Promise<void> {
  el('auth-gate').classList.remove('hidden');
  if (clerkEnabled()) {
    authMode = 'clerk';
    el('auth-clerk').classList.remove('hidden');
    const tryOpen = async (): Promise<boolean> => {
      const t = await getClerkSessionToken();
      if (!t) return false;
      authHeaders = { Authorization: `Bearer ${t}` };
      return openPortal();
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
    await openPortal();
  }
}

async function openPortal(): Promise<boolean> {
  feedback('auth-feedback', null);
  const res = await api<{ role: string }>('/api/sign/admin/templates');
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
  el('auth-gate').classList.add('hidden');
  el('portal').classList.remove('hidden');
  el('role-chip').textContent = `role: ${res.data.role}`;
  await Promise.all([
    loadDashboard(),
    loadDocuments(),
    loadNeedsResend(),
    loadTemplates(),
    loadAudit(),
  ]);
  const tab = new URLSearchParams(window.location.search).get('tab');
  if (tab) switchTab(tab);
  return true;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function wireTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab || 'dashboard'));
  });
  el('doc-search').addEventListener('input', debounce(loadDocuments, 250));
  el('doc-status').addEventListener('change', loadDocuments);
}

function switchTab(name: string): void {
  document.querySelectorAll<HTMLElement>('.tab-panel').forEach((p) => {
    p.classList.add('hidden');
  });
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((b) => {
    b.classList.remove('bg-orange-600', 'text-white');
  });
  const panel = el(`tab-${name}`);
  if (panel) panel.classList.remove('hidden');
  const btn = document.querySelector<HTMLButtonElement>(`[data-tab="${name}"]`);
  if (btn) btn.classList.add('bg-orange-600', 'text-white');
}

function debounce(fn: () => void | Promise<void>, ms: number): () => void {
  let t: number | undefined;
  return () => {
    window.clearTimeout(t);
    t = window.setTimeout(() => void fn(), ms);
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function loadDashboard(): Promise<void> {
  const res = await api<Summary>('/api/sign/admin/summary');
  if (!res.ok || !res.data) {
    feedback('dashboard-geo', res.error?.message || 'Failed to load summary');
    return;
  }
  const s = res.data;
  const cards: [string, string, string][] = [
    ['Documents', String(s.documents.total), 'text-white'],
    ['Pending signatures', String(s.recipients.pending), 'text-amber-300'],
    ['Signed', String(s.recipients.signed), 'text-green-300'],
    [
      'Templates active',
      `${s.templates.active}/${s.templates.total}`,
      'text-orange-300',
    ],
    ['Needs resend', String(s.outstanding.needs_resend), 'text-red-300'],
  ];
  el('dashboard-stats').innerHTML = cards
    .map(
      ([label, value, color]) =>
        `<div class="bg-gray-800 border border-gray-700 rounded-xl p-5">
           <p class="text-gray-400 text-xs uppercase tracking-wide">${label}</p>
           <p class="text-3xl font-bold mt-1 ${color}">${escapeHtml(value)}</p>
         </div>`
    )
    .join('');

  const statuses = s.documents.by_status;
  const order = [
    'draft',
    'sent',
    'viewed',
    'signed',
    'countersigned',
    'executed',
    'voided',
    'expired',
  ];
  el('dashboard-status-breakdown').innerHTML = `
    <p class="text-gray-400 text-xs uppercase tracking-wide mb-2">By status</p>
    <div class="flex flex-wrap gap-2">
      ${
        order
          .filter((k) => statuses[k])
          .map(
            (k) =>
              `<span class="inline-flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm">${statusChip(k)} <b>${statuses[k]}</b></span>`
          )
          .join('') ||
        '<span class="text-gray-500 text-sm">No documents yet.</span>'
      }
    </div>`;

  el('dashboard-outstanding').innerHTML = `
    <p class="text-gray-400 text-xs uppercase tracking-wide mb-2">Send-outs still awaiting a signature</p>
    <p class="text-sm text-gray-300">
      ${s.outstanding.needs_resend} document${s.outstanding.needs_resend === 1 ? '' : 's'} need attention.
      <button id="dash-to-resend" class="text-orange-400 hover:text-orange-300 font-medium ml-2">Open needs resend</button>
    </p>`;
  el('dash-to-resend').addEventListener('click', () =>
    switchTab('needs-resend')
  );

  el('dashboard-geo').textContent =
    s.geo.provider === 'maxmind'
      ? 'IP geo context: MaxMind GeoIP2 is configured.'
      : 'IP geo context: MaxMind not configured. Set MAXMIND_DB_PATH to enrich recorded IPs. Raw IPs still appear for every event.';
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

async function loadDocuments(): Promise<void> {
  const q = (el<HTMLInputElement>('doc-search').value || '').trim();
  const status = el<HTMLSelectElement>('doc-status').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  params.set('limit', '200');
  const res = await api<{ documents: AdminDoc[] }>(
    `/api/sign/admin/documents?${params.toString()}`
  );
  const box = el('documents-table');
  if (!res.ok || !res.data) {
    box.innerHTML = `<p class="text-red-300">${escapeHtml(
      res.error?.message || 'Failed to load documents.'
    )}</p>`;
    return;
  }
  const docs = res.data.documents;
  if (!docs.length) {
    box.innerHTML = '<p class="text-gray-500 text-sm">No documents match.</p>';
    return;
  }
  box.innerHTML = `
    <table class="w-full text-sm">
      <thead>
        <tr class="text-left text-gray-400 text-xs uppercase tracking-wide border-b border-gray-700">
          <th class="py-2 pr-3">Title</th>
          <th class="py-2 pr-3">Status</th>
          <th class="py-2 pr-3">Sender</th>
          <th class="py-2 pr-3">Recipients</th>
          <th class="py-2 pr-3">Expiry</th>
          <th class="py-2 pr-3"></th>
        </tr>
      </thead>
      <tbody>
        ${docs
          .map((d) => {
            const rec = d.recipients
              .filter((r) => r.role !== 'cc')
              .map(
                (r) =>
                  `${escapeHtml(r.name)} <span class="text-gray-500">${escapeHtml(
                    r.status
                  )}</span>`
              )
              .join(', ');
            return `<tr class="border-b border-gray-800 align-top">
              <td class="py-3 pr-3"><p class="text-white font-medium">${escapeHtml(
                d.title
              )}</p><p class="text-gray-500 text-xs">${escapeHtml(d.template_id)} v${d.template_version}</p></td>
              <td class="py-3 pr-3">${statusChip(d.status)}</td>
              <td class="py-3 pr-3 text-gray-300">${escapeHtml(
                d.sender.name || d.sender.email || '-'
              )}</td>
              <td class="py-3 pr-3 text-gray-300">${rec}</td>
              <td class="py-3 pr-3 text-gray-400 whitespace-nowrap">${formatDateTime(
                d.expires_at
              )}</td>
              <td class="py-3 pr-3"><button data-doc="${d.id}" class="view-doc text-orange-400 hover:text-orange-300 font-medium">View</button></td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>`;
  box.querySelectorAll<HTMLButtonElement>('.view-doc').forEach((b) => {
    b.addEventListener('click', () => void openDocDetail(b.dataset.doc || ''));
  });
}

async function openDocDetail(id: string): Promise<void> {
  const res = await api<AdminDoc>(`/api/sign/admin/documents/${id}`);
  const box = el('doc-detail');
  if (!res.ok || !res.data) {
    box.innerHTML = `<p class="text-red-300">${escapeHtml(
      res.error?.message || 'Failed to load document.'
    )}</p>`;
    box.classList.remove('hidden');
    return;
  }
  const d = res.data;
  const meta: [string, unknown][] = [
    ['Status', d.status],
    ['Template', `${d.template_id} v${d.template_version}`],
    ['Counterparty', d.counterparty_entity],
    ['Created', formatDateTime(d.created_at)],
    ['Sent', formatDateTime(d.sent_at)],
    ['Executed', formatDateTime(d.executed_at)],
    ['Expires', formatDateTime(d.expires_at)],
  ];
  box.innerHTML = `
    <div class="bg-gray-800 border border-gray-700 rounded-xl p-6">
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 class="text-xl font-bold text-white">${escapeHtml(d.title)}</h2>
        <span>${statusChip(d.status)}</span>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-6">
        ${meta
          .filter(([, v]) => v !== null && v !== undefined && v !== '')
          .map(
            ([k, v]) =>
              `<div><p class="text-gray-500 text-xs uppercase">${k}</p><p class="text-gray-200">${escapeHtml(
                String(v)
              )}</p></div>`
          )
          .join('')}
      </div>
      <p class="text-gray-400 text-xs uppercase tracking-wide mb-2">Recipients</p>
      <div class="overflow-x-auto mb-6">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-gray-400 text-xs uppercase border-b border-gray-700">
            <th class="py-2 pr-3">Role</th><th class="py-2 pr-3">Name</th>
            <th class="py-2 pr-3">Email</th><th class="py-2 pr-3">Status</th>
            <th class="py-2 pr-3">Signed at</th><th class="py-2 pr-3">Signing IP / geo</th>
          </tr></thead>
          <tbody>${d.recipients
            .map(
              (r) => `<tr class="border-b border-gray-800 align-top">
                <td class="py-2 pr-3 text-gray-400">${escapeHtml(r.role)}</td>
                <td class="py-2 pr-3 text-gray-200">${escapeHtml(r.name)}</td>
                <td class="py-2 pr-3 text-gray-300">${escapeHtml(r.email)}</td>
                <td class="py-2 pr-3">${statusChip(r.status)}</td>
                <td class="py-2 pr-3 text-gray-400 whitespace-nowrap">${formatDateTime(
                  r.signed_at
                )}</td>
                <td class="py-2 pr-3 text-gray-400">${escapeHtml(
                  r.ip || '-'
                )} ${r.geo ? geoLabel(r.geo) : ''}</td>
              </tr>`
            )
            .join('')}
          </tbody>
        </table>
      </div>
      <div class="flex flex-wrap gap-2 mb-4">
        ${d.template_id ? '' : ''}
        <button id="resend-${d.id}" class="resend-doc bg-orange-600 hover:bg-orange-500 text-white font-medium px-4 py-2 rounded-lg" data-doc="${d.id}">Resend invitation</button>
      </div>
      <p class="text-gray-400 text-xs uppercase tracking-wide mb-2">Audit events</p>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-gray-400 text-xs uppercase border-b border-gray-700">
            <th class="py-2 pr-3">Event</th><th class="py-2 pr-3">When</th>
            <th class="py-2 pr-3">Actor</th><th class="py-2 pr-3">IP / geo</th><th class="py-2 pr-3">Hash</th>
          </tr></thead>
          <tbody>${(d.events || [])
            .map(
              (e) => `<tr class="border-b border-gray-800 align-top">
                <td class="py-2 pr-3 text-gray-200">${escapeHtml(e.event_type)}</td>
                <td class="py-2 pr-3 text-gray-400 whitespace-nowrap">${formatDateTime(
                  e.occurred_at
                )}</td>
                <td class="py-2 pr-3 text-gray-300">${escapeHtml(
                  e.actor_email || '-'
                )}</td>
                <td class="py-2 pr-3 text-gray-400">${escapeHtml(e.ip_address || '-')} ${e.geo ? geoLabel(e.geo) : ''}</td>
                <td class="py-2 pr-3 text-gray-500">${shortHash(e.event_hash)}</td>
              </tr>`
            )
            .join('')}
          </tbody>
        </table>
      </div>
      <p class="text-gray-500 text-xs mt-4">Audit chain: ${
        d.chain?.ok ? 'intact' : d.chain ? 'BROKEN' : 'unverified'
      } (${d.chain?.events ?? 0} events). Head ${shortHash(d.chain?.head)}</p>
    </div>`;
  box.classList.remove('hidden');
  box
    .querySelectorAll<HTMLButtonElement>('.resend-doc')
    .forEach((b) =>
      b.addEventListener('click', () => void resendDoc(b.dataset.doc || ''))
    );
}

// ---------------------------------------------------------------------------
// Needs resend
// ---------------------------------------------------------------------------

async function loadNeedsResend(): Promise<void> {
  const res = await api<{ items: NeedsResendItem[] }>(
    '/api/sign/admin/needs-resend'
  );
  const box = el('needs-resend-list');
  const badge = el('needs-resend-badge');
  if (!res.ok || !res.data) {
    box.innerHTML = `<p class="text-red-300">${escapeHtml(
      res.error?.message || 'Failed to load.'
    )}</p>`;
    return;
  }
  const items = res.data.items;
  badge.textContent = String(items.length);
  if (!items.length) {
    box.innerHTML =
      '<p class="text-gray-500 text-sm">Nothing awaiting a signature. All send-outs are signed or settled.</p>';
    return;
  }
  box.innerHTML = items
    .map(
      (it) => `
      <div class="bg-gray-800 border ${it.overdue ? 'border-red-500/40' : 'border-gray-700'} rounded-xl p-5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="text-white font-medium">${escapeHtml(it.title)}</p>
            <p class="text-gray-500 text-xs">${escapeHtml(it.template_id)} • sent to ${escapeHtml(
              it.sender.name || it.sender.email || '?'
            )} on ${formatDateTime(it.sent_at)}</p>
          </div>
          <div class="flex items-center gap-2">
            ${it.overdue ? '<span class="text-red-400 text-xs font-bold">OVERDUE</span>' : ''}
            ${statusChip(it.status)}
          </div>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mt-4">
          <div><p class="text-gray-500 text-xs uppercase">Days since sent</p><p class="text-gray-200">${it.days_since_sent ?? '-'}</p></div>
          <div><p class="text-gray-500 text-xs uppercase">Days to expiry</p><p class="${it.days_to_expiry !== null && it.days_to_expiry < 0 ? 'text-red-300' : 'text-gray-200'}">${it.days_to_expiry ?? '-'}</p></div>
          <div><p class="text-gray-500 text-xs uppercase">Last activity</p><p class="text-gray-200">${formatDateTime(it.last_activity_at)}</p></div>
          <div><p class="text-gray-500 text-xs uppercase">Expires</p><p class="text-gray-200">${formatDateTime(it.expires_at)}</p></div>
        </div>
        <div class="mt-4 flex flex-wrap items-center gap-2">
          ${it.pending
            .map((r) => {
              const seen = r.viewed_at ? 'viewed' : 'not opened';
              return `<span class="inline-flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-300">
                ${escapeHtml(r.name)} <span class="text-gray-500">(${seen})</span>
              </span>`;
            })
            .join('')}
          <button data-doc="${it.id}" class="resend-doc ml-auto bg-orange-600 hover:bg-orange-500 text-white font-medium px-4 py-2 rounded-lg">Resend</button>
          <button data-doc="${it.id}" class="view-doc text-orange-400 hover:text-orange-300 font-medium">View</button>
        </div>
      </div>`
    )
    .join('');
  box
    .querySelectorAll<HTMLButtonElement>('.resend-doc')
    .forEach((b) =>
      b.addEventListener('click', () => void resendDoc(b.dataset.doc || ''))
    );
  box
    .querySelectorAll<HTMLButtonElement>('.view-doc')
    .forEach((b) =>
      b.addEventListener('click', () => void openDocDetail(b.dataset.doc || ''))
    );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

async function loadTemplates(): Promise<void> {
  const res = await api<{ templates: TemplateAdmin[] }>(
    '/api/sign/admin/templates'
  );
  const box = el('templates-table');
  if (!res.ok || !res.data) {
    box.innerHTML = `<p class="text-red-300">${escapeHtml(
      res.error?.message || 'Failed to load templates.'
    )}</p>`;
    return;
  }
  const ts = res.data.templates;
  box.innerHTML = `
    <table class="w-full text-sm">
      <thead><tr class="text-left text-gray-400 text-xs uppercase tracking-wide border-b border-gray-700">
        <th class="py-2 pr-3">Template</th><th class="py-2 pr-3">Access</th>
        <th class="py-2 pr-3">Used</th><th class="py-2 pr-3">Approved by</th>
        <th class="py-2 pr-3">Updated</th><th class="py-2 pr-3"></th>
      </tr></thead>
      <tbody>${ts
        .map(
          (t) => `<tr class="border-b border-gray-800 align-top">
            <td class="py-3 pr-3"><p class="text-white font-medium">${escapeHtml(t.name)}</p>
              <p class="text-gray-500 text-xs">${escapeHtml(t.id)} v${t.version}</p></td>
            <td class="py-3 pr-3">${t.is_active ? '<span class="text-green-300 font-semibold">Active</span>' : '<span class="text-amber-300 font-semibold">Inactive</span>'}</td>
            <td class="py-3 pr-3 text-gray-300">${t.used}</td>
            <td class="py-3 pr-3 text-gray-400">${escapeHtml(t.approved_by || '-')}</td>
            <td class="py-3 pr-3 text-gray-400">${formatDateTime(t.updated_at)}</td>
            <td class="py-3 pr-3">${
              t.is_active
                ? `<button data-tpl="${t.id}" class="deactivate bg-red-500/15 hover:bg-red-500/25 text-red-300 font-medium px-3 py-1.5 rounded-lg">Deactivate</button>`
                : `<button data-tpl="${t.id}" class="activate bg-green-500/15 hover:bg-green-500/25 text-green-300 font-medium px-3 py-1.5 rounded-lg">Activate</button>`
            }</td>
          </tr>`
        )
        .join('')}
      </tbody>
    </table>`;
  box
    .querySelectorAll<HTMLButtonElement>('.activate')
    .forEach((b) =>
      b.addEventListener(
        'click',
        () => void toggleTemplate(b.dataset.tpl || '', true)
      )
    );
  box
    .querySelectorAll<HTMLButtonElement>('.deactivate')
    .forEach((b) =>
      b.addEventListener(
        'click',
        () => void toggleTemplate(b.dataset.tpl || '', false)
      )
    );
}

async function toggleTemplate(id: string, active: boolean): Promise<void> {
  const res = await api<{ template_id: string; is_active: boolean }>(
    `/api/sign/admin/templates/${id}/${active ? 'activate' : 'deactivate'}`,
    { method: 'POST' }
  );
  if (!res.ok) {
    toast.error(res.error?.message || 'Could not update template.');
    return;
  }
  toast.success(
    `Template ${res.data?.template_id} ${active ? 'activated' : 'deactivated'}.`
  );
  await loadTemplates();
  await loadDashboard();
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

async function loadAudit(): Promise<void> {
  const res = await api<{ events: AdminEvent[] }>(
    '/api/sign/admin/events?limit=100'
  );
  const box = el('audit-table');
  if (!res.ok || !res.data) {
    box.innerHTML = `<p class="text-red-300">${escapeHtml(
      res.error?.message || 'Failed to load audit log.'
    )}</p>`;
    return;
  }
  const evs = res.data.events;
  if (!evs.length) {
    box.innerHTML = '<p class="text-gray-500 text-sm">No audit events yet.</p>';
    return;
  }
  box.innerHTML = `
    <table class="w-full text-sm">
      <thead><tr class="text-left text-gray-400 text-xs uppercase tracking-wide border-b border-gray-700">
        <th class="py-2 pr-3">Event</th><th class="py-2 pr-3">When</th>
        <th class="py-2 pr-3">Actor</th><th class="py-2 pr-3">IP / geo</th><th class="py-2 pr-3">User agent</th>
      </tr></thead>
      <tbody>${evs
        .map(
          (e) => `<tr class="border-b border-gray-800 align-top">
            <td class="py-2 pr-3 text-gray-200">${escapeHtml(e.event_type)}</td>
            <td class="py-2 pr-3 text-gray-400 whitespace-nowrap">${formatDateTime(e.occurred_at)}</td>
            <td class="py-2 pr-3 text-gray-300">${escapeHtml(e.actor_email || '-')}</td>
            <td class="py-2 pr-3 text-gray-400">${escapeHtml(e.ip_address || '-')} ${e.geo ? geoLabel(e.geo) : ''}</td>
            <td class="py-2 pr-3 text-gray-500 max-w-[240px] truncate">${escapeHtml(e.user_agent || '-')}</td>
          </tr>`
        )
        .join('')}
      </tbody>
    </table>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function resendDoc(id: string): Promise<void> {
  const res = await api<{ id: string }>(`/api/sign/documents/${id}/resend`, {
    method: 'POST',
  });
  if (!res.ok) {
    toast.error(res.error?.message || 'Could not resend.');
    return;
  }
  toast.success('Invitation resent. The old link is now invalid.');
  await Promise.all([loadNeedsResend(), loadDocuments(), loadDashboard()]);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function geoLabel(g: Geo): string {
  if (g.is_private) {
    return '<span class="text-gray-600">private</span>';
  }
  if (g.provider !== 'maxmind') return '';
  const parts: string[] = [];
  if (g.country) parts.push(g.country);
  if (g.city) parts.push(g.city);
  const loc = parts.length ? parts.join(', ') : g.country_code || '';
  const net = g.isp ? `${g.isp}` : g.asn !== undefined ? `AS${g.asn}` : '';
  const inner = [loc, net].filter(Boolean).join(' · ');
  if (!inner) return '';
  return `<span class="text-teal-300/80">(${escapeHtml(inner)})</span>`;
}
