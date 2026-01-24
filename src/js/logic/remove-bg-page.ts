import { createIcons, icons } from 'lucide';
import { showAlert } from '../ui.js';
import { formatBytes, downloadFile } from '../utils/helpers.js';
import JSZip from 'jszip';

interface ProcessedFile {
  originalFile: File;
  blob: Blob;
  url: string;
}

interface RemoveBgState {
  files: File[];
  results: ProcessedFile[];
  isProcessing: boolean;
}

const state: RemoveBgState = {
  files: [],
  results: [],
  isProcessing: false,
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePage);
} else {
  initializePage();
}

function initializePage() {
  createIcons({ icons });

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');

  fileInput?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files) handleFiles(Array.from(input.files));
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
      if (files) handleFiles(Array.from(files));
    });
  }

  document
    .getElementById('process-btn')
    ?.addEventListener('click', handleProcess);
  document
    .getElementById('download-zip-btn')
    ?.addEventListener('click', downloadZip);
  document
    .getElementById('download-btn')
    ?.addEventListener('click', downloadLast);
  document
    .getElementById('process-another-btn')
    ?.addEventListener('click', resetPage);
  document.getElementById('back-to-tools')?.addEventListener('click', () => {
    window.location.href = '/';
  });
}

function handleFiles(newFiles: File[]) {
  const validFiles = newFiles.filter((file) => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      showAlert(
        'Invalid Format',
        `${file.name} is not a supported image format.`
      );
      return false;
    }
    if (file.size > MAX_FILE_SIZE) {
      showAlert('File Too Large', `${file.name} exceeds the 10MB limit.`);
      return false;
    }
    return true;
  });

  if (validFiles.length === 0) return;

  state.files = [...state.files, ...validFiles];
  updateFileList();
  document.getElementById('options-section')?.classList.remove('hidden');
  document.getElementById('drop-zone')?.classList.add('hidden');
}

function updateFileList() {
  const area = document.getElementById('file-display-area');
  if (!area) return;

  if (state.files.length === 0) {
    area.innerHTML = '';
    resetPage();
    return;
  }

  area.innerHTML = `
        <div class="space-y-2 max-h-64 overflow-y-auto pr-2">
            ${state.files
              .map(
                (file, index) => `
                <div class="flex items-center justify-between bg-gray-700 p-3 rounded-lg border border-gray-600">
                    <div class="flex items-center gap-3 truncate">
                        <i data-lucide="file-image" class="w-5 h-5 text-orange-400 flex-shrink-0"></i>
                        <div class="truncate">
                            <p class="text-sm font-medium text-white truncate">${file.name}</p>
                            <p class="text-xs text-gray-400">${formatBytes(file.size)}</p>
                        </div>
                    </div>
                    <button class="remove-file-btn text-gray-400 hover:text-red-400 transition-colors" data-index="${index}">
                        <i data-lucide="trash-2" class="w-5 h-5"></i>
                    </button>
                </div>
            `
              )
              .join('')}
        </div>
        <div class="mt-4 flex justify-between items-center text-sm text-gray-400">
            <span>${state.files.length} images selected</span>
            <button id="add-more-batch" class="text-orange-400 hover:underline">Add more</button>
        </div>
    `;

  document.querySelectorAll('.remove-file-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(
        (e.currentTarget as HTMLElement).dataset.index || '0'
      );
      state.files.splice(index, 1);
      updateFileList();
    });
  });

  document.getElementById('add-more-batch')?.addEventListener('click', () => {
    (document.getElementById('file-input') as HTMLInputElement).click();
  });

  createIcons({ icons });
}

async function handleProcess() {
  if (state.files.length === 0 || state.isProcessing) return;

  state.isProcessing = true;
  const loader = document.getElementById('loader-modal');
  const progressBar = document.getElementById('process-progress');
  const loaderText = document.getElementById('loader-text');
  loader?.classList.remove('hidden');

  try {
    state.results = [];

    for (let i = 0; i < state.files.length; i++) {
      const file = state.files[i];
      if (loaderText) {
        loaderText.textContent = `Processing ${i + 1} of ${state.files.length}...`;
      }

      // Update progress
      if (progressBar) {
        const progress = Math.round(((i + 1) / state.files.length) * 100);
        progressBar.style.width = `${progress}%`;
      }

      // Call backend API
      const formData = new FormData();
      formData.append('file', file);
      formData.append('output_format', 'png');

      const response = await fetch(`${API_BASE_URL}/api/remove-background`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ detail: 'Unknown error' }));
        throw new Error(errorData.detail || `Server error: ${response.status}`);
      }

      const blob = await response.blob();
      state.results.push({
        originalFile: file,
        blob: blob,
        url: URL.createObjectURL(blob),
      });
    }

    showResults();
  } catch (error) {
    console.error('Background removal error:', error);
    showAlert(
      'Processing Failed',
      error instanceof Error
        ? error.message
        : 'Failed to remove background. Please check your connection and try again.'
    );
  } finally {
    state.isProcessing = false;
    loader?.classList.add('hidden');
  }
}

function showResults() {
  document.getElementById('options-section')?.classList.add('hidden');
  document.getElementById('file-display-area')?.classList.add('hidden');
  document.getElementById('download-section')?.classList.remove('hidden');

  const statusText = document.getElementById('result-status');
  if (statusText)
    statusText.textContent = `${state.results.length} backgrounds successfully removed!`;

  const previewContainer = document.getElementById('batch-preview');
  if (previewContainer) {
    previewContainer.innerHTML = state.results
      .map(
        (res, index) => `
            <div class="relative group bg-checkered rounded-lg overflow-hidden border border-gray-700">
                <img src="${res.url}" class="w-full h-32 object-contain" alt="Result ${index}">
                <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <button class="individual-download p-2 bg-orange-600 rounded-full text-white hover:bg-orange-500 transition-colors" data-index="${index}">
                        <i data-lucide="download" class="w-4 h-4 pointer-events-none"></i>
                    </button>
                </div>
                <div class="absolute bottom-0 left-0 right-0 bg-black/70 text-[10px] text-white p-1 truncate">
                    ${res.originalFile.name}
                </div>
            </div>
        `
      )
      .join('');

    // Delegate listener for individual downloads
    previewContainer.onclick = (e) => {
      const btn = (e.target as HTMLElement).closest(
        '.individual-download'
      ) as HTMLElement;
      if (btn) {
        const index = parseInt(btn.dataset.index || '0');
        downloadIndividual(index);
      }
    };
  }

  // Toggle button visibility based on count
  const zipBtn = document.getElementById('download-zip-btn');
  const singleBtn = document.getElementById('download-btn');

  if (state.results.length === 1) {
    zipBtn?.classList.add('hidden');
    singleBtn?.classList.remove('hidden');
  } else {
    zipBtn?.classList.remove('hidden');
    singleBtn?.classList.add('hidden');
  }

  createIcons({ icons });
}

function downloadIndividual(index: number) {
  const res = state.results[index];
  if (!res) return;

  const originalName = res.originalFile.name;
  const lastDotIndex = originalName.lastIndexOf('.');
  const baseName =
    lastDotIndex !== -1
      ? originalName.substring(0, lastDotIndex)
      : originalName;
  const downloadName = `${baseName}_no_bg.png`;

  downloadFile(res.blob, downloadName);
}

function downloadLast() {
  if (state.results.length > 0) {
    downloadIndividual(state.results.length - 1);
  }
}

async function downloadZip() {
  if (state.results.length === 0) return;

  try {
    const zip = new JSZip();
    state.results.forEach((res) => {
      const originalName = res.originalFile.name;
      const lastDotIndex = originalName.lastIndexOf('.');
      const baseName =
        lastDotIndex !== -1
          ? originalName.substring(0, lastDotIndex)
          : originalName;
      const name = `${baseName}_no_bg.png`;
      zip.file(name, res.blob);
    });

    const content = await zip.generateAsync({ type: 'blob' });
    downloadFile(content, 'transparent_images.zip');
  } catch (error) {
    console.error('ZIP Error:', error);
    showAlert(
      'Download Failed',
      'Could not create ZIP file. Try downloading images individually.'
    );
  }
}

function resetPage() {
  state.files = [];
  state.results.forEach((res) => URL.revokeObjectURL(res.url));
  state.results = [];
  state.isProcessing = false;

  document.getElementById('drop-zone')?.classList.remove('hidden');
  document.getElementById('options-section')?.classList.add('hidden');
  document.getElementById('file-display-area')?.classList.add('hidden');
  document.getElementById('download-section')?.classList.add('hidden');

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  if (fileInput) fileInput.value = '';
}
