/**
 * Compliance Sign (PAdES) — uploads a PDF + PKCS#12 certificate to
 * /api/sign-pdf (pyHanko) and returns a PAdES-signed PDF with an optional
 * trusted RFC-3161 timestamp. Capability-aware (pdf_sign_advanced).
 */

import { createIcons, icons } from 'lucide';
import { showAlert } from '../ui.js';
import { downloadFile, formatBytes } from '../utils/helpers.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

let pdfFile: File | null = null;
let certFile: File | null = null;
let enabled = true;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function init() {
  createIcons({ icons });
  void checkCapability();

  const fileInput = el<HTMLInputElement>('file-input');
  const dropZone = el('drop-zone');
  const certInput = el<HTMLInputElement>('cert-input');
  const certDropZone = el('cert-drop-zone');

  fileInput?.addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) handlePdf(f);
  });
  fileInput?.addEventListener('click', () => {
    if (fileInput) fileInput.value = '';
  });
  wireDrop(dropZone, (f) => handlePdf(f));

  certInput?.addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) handleCert(f);
  });
  certInput?.addEventListener('click', () => {
    if (certInput) certInput.value = '';
  });
  wireDrop(certDropZone, (f) => handleCert(f));

  el('cert-password')?.addEventListener('input', updateButton);
  el('sign-btn')?.addEventListener('click', sign);
  el('back-to-tools')?.addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });
}

function wireDrop(zone: HTMLElement | null, onFile: (f: File) => void) {
  if (!zone) return;
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('bg-gray-700');
  });
  zone.addEventListener('dragleave', () =>
    zone.classList.remove('bg-gray-700')
  );
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('bg-gray-700');
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
}

async function checkCapability() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/capabilities`);
    if (!res.ok) return;
    const caps = await res.json();
    if (!caps.pdf_sign_advanced) {
      enabled = false;
      el('needs-setup')?.classList.remove('hidden');
    }
  } catch {
    /* best-effort */
  }
}

function handlePdf(f: File) {
  if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
    showAlert('Invalid File', 'Please select a PDF.');
    return;
  }
  pdfFile = f;
  const area = el('file-display-area');
  if (area) {
    area.innerHTML = fileRow(f, 'remove-pdf');
    el('remove-pdf')?.addEventListener('click', () => {
      pdfFile = null;
      area.innerHTML = '';
      el('sign-options')?.classList.add('hidden');
      updateButton();
    });
  }
  el('sign-options')?.classList.remove('hidden');
  el('success-section')?.classList.add('hidden');
  el('error-section')?.classList.add('hidden');
  createIcons({ icons });
  updateButton();
}

function handleCert(f: File) {
  const ok = ['.pfx', '.p12'].some((ext) => f.name.toLowerCase().endsWith(ext));
  if (!ok) {
    showAlert('Invalid Certificate', 'Please select a .pfx or .p12 file.');
    return;
  }
  certFile = f;
  const area = el('cert-display-area');
  if (area) {
    area.innerHTML = fileRow(f, 'remove-cert');
    el('remove-cert')?.addEventListener('click', () => {
      certFile = null;
      area.innerHTML = '';
      updateButton();
    });
  }
  createIcons({ icons });
  updateButton();
}

function fileRow(f: File, removeId: string): string {
  return `<div class="flex items-center justify-between bg-gray-700 p-3 rounded-lg text-sm">
    <span class="truncate text-gray-200">${f.name} • ${formatBytes(f.size)}</span>
    <button id="${removeId}" class="ml-3 text-red-400 hover:text-red-300 flex-shrink-0">
      <i data-lucide="trash-2" class="w-4 h-4"></i>
    </button>
  </div>`;
}

function updateButton() {
  const btn = el<HTMLButtonElement>('sign-btn');
  if (!btn) return;
  const pwd = el<HTMLInputElement>('cert-password')?.value ?? '';
  const ready = !!pdfFile && !!certFile && pwd.length > 0 && enabled;
  btn.classList.toggle('hidden', !pdfFile || !certFile);
  btn.disabled = !ready;
}

async function sign() {
  if (!pdfFile || !certFile) return;
  const btn = el<HTMLButtonElement>('sign-btn');
  if (btn) btn.disabled = true;
  el('error-section')?.classList.add('hidden');
  el('success-section')?.classList.add('hidden');

  try {
    const form = new FormData();
    form.append('file', pdfFile);
    form.append('cert', certFile);
    form.append(
      'passphrase',
      el<HTMLInputElement>('cert-password')?.value ?? ''
    );
    form.append('reason', el<HTMLInputElement>('sign-reason')?.value ?? '');
    form.append('location', el<HTMLInputElement>('sign-location')?.value ?? '');
    form.append(
      'timestamp',
      el<HTMLInputElement>('sign-timestamp')?.checked ? 'true' : 'false'
    );

    const res = await fetch(`${API_BASE_URL}/api/sign-pdf`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || `Server error: ${res.status}`);
    }
    const blob = await res.blob();
    const signedName = pdfFile.name.replace(/\.pdf$/i, '_signed.pdf');
    downloadFile(blob, signedName);
    el('success-section')?.classList.remove('hidden');
    createIcons({ icons });
  } catch (e) {
    el('error-section')?.classList.remove('hidden');
    const msg = el('error-message');
    if (msg) msg.textContent = (e as Error).message || 'Failed to sign';
  } finally {
    updateButton();
  }
}
