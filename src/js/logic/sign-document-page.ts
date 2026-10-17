/**
 * ChampPDF Sign: the signer's page (/s/<token>).
 *
 * landing -> OTP -> read (scroll gate) -> sign (type / draw) -> done.
 * The token in the URL only grants the right to request a code; every step
 * after that carries the signer session the backend minted on verification.
 */

// The legacy build carries pdf.js's own polyfills. External signers open this
// page on whatever phone or corporate browser they have; the modern build
// assumes features (e.g. Map.prototype.getOrInsertComputed) that older
// engines lack and then fails to render at all.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import '@fontsource/great-vibes';
import { downloadFile } from '../utils/helpers.js';
import {
  clearSession,
  escapeHtml,
  formatDateTime,
  loadSession,
  parseSigningToken,
  saveSession,
  signApi,
  signApiBlob,
  type ApiErrorDetail,
} from '../utils/sign-api.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

interface Landing {
  document: {
    id: string;
    title: string;
    status: string;
    entity: string;
    counterparty_entity: string;
    sender_name: string | null;
    expires_at: string;
    page_count: number | null;
    executed_at: string | null;
  };
  recipient: {
    id: string;
    name: string;
    role: string;
    email_masked: string;
    designation: string | null;
    status: string;
    otp_verified: boolean;
    scrolled_to_end: boolean;
    signed_at: string | null;
  };
  provider: {
    name: string;
    hosted_signing: boolean;
    signing_url: string | null;
  };
  next: 'otp' | 'view' | 'done' | 'awaiting_others';
}

type State =
  | 'loading'
  | 'error'
  | 'landing'
  | 'otp'
  | 'view'
  | 'sign'
  | 'hosted'
  | 'done';

const STATES: State[] = [
  'loading',
  'error',
  'landing',
  'otp',
  'view',
  'sign',
  'hosted',
  'done',
];

let token = '';
let session: string | null = null;
let landing: Landing | null = null;
let scrolledToEnd = false;
let pdfLoaded = false;
let signatureKind: 'typed' | 'drawn' = 'typed';
let resendTimer: number | null = null;
let doneHash: string | null = null;

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

function show(state: State): void {
  for (const s of STATES)
    el(`state-${s}`).classList.toggle('hidden', s !== state);
  window.scrollTo({ top: 0 });
}

function feedback(id: string, message: string | null): void {
  const node = el(id);
  node.textContent = message || '';
  node.classList.toggle('hidden', !message);
}

function api<T>(
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown } = {}
) {
  return signApi<T>(`/api/sign/s/${token}${path}`, { ...opts, session });
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
  const parsed = parseSigningToken(
    window.location.pathname,
    window.location.search
  );
  if (!parsed) {
    renderError({
      code: 'not_found',
      message: 'This signing link is not valid.',
    });
    return;
  }
  token = parsed;
  session = loadSession(token);
  wireEvents();
  await refreshLanding();
}

async function refreshLanding(): Promise<void> {
  const res = await api<Landing>('');
  if (!res.ok || !res.data) {
    if (res.error?.code === 'session_invalid') {
      session = null;
      clearSession(token);
      return refreshLanding();
    }
    renderError(res.error);
    return;
  }
  landing = res.data;
  el('hdr-entity').textContent =
    `${landing.document.entity} · ${landing.document.counterparty_entity}`;
  route();
}

function route(): void {
  if (!landing) return;
  switch (landing.next) {
    case 'otp':
      renderLanding();
      break;
    case 'view':
      if (landing.provider.hosted_signing && landing.provider.signing_url) {
        el<HTMLIFrameElement>('hosted-frame').src =
          landing.provider.signing_url;
        show('hosted');
      } else if (landing.recipient.status === 'signed') {
        renderDone();
      } else {
        void openViewer();
      }
      break;
    case 'awaiting_others':
    case 'done':
    default:
      renderDone();
  }
}

// --------------------------------------------------------------------------
// Error and landing
// --------------------------------------------------------------------------

function renderError(err: ApiErrorDetail | null): void {
  const code = err?.code || 'error';
  const titles: Record<string, string> = {
    not_found: 'This link is not valid',
    expired: 'This link has expired',
    voided: 'This document was withdrawn',
    locked: 'This link is locked',
    rate_limited: 'Slow down a little',
    sign_disabled: 'Signing is not available',
    http_0: 'We could not reach the server',
  };
  const hints: Record<string, string> = {
    expired:
      'Ask the sender to resend the document. A fresh link will arrive by email.',
    voided: 'If you were expecting to sign, contact the sender directly.',
    locked:
      'Too many incorrect codes were entered. The sender has been notified and can resend a new link.',
    not_found:
      'Check that you opened the complete link from the invitation email.',
    rate_limited: 'Try again in a few minutes.',
  };
  el('error-title').textContent = titles[code] || 'Something went wrong';
  el('error-message').textContent = err?.message || '';
  el('error-hint').textContent = hints[code] || '';
  show('error');
}

function renderLanding(): void {
  if (!landing) return;
  const d = landing.document;
  const r = landing.recipient;
  el('doc-title').textContent = d.title;
  el('sender-name').textContent = d.sender_name || 'A colleague';
  el('entity-name').textContent = d.entity;
  el('recipient-name').textContent = r.name;
  el('recipient-designation').textContent = r.designation || '';
  el('expires-at').textContent = formatDateTime(d.expires_at);
  el('page-count').textContent = d.page_count ? `${d.page_count} pages` : '-';
  el('masked-email').textContent = r.email_masked;
  show('landing');
}

async function requestCode(): Promise<void> {
  const btn = el<HTMLButtonElement>('btn-send-code');
  btn.disabled = true;
  feedback('landing-feedback', null);
  const res = await api<{ sent_to: string; expires_in: number }>('/otp', {
    method: 'POST',
  });
  btn.disabled = false;
  if (!res.ok || !res.data) {
    if (
      res.error &&
      ['voided', 'expired', 'locked', 'not_found'].includes(res.error.code)
    ) {
      renderError(res.error);
    } else {
      feedback(
        'landing-feedback',
        res.error?.message || 'Could not send the code.'
      );
    }
    return;
  }
  el('otp-sent-to').textContent = res.data.sent_to;
  feedback('otp-feedback', null);
  el<HTMLInputElement>('otp-code').value = '';
  startResendCooldown(30);
  show('otp');
  el<HTMLInputElement>('otp-code').focus();
}

function startResendCooldown(seconds: number): void {
  const btn = el<HTMLButtonElement>('btn-resend-code');
  let left = seconds;
  btn.disabled = true;
  btn.textContent = `Send a new code (${left}s)`;
  if (resendTimer) window.clearInterval(resendTimer);
  resendTimer = window.setInterval(() => {
    left -= 1;
    if (left <= 0) {
      if (resendTimer) window.clearInterval(resendTimer);
      resendTimer = null;
      btn.disabled = false;
      btn.textContent = 'Send a new code';
    } else {
      btn.textContent = `Send a new code (${left}s)`;
    }
  }, 1000);
}

async function verifyCode(): Promise<void> {
  const input = el<HTMLInputElement>('otp-code');
  const code = input.value.replace(/\D/g, '');
  if (code.length !== 6) {
    feedback('otp-feedback', 'Enter the six digits from the email.');
    return;
  }
  const btn = el<HTMLButtonElement>('btn-verify');
  btn.disabled = true;
  feedback('otp-feedback', null);
  const res = await api<{
    session_token: string;
    next: Landing['next'];
    signing_url: string | null;
  }>('/otp/verify', { method: 'POST', body: { code } });
  btn.disabled = false;
  if (!res.ok || !res.data) {
    if (
      res.error?.code === 'locked' ||
      res.error?.code === 'voided' ||
      res.error?.code === 'expired'
    ) {
      renderError(res.error);
      return;
    }
    feedback('otp-feedback', res.error?.message || 'That code did not work.');
    input.select();
    return;
  }
  session = res.data.session_token;
  saveSession(token, session);
  await refreshLanding();
}

// --------------------------------------------------------------------------
// Viewer with the read gate
// --------------------------------------------------------------------------

async function openViewer(): Promise<void> {
  if (!landing) return;
  el('view-title').textContent = landing.document.title;
  scrolledToEnd = landing.recipient.scrolled_to_end;
  updateReadStatus();
  show('view');
  if (pdfLoaded) return;

  const container = el('pdf-scroll');
  container.innerHTML =
    '<p class="text-gray-400 text-sm">Loading document…</p>';
  const res = await signApiBlob(`/api/sign/s/${token}/document.pdf`, {
    session,
  });
  if (!res.ok || !res.blob) {
    if (res.error?.code === 'session_invalid') {
      session = null;
      clearSession(token);
      await refreshLanding();
      return;
    }
    container.innerHTML = `<p class="text-red-300 text-sm">${escapeHtml(res.error?.message || 'Could not load the document.')}</p>`;
    return;
  }
  const bytes = new Uint8Array(await res.blob.arrayBuffer());
  try {
    await renderPdf(bytes, container);
    pdfLoaded = true;
  } catch (e) {
    container.innerHTML = `<p class="text-red-300 text-sm">Could not render the document: ${escapeHtml((e as Error).message)}</p>`;
  }
}

async function renderPdf(
  bytes: Uint8Array,
  container: HTMLElement
): Promise<void> {
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  container.innerHTML = '';
  const width = Math.min(container.clientWidth - 24, 900);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvases: HTMLCanvasElement[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const viewport = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${viewport.height / dpr}px`;
    canvas.className = 'block mx-auto bg-white shadow';
    canvas.dataset.page = String(i);
    container.appendChild(canvas);
    canvases.push(canvas);
    const ctx = canvas.getContext('2d');
    if (ctx)
      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  }
  el('page-progress').textContent = `Page 1 of ${pdf.numPages}`;

  // A page is usually taller than the scroll box, so "60% of the last page
  // visible" can never happen. Gate on a sentinel after the last page instead,
  // with a plain scroll check as the fallback.
  const sentinel = document.createElement('div');
  sentinel.id = 'pdf-end';
  sentinel.style.height = '1px';
  container.appendChild(sentinel);

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const top = container.scrollTop + container.clientHeight / 3;
      let current = 1;
      for (const c of canvases) {
        if (c.offsetTop <= top) current = Number(c.dataset.page);
      }
      el('page-progress').textContent = `Page ${current} of ${pdf.numPages}`;
      if (
        container.scrollTop + container.clientHeight >=
        container.scrollHeight - 8
      ) {
        void markScrolled();
      }
    });
  };
  container.addEventListener('scroll', onScroll, { passive: true });

  const gate = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        gate.disconnect();
        void markScrolled();
      }
    },
    { root: container, threshold: 0 }
  );
  gate.observe(sentinel);
  onScroll();
}

async function markScrolled(): Promise<void> {
  if (scrolledToEnd) return;
  const res = await api<{ ok: boolean }>('/events', {
    method: 'POST',
    body: { type: 'scrolled_to_end' },
  });
  if (res.ok) {
    scrolledToEnd = true;
    updateReadStatus();
  }
}

function updateReadStatus(): void {
  el<HTMLButtonElement>('btn-open-sign').disabled = !scrolledToEnd;
  el('read-status').textContent = scrolledToEnd
    ? 'You have read to the end. You can sign now.'
    : 'Scroll to the end of the document to enable signing.';
}

// --------------------------------------------------------------------------
// Signature panel
// --------------------------------------------------------------------------

function openSignPanel(): void {
  if (!landing) return;
  const r = landing.recipient;
  const nameInput = el<HTMLInputElement>('sign-name');
  if (!nameInput.value) nameInput.value = r.name;
  const desig = el<HTMLInputElement>('sign-designation');
  if (!desig.value) desig.value = r.designation || '';
  const typed = el<HTMLInputElement>('typed-name');
  if (!typed.value) typed.value = r.name;
  el('typed-preview').textContent = typed.value;
  el('intent-text').innerHTML =
    `I, <b class="text-white">${escapeHtml(nameInput.value || r.name)}</b>, intend to sign this document electronically on behalf of ` +
    `<b class="text-white">${escapeHtml(landing.document.counterparty_entity)}</b>. I understand this electronic signature is legally binding, ` +
    `and I consent to ChampPDF Sign recording my email verification, network address and the time of signing as evidence of execution.`;
  feedback('sign-feedback', null);
  show('sign');
  setKind(signatureKind);
  setupPad();
}

function setKind(kind: 'typed' | 'drawn'): void {
  signatureKind = kind;
  el('panel-typed').classList.toggle('hidden', kind !== 'typed');
  el('panel-drawn').classList.toggle('hidden', kind !== 'drawn');
  const on =
    'px-4 py-2 rounded-lg text-sm font-medium bg-orange-600 text-white';
  const off =
    'px-4 py-2 rounded-lg text-sm font-medium bg-gray-700 text-gray-300 hover:bg-gray-600';
  el('tab-typed').className = kind === 'typed' ? on : off;
  el('tab-drawn').className = kind === 'drawn' ? on : off;
  if (kind === 'drawn') resizePad();
}

// Minimal signature pad: pointer events, DPR-aware, transparent PNG export.
let padCtx: CanvasRenderingContext2D | null = null;
let padStrokes = 0;
let drawing = false;
let padReady = false;

function setupPad(): void {
  if (padReady) return;
  padReady = true;
  const canvas = el<HTMLCanvasElement>('sig-pad');
  padCtx = canvas.getContext('2d');
  const pos = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    return {
      x: (e.clientX - rect.left) * dpr,
      y: (e.clientY - rect.top) * dpr,
    };
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!padCtx) return;
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    padCtx.beginPath();
    padCtx.moveTo(p.x, p.y);
    padCtx.lineTo(p.x + 0.1, p.y + 0.1);
    padCtx.stroke();
    padStrokes += 1;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || !padCtx) return;
    const p = pos(e);
    padCtx.lineTo(p.x, p.y);
    padCtx.stroke();
  });
  const stop = () => {
    drawing = false;
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);
  window.addEventListener('resize', () => {
    if (signatureKind === 'drawn') resizePad();
  });
  resizePad();
}

function resizePad(): void {
  const canvas = el<HTMLCanvasElement>('sig-pad');
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  padCtx = canvas.getContext('2d');
  if (padCtx) {
    padCtx.lineWidth = 2.4 * dpr;
    padCtx.lineCap = 'round';
    padCtx.lineJoin = 'round';
    padCtx.strokeStyle = '#141f61';
  }
  padStrokes = 0;
}

function clearPad(): void {
  const canvas = el<HTMLCanvasElement>('sig-pad');
  padCtx?.clearRect(0, 0, canvas.width, canvas.height);
  padStrokes = 0;
}

async function applySignature(): Promise<void> {
  const name = el<HTMLInputElement>('sign-name').value.trim();
  const designation = el<HTMLInputElement>('sign-designation').value.trim();
  const intent = el<HTMLInputElement>('intent').checked;
  feedback('sign-feedback', null);
  if (name.length < 2) {
    feedback('sign-feedback', 'Confirm your full name.');
    return;
  }
  if (!intent) {
    feedback(
      'sign-feedback',
      'Tick the statement to confirm you intend to sign electronically.'
    );
    return;
  }
  const body: Record<string, unknown> = {
    kind: signatureKind,
    name,
    designation,
    intent: true,
  };
  if (signatureKind === 'typed') {
    const typed = el<HTMLInputElement>('typed-name').value.trim();
    if (typed.length < 2) {
      feedback(
        'sign-feedback',
        'Type the name you want to appear as your signature.'
      );
      return;
    }
    body.name = typed;
  } else {
    if (padStrokes === 0) {
      feedback('sign-feedback', 'Draw your signature first.');
      return;
    }
    body.image_png_b64 =
      el<HTMLCanvasElement>('sig-pad').toDataURL('image/png');
  }
  const btn = el<HTMLButtonElement>('btn-apply-signature');
  btn.disabled = true;
  btn.textContent = 'Sealing…';
  const res = await api<{
    status: string;
    executed: boolean;
    download_available: boolean;
  }>('/sign', {
    method: 'POST',
    body,
  });
  btn.disabled = false;
  btn.textContent = 'Sign and finish';
  if (!res.ok || !res.data) {
    if (res.error?.code === 'session_invalid') {
      session = null;
      clearSession(token);
      await refreshLanding();
      return;
    }
    if (
      res.error?.code === 'hosted_signing' &&
      typeof res.error.signing_url === 'string'
    ) {
      el<HTMLIFrameElement>('hosted-frame').src = res.error.signing_url;
      show('hosted');
      return;
    }
    feedback('sign-feedback', res.error?.message || 'Signing failed.');
    return;
  }
  await refreshLanding();
}

// --------------------------------------------------------------------------
// Done
// --------------------------------------------------------------------------

function renderDone(): void {
  if (!landing) return;
  const d = landing.document;
  const r = landing.recipient;
  const executed = d.status === 'executed';
  el('done-title').textContent = executed
    ? 'Executed'
    : r.status === 'signed'
      ? 'Signed. Awaiting the other party.'
      : 'Nothing more to do here';
  el('done-message').textContent = executed
    ? `${d.title} is fully executed. A sealed copy with the certificate of completion has been emailed to both parties.`
    : r.status === 'signed'
      ? 'Your signature has been recorded. You will receive the sealed PDF by email once everyone has signed.'
      : 'This link is for your information only.';
  el('done-meta').classList.toggle('hidden', !executed);
  el('btn-download').classList.toggle('hidden', !(executed && !!session));
  if (executed) {
    el('done-executed-at').textContent = formatDateTime(d.executed_at);
    el('done-hash').textContent =
      doneHash ||
      'Available in the email and on the certificate of completion.';
  }
  show('done');
}

async function download(): Promise<void> {
  feedback('done-feedback', null);
  const res = await signApiBlob(`/api/sign/s/${token}/download`, { session });
  if (!res.ok || !res.blob) {
    feedback('done-feedback', res.error?.message || 'Download failed.');
    return;
  }
  const buf = await res.blob.arrayBuffer();
  try {
    const digest = await crypto.subtle.digest('SHA-256', buf);
    doneHash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    el('done-hash').textContent = doneHash;
  } catch {
    /* hash display is a nicety */
  }
  downloadFile(res.blob, res.filename || 'executed.pdf');
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------

function wireEvents(): void {
  el('btn-send-code').addEventListener('click', () => void requestCode());
  el('btn-resend-code').addEventListener('click', () => void requestCode());
  el('btn-verify').addEventListener('click', () => void verifyCode());
  el<HTMLInputElement>('otp-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void verifyCode();
  });
  el<HTMLInputElement>('otp-code').addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    if (input.value.length === 6) void verifyCode();
  });
  el('btn-open-sign').addEventListener('click', openSignPanel);
  el('btn-back-to-doc').addEventListener('click', () => show('view'));
  el('tab-typed').addEventListener('click', () => setKind('typed'));
  el('tab-drawn').addEventListener('click', () => setKind('drawn'));
  el('btn-clear-pad').addEventListener('click', clearPad);
  el<HTMLInputElement>('typed-name').addEventListener('input', (e) => {
    el('typed-preview').textContent = (e.target as HTMLInputElement).value;
  });
  el<HTMLInputElement>('sign-name').addEventListener('input', () => {
    const name =
      el<HTMLInputElement>('sign-name').value.trim() ||
      landing?.recipient.name ||
      '';
    const first = el('intent-text').querySelector('b');
    if (first) first.textContent = name;
  });
  el('btn-apply-signature').addEventListener(
    'click',
    () => void applySignature()
  );
  el('btn-download').addEventListener('click', () => void download());
}
