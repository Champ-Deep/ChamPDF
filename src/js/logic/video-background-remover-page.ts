/**
 * Video Background Remover — temporally-consistent video matting.
 *
 * Server-side only (GPU): posts the video to /api/video-matte (Robust Video
 * Matting via Replicate). Mirrors the video-rebrander flow. Capability-aware:
 * shows a quiet "needs setup" note when the server has no GPU provider.
 */

import { createIcons, icons } from 'lucide';
import { showAlert } from '../ui.js';
import { formatBytes } from '../utils/helpers.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi'];
const ALLOWED_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
];

type MatteMode = 'green' | 'alpha' | 'foreground';

interface State {
  file: File | null;
  mode: MatteMode;
  isProcessing: boolean;
  downloadUrl: string | null;
  downloadFilename: string;
}

const state: State = {
  file: null,
  mode: 'green',
  isProcessing: false,
  downloadUrl: null,
  downloadFilename: 'video_no_bg.mp4',
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePage);
} else {
  initializePage();
}

function initializePage() {
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

  document.querySelectorAll('input[name="matte-mode"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.mode = (e.target as HTMLInputElement).value as MatteMode;
    });
  });

  document
    .getElementById('process-btn')
    ?.addEventListener('click', handleProcess);
  document
    .getElementById('download-btn')
    ?.addEventListener('click', handleDownload);
  document
    .getElementById('process-another-btn')
    ?.addEventListener('click', resetToUpload);
  document
    .getElementById('try-again-btn')
    ?.addEventListener('click', resetToUpload);
  document.getElementById('back-to-tools')?.addEventListener('click', () => {
    cleanup();
    window.location.href = import.meta.env.BASE_URL;
  });
}

async function checkCapability() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/capabilities`);
    if (!res.ok) return;
    const caps = await res.json();
    if (!caps.video_matte) {
      document.getElementById('needs-setup')?.classList.remove('hidden');
    }
  } catch {
    /* capabilities are best-effort; the backend still enforces gating */
  }
}

function handleFile(file: File) {
  const ext = '.' + (file.name.split('.').pop()?.toLowerCase() ?? '');
  if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXTENSIONS.includes(ext)) {
    showAlert(
      'Invalid File',
      'Please select a video (MP4, MOV, WebM, or AVI).'
    );
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    showAlert(
      'File Too Large',
      `Maximum is ${formatBytes(MAX_FILE_SIZE)}. Your file is ${formatBytes(file.size)}.`
    );
    return;
  }
  state.file = file;
  updateFileDisplay(file);
  document.getElementById('options-section')?.classList.remove('hidden');
  document.getElementById('download-section')?.classList.add('hidden');
  document.getElementById('error-section')?.classList.add('hidden');
  document.getElementById('processing-status')?.classList.add('hidden');
}

function updateFileDisplay(file: File) {
  const area = document.getElementById('file-display-area');
  if (!area) return;
  area.innerHTML = '';
  const div = document.createElement('div');
  div.className =
    'flex items-center justify-between bg-gray-700 p-3 rounded-lg';
  const info = document.createElement('div');
  info.className = 'flex flex-col flex-1 min-w-0';
  const name = document.createElement('div');
  name.className = 'truncate font-medium text-gray-200 text-sm mb-1';
  name.textContent = file.name;
  const meta = document.createElement('div');
  meta.className = 'text-xs text-gray-400';
  meta.textContent = formatBytes(file.size);
  info.append(name, meta);
  const remove = document.createElement('button');
  remove.className = 'ml-4 text-red-400 hover:text-red-300 flex-shrink-0';
  remove.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
  remove.onclick = () => resetToUpload();
  div.append(info, remove);
  area.appendChild(div);
  createIcons({ icons });
}

async function handleProcess() {
  if (!state.file) {
    showAlert('No File', 'Please select a video first.');
    return;
  }
  if (state.isProcessing) return;
  state.isProcessing = true;

  document.getElementById('options-section')?.classList.add('hidden');
  document.getElementById('processing-status')?.classList.remove('hidden');
  const processBtn = document.getElementById(
    'process-btn'
  ) as HTMLButtonElement;
  if (processBtn) processBtn.disabled = true;

  const progressBar = document.getElementById('progress-bar') as HTMLElement;
  let progress = 0;
  const interval = setInterval(() => {
    progress = Math.min(progress + Math.random() * 4, 90);
    if (progressBar) progressBar.style.width = `${progress}%`;
  }, 600);

  try {
    const form = new FormData();
    form.append('file', state.file);
    form.append('mode', state.mode);

    const res = await fetch(`${API_BASE_URL}/api/video-matte`, {
      method: 'POST',
      body: form,
    });
    clearInterval(interval);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || `Server error: ${res.status}`);
    }

    const blob = await res.blob();
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = URL.createObjectURL(blob);
    const originalName = state.file.name.replace(/\.[^/.]+$/, '');
    state.downloadFilename = `${originalName}_no_bg.mp4`;

    if (progressBar) progressBar.style.width = '100%';
    setTimeout(() => {
      document.getElementById('processing-status')?.classList.add('hidden');
      document.getElementById('download-section')?.classList.remove('hidden');
      createIcons({ icons });
    }, 400);
  } catch (e) {
    clearInterval(interval);
    document.getElementById('processing-status')?.classList.add('hidden');
    document.getElementById('error-section')?.classList.remove('hidden');
    const msg = document.getElementById('error-message');
    if (msg)
      msg.textContent = (e as Error).message || 'Failed to process video';
    createIcons({ icons });
  } finally {
    state.isProcessing = false;
    if (processBtn) processBtn.disabled = false;
  }
}

function handleDownload() {
  if (!state.downloadUrl) return;
  const a = document.createElement('a');
  a.href = state.downloadUrl;
  a.download = state.downloadFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function resetToUpload() {
  cleanup();
  state.file = null;
  state.isProcessing = false;
  document.getElementById('options-section')?.classList.add('hidden');
  document.getElementById('processing-status')?.classList.add('hidden');
  document.getElementById('download-section')?.classList.add('hidden');
  document.getElementById('error-section')?.classList.add('hidden');
  const area = document.getElementById('file-display-area');
  if (area) area.innerHTML = '';
  const progressBar = document.getElementById('progress-bar') as HTMLElement;
  if (progressBar) progressBar.style.width = '0%';
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  if (fileInput) fileInput.value = '';
  const def = document.querySelector(
    'input[name="matte-mode"][value="green"]'
  ) as HTMLInputElement;
  if (def) def.checked = true;
  state.mode = 'green';
}

function cleanup() {
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }
}
