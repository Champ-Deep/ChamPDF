/**
 * Image Watermark Remover - Remove watermarks from Images and optionally replace with logo
 *
 * Features:
 * - Content-aware fill (vertical sampling) to remove watermarks
 * - Logo replacement option
 * - Supports JPG, PNG, WebP
 */

import { showAlert } from '../ui.js';
import { downloadFile, formatBytes } from '../utils/helpers.js';
import { createIcons, icons } from 'lucide';

interface WatermarkRemoverState {
  file: File | null;
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  logoPreset: 'none' | 'lakeb2b' | 'champions' | 'ampliz';
  isProcessing: boolean;
  resultBlob: Blob | null;
}

const state: WatermarkRemoverState = {
  file: null,
  position: 'bottom-right',
  logoPreset: 'none',
  isProcessing: false,
  resultBlob: null,
};

// Logo images served from public folder (with BASE_URL for Vite)
const LOGO_URLS: Record<string, string> = {
  lakeb2b: `${import.meta.env.BASE_URL}logos/lakeb2b.png`,
  champions: `${import.meta.env.BASE_URL}logos/champions.png`,
  ampliz: `${import.meta.env.BASE_URL}logos/ampliz.png`,
};

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
  fileInput?.addEventListener('change', handleFileSelect);
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

  // Position radio buttons
  document
    .querySelectorAll('input[name="watermark-position"]')
    .forEach((radio) => {
      radio.addEventListener('change', (e) => {
        state.position = (e.target as HTMLInputElement)
          .value as typeof state.position;
      });
    });

  // Logo preset radio buttons
  document.querySelectorAll('input[name="logo-preset"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.logoPreset = (e.target as HTMLInputElement)
        .value as typeof state.logoPreset;
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
    window.location.href = import.meta.env.BASE_URL;
  });
}

function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) handleFile(input.files[0]);
}

function handleFile(file: File) {
  if (!file.type.startsWith('image/')) {
    showAlert('Invalid File', 'Please select an image file (JPG, PNG, WebP).');
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
  removeBtn.onclick = () => resetToUpload();

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
    showAlert('No File', 'Please select an image file first.');
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

  const progressBar = document.getElementById('progress-bar') as HTMLElement;

  try {
    updateStatus('Reading Image...', 'Loading data');
    if (progressBar) progressBar.style.width = '10%';

    // Load image
    const img = await loadImage(state.file);

    // Setup canvas
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);

    updateStatus('Removing watermark...', 'Processing pixels');
    if (progressBar) progressBar.style.width = '40%';

    // Remove watermark
    removeWatermark(ctx, canvas.width, canvas.height, state.position);

    // Add replacement logo if selected
    if (state.logoPreset !== 'none') {
      updateStatus('Adding logo...', `Placing ${state.logoPreset} logo`);
      if (progressBar) progressBar.style.width = '70%';
      await addReplacementLogo(
        ctx,
        canvas.width,
        canvas.height,
        state.logoPreset,
        state.position
      );
    }

    if (progressBar) progressBar.style.width = '100%';

    // Export
    const mimeType = state.file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    // Prefer JPEG for output unless input was WebP or PNG with transparency (though simple masking usually implies opaque background for JPGs)
    // If input was PNG, output PNG to preserve transparency elsewhere?
    const outputType = state.file.type;

    canvas.toBlob(
      (blob) => {
        if (blob) {
          state.resultBlob = blob;
          updateStatus('Complete!', 'Watermark removed successfully');
          setTimeout(() => {
            showDownloadSection();
          }, 500);
        } else {
          throw new Error('Failed to create image blob');
        }
        state.isProcessing = false;
        if (processBtn) processBtn.disabled = false;
      },
      outputType,
      0.95 // High quality for lossy formats
    );

  } catch (error) {
    console.error('Processing error:', error);
    showErrorSection((error as Error).message || 'Failed to process image');
    state.isProcessing = false;
    if (processBtn) processBtn.disabled = false;
  }
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function updateStatus(text: string, detail: string) {
  const statusText = document.getElementById('status-text');
  const statusDetail = document.getElementById('status-detail');
  if (statusText) statusText.textContent = text;
  if (statusDetail) statusDetail.textContent = detail;
}

/**
 * Remove watermark using column-by-column sampling
 */
function removeWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  position: string
) {
  // Use a scale factor relative to a "standard" 1000px wide image
  // This helps adapt the watermark box size to the resolution
  // Assuming the watermark is roughly 220px wide on a 1500px wide image
  const scale = Math.max(width, height) / 1000;

  const wm = getWatermarkRect(position, width, height, scale);

  // Sample colors from a strip above the watermark
  // We go slightly above the watermark region
  const sampleY = Math.max(0, wm.y - 10 * scale);
  const sampleHeight = Math.max(2, 2 * scale); // Sample height based on scale

  // Get image data from the sample strip
  // We use the full width of the watermark region
  const sampleData = ctx.getImageData(wm.x, sampleY, wm.width, sampleHeight);

  // Column-by-column color fill over the watermark
  for (let x = 0; x < wm.width; x++) {
    // Sample color from middle of the sample strip for this column
    // sampleData is a 1D array: [r, g, b, a, r, g, b, a, ...]
    // Width is wm.width.
    // We want the pixel at (x, middle_of_height)
    const sampleRow = Math.floor(sampleHeight / 2);
    const idx = (sampleRow * Math.floor(wm.width) + x) * 4;

    const r = sampleData.data[idx];
    const g = sampleData.data[idx + 1];
    const b = sampleData.data[idx + 2];
    const a = sampleData.data[idx + 3] / 255; // Alpha 0-1

    ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
    // Fill slightly larger height to ensure coverage
    ctx.fillRect(wm.x + x, wm.y, 1, wm.height + 2);
  }
}

/**
 * Get the watermark region
 */
function getWatermarkRect(
  position: string,
  canvasWidth: number,
  canvasHeight: number,
  scale: number
): { x: number; y: number; width: number; height: number } {
  // Base dimensions (approximate for NotebookLM watermark)
  // Adjusted for visual appeal on images
  const wm_width = 180 * scale;
  const wm_height = 40 * scale;
  const margin = 20 * scale;

  switch (position) {
    case 'bottom-right':
      return {
        x: canvasWidth - wm_width - margin,
        y: canvasHeight - wm_height - margin,
        width: wm_width,
        height: wm_height,
      };
    case 'bottom-left':
      return {
        x: margin,
        y: canvasHeight - wm_height - margin,
        width: wm_width,
        height: wm_height,
      };
    case 'top-right':
      return {
        x: canvasWidth - wm_width - margin,
        y: margin,
        width: wm_width,
        height: wm_height,
      };
    case 'top-left':
      return {
        x: margin,
        y: margin,
        width: wm_width,
        height: wm_height,
      };
    default:
      return {
        x: canvasWidth - wm_width - margin,
        y: canvasHeight - wm_height - margin,
        width: wm_width,
        height: wm_height,
      };
  }
}

/**
 * Add replacement logo
 */
async function addReplacementLogo(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  logoPreset: string,
  position: string
) {
  const logoUrl = LOGO_URLS[logoPreset];
  if (!logoUrl) return;

  try {
    const logoImg = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.crossOrigin = 'Anonymous'; // Needed if logos are external, but they are local
      img.src = logoUrl;
    });

    // Calculate logo dimensions
    // Max width relative to image width
    const maxLogoWidth = width * 0.15; // 15% of image width
    const logoAspect = logoImg.width / logoImg.height;
    const logoWidth = Math.min(200, maxLogoWidth); // Cap at 200px or 15%
    const logoHeight = logoWidth / logoAspect;

    const margin = 20 * (Math.max(width, height) / 1000); // Scaled margin

    let x: number, y: number;

    switch (position) {
      case 'bottom-right':
        x = width - logoWidth - margin;
        y = height - logoHeight - margin;
        break;
      case 'bottom-left':
        x = margin;
        y = height - logoHeight - margin;
        break;
      case 'top-right':
        x = width - logoWidth - margin;
        y = margin;
        break;
      case 'top-left':
        x = margin;
        y = margin;
        break;
      default:
        x = width - logoWidth - margin;
        y = height - logoHeight - margin;
    }

    ctx.drawImage(logoImg, x, y, logoWidth, logoHeight);

  } catch (e) {
    console.error('[Logo] Error adding logo:', e);
  }
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
  if (!state.resultBlob || !state.file) return;

  const originalName = state.file.name.replace(/\.[^/.]+$/, '');
  const ext = state.file.name.split('.').pop();
  const downloadName = `${originalName}_no_watermark.${ext}`;

  downloadFile(state.resultBlob, downloadName);
}

function resetToUpload() {
  state.file = null;
  state.resultBlob = null;
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
  const defaultPosition = document.querySelector(
    'input[name="watermark-position"][value="bottom-right"]'
  ) as HTMLInputElement;
  if (defaultPosition) defaultPosition.checked = true;
  state.position = 'bottom-right';

  const defaultLogo = document.querySelector(
    'input[name="logo-preset"][value="none"]'
  ) as HTMLInputElement;
  if (defaultLogo) defaultLogo.checked = true;
  state.logoPreset = 'none';
}
