/**
 * Video Rebrander Page - Video watermark removal and logo replacement
 *
 * Features:
 * - Drag-and-drop video upload
 * - Logo preset selection (LakeB2B, Champions, Ampliz, None)
 * - Watermark position detection
 * - Server-side FFmpeg processing
 * - Download processed video
 */

import { createIcons, icons } from 'lucide';
import { showAlert } from '../ui.js';
import { formatBytes } from '../utils/helpers.js';

// API endpoint - configure based on environment
// Use empty string to make relative URLs work with Nginx reverse proxy in production
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

interface VideoRebraderState {
  file: File | null;
  logoPreset: 'lakeb2b' | 'champions' | 'ampliz' | 'none';
  watermarkPosition: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  isProcessing: boolean;
  downloadUrl: string | null;
  downloadFilename: string;
}

const state: VideoRebraderState = {
  file: null,
  logoPreset: 'lakeb2b',
  watermarkPosition: 'bottom-right',
  isProcessing: false,
  downloadUrl: null,
  downloadFilename: 'video_rebranded.mp4',
};

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const ALLOWED_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
];
const ALLOWED_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi'];

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePage);
} else {
  initializePage();
}

function initializePage() {
  createIcons({ icons });

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');

  // File input handler
  fileInput?.addEventListener('change', handleFileUpload);

  // Clear value on click to allow re-selecting the same file
  fileInput?.addEventListener('click', () => {
    if (fileInput) fileInput.value = '';
  });

  // Drop zone handlers
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

  // Logo preset radio buttons
  document.querySelectorAll('input[name="logo-preset"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.logoPreset = (e.target as HTMLInputElement)
        .value as typeof state.logoPreset;
    });
  });

  // Watermark position radio buttons
  document
    .querySelectorAll('input[name="watermark-position"]')
    .forEach((radio) => {
      radio.addEventListener('change', (e) => {
        state.watermarkPosition = (e.target as HTMLInputElement)
          .value as typeof state.watermarkPosition;
      });
    });

  // Process button
  document
    .getElementById('process-btn')
    ?.addEventListener('click', handleProcess);

  // Download button
  document
    .getElementById('download-btn')
    ?.addEventListener('click', handleDownload);

  // Process another button
  document
    .getElementById('process-another-btn')
    ?.addEventListener('click', resetToUpload);

  // Try again button
  document
    .getElementById('try-again-btn')
    ?.addEventListener('click', resetToUpload);

  // Back to tools button
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
  // Validate file type
  const fileExt = '.' + file.name.split('.').pop()?.toLowerCase();
  const isValidType =
    ALLOWED_TYPES.includes(file.type) || ALLOWED_EXTENSIONS.includes(fileExt);

  if (!isValidType) {
    showAlert(
      'Invalid File',
      'Please select a video file (MP4, MOV, WebM, or AVI).'
    );
    return;
  }

  // Validate file size
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
  const fileDisplayArea = document.getElementById('file-display-area');
  if (!fileDisplayArea) return;

  fileDisplayArea.innerHTML = '';

  const fileDiv = document.createElement('div');
  fileDiv.className =
    'flex items-center justify-between bg-gray-700 p-3 rounded-lg';

  const infoContainer = document.createElement('div');
  infoContainer.className = 'flex flex-col flex-1 min-w-0';

  const nameSpan = document.createElement('div');
  nameSpan.className = 'truncate font-medium text-gray-200 text-sm mb-1';
  nameSpan.textContent = file.name;

  const metaSpan = document.createElement('div');
  metaSpan.className = 'text-xs text-gray-400';
  metaSpan.textContent = formatBytes(file.size);

  infoContainer.append(nameSpan, metaSpan);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'ml-4 text-red-400 hover:text-red-300 flex-shrink-0';
  removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
  removeBtn.onclick = () => {
    resetToUpload();
  };

  fileDiv.append(infoContainer, removeBtn);
  fileDisplayArea.appendChild(fileDiv);
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
    showAlert('No File', 'Please select a video file first.');
    return;
  }

  if (state.isProcessing) return;

  state.isProcessing = true;

  // Show processing status
  document.getElementById('options-section')?.classList.add('hidden');
  document.getElementById('processing-status')?.classList.remove('hidden');

  const processBtn = document.getElementById(
    'process-btn'
  ) as HTMLButtonElement;
  if (processBtn) processBtn.disabled = true;

  // Animate progress bar (indeterminate style)
  const progressBar = document.getElementById('progress-bar') as HTMLElement;
  let progress = 0;
  const progressInterval = setInterval(() => {
    // Slow progress that never quite reaches 100%
    progress = Math.min(progress + Math.random() * 5, 90);
    if (progressBar) progressBar.style.width = `${progress}%`;
  }, 500);

  try {
    // Create form data
    const formData = new FormData();
    formData.append('file', state.file);
    formData.append('logo_preset', state.logoPreset);
    formData.append('watermark_position', state.watermarkPosition);

    // Update status
    updateStatus('Uploading video...', 'Sending to server for processing');

    // Send to API
    const response = await fetch(`${API_BASE_URL}/api/process-video`, {
      method: 'POST',
      body: formData,
    });

    clearInterval(progressInterval);

    if (!response.ok) {
      const errorData = await response
        .json()
        .catch(() => ({ detail: 'Unknown error' }));
      throw new Error(errorData.detail || `Server error: ${response.status}`);
    }

    // Get the blob from response
    updateStatus('Processing complete!', 'Preparing download...');

    const blob = await response.blob();

    // Create download URL
    if (state.downloadUrl) {
      URL.revokeObjectURL(state.downloadUrl);
    }
    state.downloadUrl = URL.createObjectURL(blob);

    // Get filename from Content-Disposition header or use default
    const contentDisposition = response.headers.get('Content-Disposition');
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match) state.downloadFilename = match[1];
    } else {
      const originalName = state.file.name.replace(/\.[^/.]+$/, '');
      state.downloadFilename = `${originalName}_rebranded.mp4`;
    }

    // Complete progress
    if (progressBar) progressBar.style.width = '100%';

    // Show download section
    setTimeout(() => {
      showDownloadSection();
    }, 500);
  } catch (error) {
    clearInterval(progressInterval);
    console.error('Processing error:', error);
    showErrorSection((error as Error).message || 'Failed to process video');
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
  const errorMessage = document.getElementById('error-message');
  if (errorMessage) errorMessage.textContent = message;
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

  // Reset state
  state.file = null;
  state.isProcessing = false;

  // Hide all sections
  document.getElementById('options-section')?.classList.add('hidden');
  document.getElementById('processing-status')?.classList.add('hidden');
  document.getElementById('download-section')?.classList.add('hidden');
  document.getElementById('error-section')?.classList.add('hidden');

  // Clear file display
  const fileDisplayArea = document.getElementById('file-display-area');
  if (fileDisplayArea) fileDisplayArea.innerHTML = '';

  // Reset progress bar
  const progressBar = document.getElementById('progress-bar') as HTMLElement;
  if (progressBar) progressBar.style.width = '0%';

  // Clear file input
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  if (fileInput) fileInput.value = '';

  // Reset radio buttons to defaults
  const defaultLogo = document.querySelector(
    'input[name="logo-preset"][value="lakeb2b"]'
  ) as HTMLInputElement;
  if (defaultLogo) defaultLogo.checked = true;
  state.logoPreset = 'lakeb2b';

  const defaultPosition = document.querySelector(
    'input[name="watermark-position"][value="bottom-right"]'
  ) as HTMLInputElement;
  if (defaultPosition) defaultPosition.checked = true;
  state.watermarkPosition = 'bottom-right';
}

function cleanup() {
  // Revoke download URL if exists
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }
}
