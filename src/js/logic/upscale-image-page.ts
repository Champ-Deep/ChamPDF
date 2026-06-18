/**
 * Image Upscaler Page - AI super-resolution via Real-ESRGAN (server-side).
 *
 * Upload an image, pick 2x/4x, the backend enhances it with Real-ESRGAN and
 * returns the upscaled result for download.
 */

import { createIcons, icons } from 'lucide';
import { showAlert } from '../ui.js';
import { formatBytes } from '../utils/helpers.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

interface UpscaleState {
  file: File | null;
  scale: 2 | 4;
  isProcessing: boolean;
  downloadUrl: string | null;
  downloadFilename: string;
}

const state: UpscaleState = {
  file: null,
  scale: 4,
  isProcessing: false,
  downloadUrl: null,
  downloadFilename: 'image_upscaled.png',
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB (matches backend MAX_IMAGE_SIZE_MB)
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePage);
} else {
  initializePage();
}

function initializePage() {
  createIcons({ icons });

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');

  fileInput?.addEventListener('change', handleFileUpload);
  fileInput?.addEventListener('click', () => {
    if (fileInput) fileInput.value = '';
  });

  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('bg-gray-700');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('bg-gray-700');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('bg-gray-700');
      const files = e.dataTransfer?.files;
      if (files?.[0]) handleFile(files[0]);
    });
  }

  document.querySelectorAll('input[name="scale"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.scale = parseInt((e.target as HTMLInputElement).value, 10) as 2 | 4;
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

function handleFileUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) handleFile(input.files[0]);
}

function handleFile(file: File) {
  if (!ALLOWED_TYPES.includes(file.type)) {
    showAlert('Invalid File', 'Please select an image (PNG, JPG, or WebP).');
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    showAlert(
      'File Too Large',
      `Maximum file size is ${formatBytes(MAX_FILE_SIZE)}. Your file is ${formatBytes(file.size)}.`
    );
    return;
  }
  state.file = file;
  updateFileDisplay(file);
  showOptionsSection();
}

function updateFileDisplay(file: File) {
  const area = document.getElementById('file-display-area');
  if (!area) return;
  area.innerHTML = '';

  const row = document.createElement('div');
  row.className =
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

  row.append(info, remove);
  area.appendChild(row);
  createIcons({ icons });
}

function showOptionsSection() {
  document.getElementById('options-section')?.classList.remove('hidden');
  document.getElementById('download-section')?.classList.add('hidden');
  document.getElementById('error-section')?.classList.add('hidden');
  document.getElementById('processing-status')?.classList.add('hidden');
}

async function handleProcess() {
  if (!state.file) {
    showAlert('No File', 'Please select an image first.');
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
  const progressInterval = setInterval(() => {
    progress = Math.min(progress + Math.random() * 6, 90);
    if (progressBar) progressBar.style.width = `${progress}%`;
  }, 500);

  try {
    const formData = new FormData();
    formData.append('file', state.file);
    formData.append('scale', String(state.scale));
    formData.append('output_format', 'png');

    updateStatus(
      'Uploading image...',
      `Upscaling ${state.scale}x on the server`
    );

    const response = await fetch(`${API_BASE_URL}/api/upscale-image`, {
      method: 'POST',
      body: formData,
    });

    clearInterval(progressInterval);

    if (!response.ok) {
      const err = await response
        .json()
        .catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || `Server error: ${response.status}`);
    }

    const blob = await response.blob();
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = URL.createObjectURL(blob);

    const originalName = state.file.name.replace(/\.[^/.]+$/, '');
    state.downloadFilename = `${originalName}_upscaled_${state.scale}x.png`;

    if (progressBar) progressBar.style.width = '100%';
    updateStatus('Complete!', 'Preparing download...');
    setTimeout(() => showDownloadSection(), 400);
  } catch (error) {
    clearInterval(progressInterval);
    console.error('Upscale error:', error);
    showErrorSection((error as Error).message || 'Failed to upscale image');
  } finally {
    state.isProcessing = false;
    if (processBtn) processBtn.disabled = false;
  }
}

function updateStatus(text: string, detail: string) {
  const statusText = document.getElementById('status-text');
  const statusDetail = document.getElementById('status-detail');
  if (statusText) statusText.textContent = text;
  if (statusDetail) statusDetail.textContent = detail;
}

function showDownloadSection() {
  document.getElementById('processing-status')?.classList.add('hidden');
  document.getElementById('download-section')?.classList.remove('hidden');
  createIcons({ icons });
}

function showErrorSection(message: string) {
  document.getElementById('processing-status')?.classList.add('hidden');
  document.getElementById('error-section')?.classList.remove('hidden');
  const el = document.getElementById('error-message');
  if (el) el.textContent = message;
  createIcons({ icons });
}

function handleDownload() {
  if (!state.downloadUrl) return;
  const link = document.createElement('a');
  link.href = state.downloadUrl;
  link.download = state.downloadFilename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
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

  const defaultScale = document.querySelector(
    'input[name="scale"][value="4"]'
  ) as HTMLInputElement;
  if (defaultScale) defaultScale.checked = true;
  state.scale = 4;
}

function cleanup() {
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }
}
