/**
 * Server OCR (PDF/A) — uploads a scanned PDF to /api/ocr-pdf (OCRmyPDF) and
 * returns a searchable / archival PDF/A. Capability-aware (ocr_server).
 */

import { createIcons, icons } from 'lucide';
import { showAlert } from '../ui.js';
import { downloadFile, formatBytes } from '../utils/helpers.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

let pdfFile: File | null = null;
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

  fileInput?.addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) handleFile(f);
  });
  fileInput?.addEventListener('click', () => {
    if (fileInput) fileInput.value = '';
  });

  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('bg-gray-700');
    });
    dropZone.addEventListener('dragleave', () =>
      dropZone.classList.remove('bg-gray-700')
    );
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('bg-gray-700');
      const f = e.dataTransfer?.files?.[0];
      if (f) handleFile(f);
    });
  }

  el('ocr-btn')?.addEventListener('click', runOcr);
  el('back-to-tools')?.addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });
}

async function checkCapability() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/capabilities`);
    if (!res.ok) return;
    const caps = await res.json();
    if (!caps.ocr_server) {
      enabled = false;
      el('needs-setup')?.classList.remove('hidden');
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
  pdfFile = f;
  const area = el('file-display-area');
  if (area) {
    area.innerHTML = `<div class="flex items-center justify-between bg-gray-700 p-3 rounded-lg text-sm">
      <span class="truncate text-gray-200">${f.name} • ${formatBytes(f.size)}</span>
      <button id="remove-pdf" class="ml-3 text-red-400 hover:text-red-300 flex-shrink-0">
        <i data-lucide="trash-2" class="w-4 h-4"></i>
      </button>
    </div>`;
    el('remove-pdf')?.addEventListener('click', () => {
      pdfFile = null;
      area.innerHTML = '';
      el('ocr-options')?.classList.add('hidden');
      el('ocr-btn')?.classList.add('hidden');
    });
  }
  el('ocr-options')?.classList.remove('hidden');
  const btn = el<HTMLButtonElement>('ocr-btn');
  if (btn) {
    btn.classList.remove('hidden');
    btn.disabled = !enabled;
  }
  el('success-section')?.classList.add('hidden');
  el('error-section')?.classList.add('hidden');
  createIcons({ icons });
}

async function runOcr() {
  if (!pdfFile) return;
  const btn = el<HTMLButtonElement>('ocr-btn');
  if (btn) btn.disabled = true;
  el('error-section')?.classList.add('hidden');
  el('success-section')?.classList.add('hidden');
  el('ocr-progress')?.classList.remove('hidden');

  try {
    const form = new FormData();
    form.append('file', pdfFile);
    form.append(
      'language',
      el<HTMLSelectElement>('ocr-language')?.value ?? 'eng'
    );
    form.append(
      'pdfa',
      el<HTMLInputElement>('ocr-pdfa')?.checked ? 'true' : 'false'
    );

    const res = await fetch(`${API_BASE_URL}/api/ocr-pdf`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || `Server error: ${res.status}`);
    }
    const blob = await res.blob();
    const outName = pdfFile.name.replace(/\.pdf$/i, '_ocr.pdf');
    downloadFile(blob, outName);
    el('success-section')?.classList.remove('hidden');
    createIcons({ icons });
  } catch (e) {
    el('error-section')?.classList.remove('hidden');
    const msg = el('error-message');
    if (msg) msg.textContent = (e as Error).message || 'Failed to run OCR';
  } finally {
    el('ocr-progress')?.classList.add('hidden');
    if (btn) btn.disabled = false;
  }
}
