/**
 * Verify PDF Signature — uploads a signed PDF to /api/verify-signature (pyHanko)
 * and renders an integrity / signer / timestamp report. Capability-aware.
 */

import { createIcons, icons } from 'lucide';
import { showAlert } from '../ui.js';
import { formatBytes } from '../utils/helpers.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

interface SigEntry {
  field?: string;
  intact?: boolean;
  valid?: boolean;
  signer?: string;
  signing_time?: string;
  timestamped?: boolean;
  coverage?: string;
  error?: string;
}

let file: File | null = null;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function init() {
  createIcons({ icons });
  void checkCapability();

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');

  fileInput?.addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) handleFile(f);
  });
  fileInput?.addEventListener('click', () => {
    if (fileInput) fileInput.value = '';
  });
  dropZone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('bg-gray-700');
  });
  dropZone?.addEventListener('dragleave', () =>
    dropZone.classList.remove('bg-gray-700')
  );
  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('bg-gray-700');
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });

  document.getElementById('verify-btn')?.addEventListener('click', verify);
  document.getElementById('back-to-tools')?.addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });
}

async function checkCapability() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/capabilities`);
    if (!res.ok) return;
    const caps = await res.json();
    if (!caps.pdf_verify) {
      document.getElementById('needs-setup')?.classList.remove('hidden');
    }
  } catch {
    /* best-effort */
  }
}

function handleFile(f: File) {
  if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
    showAlert('Invalid File', 'Please select a PDF.');
    return;
  }
  file = f;
  const area = document.getElementById('file-display-area');
  if (area) {
    area.innerHTML = `<div class="flex items-center justify-between bg-gray-700 p-3 rounded-lg text-sm"><span class="truncate text-gray-200">${f.name} • ${formatBytes(f.size)}</span></div>`;
  }
  document.getElementById('verify-btn')?.classList.remove('hidden');
  document.getElementById('result')?.classList.add('hidden');
  document.getElementById('error-section')?.classList.add('hidden');
}

async function verify() {
  if (!file) return;
  const btn = document.getElementById('verify-btn') as HTMLButtonElement;
  if (btn) btn.disabled = true;
  document.getElementById('error-section')?.classList.add('hidden');

  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_BASE_URL}/api/verify-signature`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || `Server error: ${res.status}`);
    }
    const data = await res.json();
    renderReport(data.signatures || [], data.signature_count ?? 0);
  } catch (e) {
    document.getElementById('error-section')?.classList.remove('hidden');
    const msg = document.getElementById('error-message');
    if (msg) msg.textContent = (e as Error).message || 'Failed to verify';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderReport(sigs: SigEntry[], count: number) {
  const result = document.getElementById('result');
  if (!result) return;
  result.classList.remove('hidden');

  if (count === 0) {
    result.innerHTML = `<div class="bg-gray-900 border border-gray-700 rounded-lg p-4 text-sm text-gray-300">No digital signatures found in this PDF.</div>`;
    return;
  }

  result.innerHTML = sigs
    .map((s) => {
      if (s.error) {
        return `<div class="bg-gray-900 border border-gray-700 rounded-lg p-4 text-sm"><p class="text-gray-200 font-medium">${s.field || 'Signature'}</p><p class="text-red-400/80 mt-1">Could not validate: ${s.error}</p></div>`;
      }
      const intact = !!s.intact;
      const badge = intact
        ? `<span class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full" style="background:var(--green-bg);color:var(--green);border:1px solid var(--green-bd);"><i data-lucide="check" class="w-3 h-3"></i>Intact</span>`
        : `<span class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-900/40 text-red-300 border border-red-700"><i data-lucide="alert-triangle" class="w-3 h-3"></i>Modified</span>`;
      const rows: string[] = [];
      if (s.signer) rows.push(row('Signer', s.signer));
      if (s.signing_time) rows.push(row('Signed', s.signing_time));
      rows.push(row('Timestamped', s.timestamped ? 'Yes (TSA)' : 'No'));
      if (s.coverage) rows.push(row('Coverage', s.coverage));
      return `<div class="bg-gray-900 border border-gray-700 rounded-lg p-4">
        <div class="flex items-center justify-between mb-3">
          <p class="text-gray-100 font-medium">${s.field || 'Signature'}</p>${badge}
        </div>
        <div class="space-y-1">${rows.join('')}</div>
      </div>`;
    })
    .join('');
  createIcons({ icons });
}

function row(label: string, value: string): string {
  return `<div class="flex justify-between gap-4 text-sm"><span class="text-gray-500">${label}</span><span class="text-gray-200 text-right truncate">${value}</span></div>`;
}
