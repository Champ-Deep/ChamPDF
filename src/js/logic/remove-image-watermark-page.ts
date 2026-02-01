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
  selectionBox: { x: number; y: number; width: number; height: number } | null;
  blurRadius: number; // 5, 10, 15 for light/medium/heavy
  logoPreset: 'none' | 'lakeb2b' | 'champions' | 'ampliz';
  isProcessing: boolean;
  resultBlob: Blob | null;
  previewCanvas: HTMLCanvasElement | null;
  isDrawing: boolean;
  drawStartX: number;
  drawStartY: number;
}

const state: WatermarkRemoverState = {
  file: null,
  selectionBox: null,
  blurRadius: 10, // Default: medium blur
  logoPreset: 'none',
  isProcessing: false,
  resultBlob: null,
  previewCanvas: null,
  isDrawing: false,
  drawStartX: 0,
  drawStartY: 0,
};

// Logo images served from public folder (with BASE_URL for Vite)
const LOGO_URLS: Record<string, string> = {
  lakeb2b: `${import.meta.env.BASE_URL}logos/lakeb2b.png`,
  champions: `${import.meta.env.BASE_URL}logos/champions.png`,
  ampliz: `${import.meta.env.BASE_URL}logos/ampliz.png`,
};

// Padding around preview canvas for easier edge/corner selection
const CANVAS_PADDING = 30;

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

  // Blur intensity radio buttons
  document.querySelectorAll('input[name="blur-intensity"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.blurRadius = parseInt((e.target as HTMLInputElement).value, 10);
    });
  });

  // Logo preset radio buttons
  document.querySelectorAll('input[name="logo-preset"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.logoPreset = (e.target as HTMLInputElement)
        .value as typeof state.logoPreset;
    });
  });

  // Clear selection button
  document
    .getElementById('clear-selection-btn')
    ?.addEventListener('click', () => {
      state.selectionBox = null;

      // Clear overlay canvas
      const overlayCanvas = document.getElementById(
        'selection-overlay'
      ) as HTMLCanvasElement;
      if (overlayCanvas) {
        const ctx = overlayCanvas.getContext('2d')!;
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      }

      // Disable process button until new selection made
      const processBtn = document.getElementById(
        'process-btn'
      ) as HTMLButtonElement;
      if (processBtn) processBtn.disabled = true;

      showAlert('Selection Cleared', 'Drag to select a new watermark area.');
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
  setupCanvasPreview(file);
  showOptionsSection();
}

/**
 * Display image on canvas and setup selection overlay
 * Pattern from redact-pdf-page.ts lines 203-223
 */
function setupCanvasPreview(file: File) {
  const img = new Image();
  img.onload = () => {
    // Create main canvas
    const canvas = document.getElementById(
      'preview-canvas'
    ) as HTMLCanvasElement;
    if (!canvas) return;

    const ctx = canvas.getContext('2d')!;

    // Size canvas to fit container while maintaining aspect ratio
    const maxWidth = 800;
    const maxHeight = 600;
    const scale = Math.min(
      maxWidth / img.naturalWidth,
      maxHeight / img.naturalHeight,
      1 // Don't upscale small images
    );

    // Calculate scaled image dimensions (before padding)
    const scaledWidth = img.naturalWidth * scale;
    const scaledHeight = img.naturalHeight * scale;

    // Add padding to canvas dimensions
    canvas.width = scaledWidth + CANVAS_PADDING * 2;
    canvas.height = scaledHeight + CANVAS_PADDING * 2;

    // Draw image centered with padding offset
    ctx.drawImage(
      img,
      CANVAS_PADDING,
      CANVAS_PADDING,
      scaledWidth,
      scaledHeight
    );

    state.previewCanvas = canvas;

    // Setup selection overlay
    setupSelectionOverlay(canvas);
  };

  img.src = URL.createObjectURL(file);
}

/**
 * Setup interactive selection rectangle
 * Pattern from redact-pdf-page.ts lines 236-299
 */
function setupSelectionOverlay(canvas: HTMLCanvasElement) {
  const overlayCanvas = document.getElementById(
    'selection-overlay'
  ) as HTMLCanvasElement;
  if (!overlayCanvas) return;

  overlayCanvas.width = canvas.width;
  overlayCanvas.height = canvas.height;
  overlayCanvas.style.cursor = 'crosshair';

  const overlayCtx = overlayCanvas.getContext('2d')!;

  // Mouse down: start selection
  overlayCanvas.addEventListener('mousedown', (e) => {
    const rect = overlayCanvas.getBoundingClientRect();
    state.drawStartX = e.clientX - rect.left;
    state.drawStartY = e.clientY - rect.top;
    state.isDrawing = true;
  });

  // Mouse move: draw preview rectangle
  overlayCanvas.addEventListener('mousemove', (e) => {
    if (!state.isDrawing) return;

    const rect = overlayCanvas.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    // Clear and redraw
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    // Draw semi-transparent selection box
    overlayCtx.fillStyle = 'rgba(255, 165, 0, 0.3)'; // Orange 30% opacity
    overlayCtx.strokeStyle = 'rgba(255, 165, 0, 1)'; // Orange border
    overlayCtx.lineWidth = 2;

    const width = currentX - state.drawStartX;
    const height = currentY - state.drawStartY;

    overlayCtx.fillRect(state.drawStartX, state.drawStartY, width, height);
    overlayCtx.strokeRect(state.drawStartX, state.drawStartY, width, height);
  });

  // Mouse up: finalize selection
  overlayCanvas.addEventListener('mouseup', (e) => {
    if (!state.isDrawing) return;

    const rect = overlayCanvas.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    // Normalize rectangle (handle dragging in any direction)
    const width = currentX - state.drawStartX;
    const height = currentY - state.drawStartY;

    const normalizedX = width < 0 ? currentX : state.drawStartX;
    const normalizedY = height < 0 ? currentY : state.drawStartY;
    const normalizedWidth = Math.abs(width);
    const normalizedHeight = Math.abs(height);

    // Minimum size check (avoid tiny accidental selections)
    if (normalizedWidth >= 10 && normalizedHeight >= 10) {
      // Store selection in canvas coordinates
      state.selectionBox = {
        x: normalizedX,
        y: normalizedY,
        width: normalizedWidth,
        height: normalizedHeight,
      };

      // Enable process button
      const processBtn = document.getElementById(
        'process-btn'
      ) as HTMLButtonElement;
      if (processBtn) processBtn.disabled = false;
    }

    state.isDrawing = false;
  });

  // Touch support (for mobile)
  overlayCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const rect = overlayCanvas.getBoundingClientRect();
    state.drawStartX = touch.clientX - rect.left;
    state.drawStartY = touch.clientY - rect.top;
    state.isDrawing = true;
  });

  overlayCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!state.isDrawing) return;

    const touch = e.touches[0];
    const rect = overlayCanvas.getBoundingClientRect();
    const currentX = touch.clientX - rect.left;
    const currentY = touch.clientY - rect.top;

    // Same drawing logic as mousemove
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.fillStyle = 'rgba(255, 165, 0, 0.3)';
    overlayCtx.strokeStyle = 'rgba(255, 165, 0, 1)';
    overlayCtx.lineWidth = 2;

    const width = currentX - state.drawStartX;
    const height = currentY - state.drawStartY;

    overlayCtx.fillRect(state.drawStartX, state.drawStartY, width, height);
    overlayCtx.strokeRect(state.drawStartX, state.drawStartY, width, height);
  });

  overlayCanvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    // Same finalization logic as mouseup
    if (!state.isDrawing) return;

    const touch = e.changedTouches[0];
    const rect = overlayCanvas.getBoundingClientRect();
    const currentX = touch.clientX - rect.left;
    const currentY = touch.clientY - rect.top;

    const width = currentX - state.drawStartX;
    const height = currentY - state.drawStartY;

    const normalizedX = width < 0 ? currentX : state.drawStartX;
    const normalizedY = height < 0 ? currentY : state.drawStartY;
    const normalizedWidth = Math.abs(width);
    const normalizedHeight = Math.abs(height);

    if (normalizedWidth >= 10 && normalizedHeight >= 10) {
      state.selectionBox = {
        x: normalizedX,
        y: normalizedY,
        width: normalizedWidth,
        height: normalizedHeight,
      };

      const processBtn = document.getElementById(
        'process-btn'
      ) as HTMLButtonElement;
      if (processBtn) processBtn.disabled = false;
    }

    state.isDrawing = false;
  });
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
  document.getElementById('preview-section')?.classList.remove('hidden');
  document.getElementById('options-section')?.classList.remove('hidden');
  document.getElementById('download-section')?.classList.add('hidden');
  document.getElementById('error-section')?.classList.add('hidden');
  document.getElementById('processing-status')?.classList.add('hidden');

  // Disable process button until selection is made
  const processBtn = document.getElementById(
    'process-btn'
  ) as HTMLButtonElement;
  if (processBtn) processBtn.disabled = true;
}

async function handleProcess() {
  if (!state.file) {
    showAlert('No File', 'Please select an image file first.');
    return;
  }

  if (!state.selectionBox) {
    showAlert('No Selection', 'Please drag to select the watermark area.');
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
    removeWatermark(ctx, canvas.width, canvas.height, state.selectionBox);

    // Add replacement logo if selected
    if (state.logoPreset !== 'none') {
      updateStatus('Adding logo...', `Placing ${state.logoPreset} logo`);
      if (progressBar) progressBar.style.width = '70%';
      await addReplacementLogo(
        ctx,
        canvas.width,
        canvas.height,
        state.logoPreset,
        state.selectionBox
      );
    }

    if (progressBar) progressBar.style.width = '100%';

    // Export
    const mimeType =
      state.file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
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
 * Remove watermark using Gaussian blur on user-selected region
 */
function removeWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  selectionBox: { x: number; y: number; width: number; height: number }
) {
  const previewCanvas = state.previewCanvas!;

  // Calculate scaled dimensions (excluding padding)
  const scaledImageWidth = previewCanvas.width - CANVAS_PADDING * 2;
  const scaledImageHeight = previewCanvas.height - CANVAS_PADDING * 2;

  const scaleX = width / scaledImageWidth;
  const scaleY = height / scaledImageHeight;

  // Adjust selection coordinates to account for padding offset
  const adjustedSelection = {
    x: selectionBox.x - CANVAS_PADDING,
    y: selectionBox.y - CANVAS_PADDING,
    width: selectionBox.width,
    height: selectionBox.height,
  };

  const actualSelection = {
    x: Math.round(adjustedSelection.x * scaleX),
    y: Math.round(adjustedSelection.y * scaleY),
    width: Math.round(adjustedSelection.width * scaleX),
    height: Math.round(adjustedSelection.height * scaleY),
  };

  // Clamp to canvas bounds
  actualSelection.x = Math.max(0, actualSelection.x);
  actualSelection.y = Math.max(0, actualSelection.y);
  actualSelection.width = Math.min(
    actualSelection.width,
    width - actualSelection.x
  );
  actualSelection.height = Math.min(
    actualSelection.height,
    height - actualSelection.y
  );

  // Get the selected region data
  const selectedData = ctx.getImageData(
    actualSelection.x,
    actualSelection.y,
    actualSelection.width,
    actualSelection.height
  );

  // Apply Gaussian blur (reuse existing function)
  applyGaussianBlur(selectedData, state.blurRadius);

  // Put the blurred data back
  ctx.putImageData(selectedData, actualSelection.x, actualSelection.y);
}

/**
 * Apply Gaussian blur to image data
 * Uses separable convolution for efficiency (horizontal + vertical passes)
 */
function applyGaussianBlur(imageData: ImageData, radius: number) {
  if (radius < 1) return;

  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;

  // Create Gaussian kernel
  const kernel = createGaussianKernel(radius);
  const kernelSize = kernel.length;
  const halfKernel = Math.floor(kernelSize / 2);

  // Temporary buffer for intermediate results
  const tempData = new Uint8ClampedArray(data.length);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        weightSum = 0;

      for (let k = 0; k < kernelSize; k++) {
        const sx = x + k - halfKernel;
        if (sx >= 0 && sx < width) {
          const idx = (y * width + sx) * 4;
          const weight = kernel[k];
          r += data[idx] * weight;
          g += data[idx + 1] * weight;
          b += data[idx + 2] * weight;
          a += data[idx + 3] * weight;
          weightSum += weight;
        }
      }

      const idx = (y * width + x) * 4;
      tempData[idx] = r / weightSum;
      tempData[idx + 1] = g / weightSum;
      tempData[idx + 2] = b / weightSum;
      tempData[idx + 3] = a / weightSum;
    }
  }

  // Vertical pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        weightSum = 0;

      for (let k = 0; k < kernelSize; k++) {
        const sy = y + k - halfKernel;
        if (sy >= 0 && sy < height) {
          const idx = (sy * width + x) * 4;
          const weight = kernel[k];
          r += tempData[idx] * weight;
          g += tempData[idx + 1] * weight;
          b += tempData[idx + 2] * weight;
          a += tempData[idx + 3] * weight;
          weightSum += weight;
        }
      }

      const idx = (y * width + x) * 4;
      data[idx] = r / weightSum;
      data[idx + 1] = g / weightSum;
      data[idx + 2] = b / weightSum;
      data[idx + 3] = a / weightSum;
    }
  }
}

/**
 * Create 1D Gaussian kernel for blur
 */
function createGaussianKernel(radius: number): number[] {
  const sigma = radius / 3;
  const size = radius * 2 + 1;
  const kernel: number[] = [];
  let sum = 0;

  for (let i = 0; i < size; i++) {
    const x = i - radius;
    const value = Math.exp(-(x * x) / (2 * sigma * sigma));
    kernel.push(value);
    sum += value;
  }

  // Normalize kernel
  for (let i = 0; i < size; i++) {
    kernel[i] /= sum;
  }

  return kernel;
}

/**
 * Add replacement logo with smart alignment
 * Aligns logo with bottom of selection box, ensuring it doesn't overflow image
 */
async function addReplacementLogo(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  logoPreset: string,
  selectionBox: { x: number; y: number; width: number; height: number }
) {
  const logoUrl = LOGO_URLS[logoPreset];
  if (!logoUrl) return;

  try {
    const logoImg = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = logoUrl;
    });

    const previewCanvas = state.previewCanvas!;

    // Calculate scaled dimensions (excluding padding)
    const scaledImageWidth = previewCanvas.width - CANVAS_PADDING * 2;
    const scaledImageHeight = previewCanvas.height - CANVAS_PADDING * 2;

    const scaleX = width / scaledImageWidth;
    const scaleY = height / scaledImageHeight;

    // Adjust selection coordinates to account for padding offset
    const adjustedSelection = {
      x: selectionBox.x - CANVAS_PADDING,
      y: selectionBox.y - CANVAS_PADDING,
      width: selectionBox.width,
      height: selectionBox.height,
    };

    const actualSelection = {
      x: Math.round(adjustedSelection.x * scaleX),
      y: Math.round(adjustedSelection.y * scaleY),
      width: Math.round(adjustedSelection.width * scaleX),
      height: Math.round(adjustedSelection.height * scaleY),
    };

    // Calculate logo dimensions maintaining aspect ratio
    const maxLogoWidth = width * 0.15; // 15% of image width
    const logoAspect = logoImg.width / logoImg.height;
    const logoWidth = Math.min(200, maxLogoWidth);
    const logoHeight = logoWidth / logoAspect;

    // Align logo with BOTTOM of selection box
    let x = actualSelection.x;
    let y = actualSelection.y + actualSelection.height - logoHeight;

    // Clamp to image bounds
    x = Math.max(0, Math.min(x, width - logoWidth));
    y = Math.max(0, Math.min(y, height - logoHeight));

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
  state.selectionBox = null;
  state.previewCanvas = null;

  // Hide all sections
  document.getElementById('preview-section')?.classList.add('hidden');
  document.getElementById('options-section')?.classList.add('hidden');
  document.getElementById('processing-status')?.classList.add('hidden');
  document.getElementById('download-section')?.classList.add('hidden');
  document.getElementById('error-section')?.classList.add('hidden');

  // Clear file display
  const fileDisplayArea = document.getElementById('file-display-area');
  if (fileDisplayArea) fileDisplayArea.innerHTML = '';

  // Clear canvases
  const previewCanvas = document.getElementById(
    'preview-canvas'
  ) as HTMLCanvasElement;
  const overlayCanvas = document.getElementById(
    'selection-overlay'
  ) as HTMLCanvasElement;
  if (previewCanvas) {
    const ctx = previewCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  }
  if (overlayCanvas) {
    const ctx = overlayCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  // Reset progress bar
  const progressBar = document.getElementById('progress-bar') as HTMLElement;
  if (progressBar) progressBar.style.width = '0%';

  // Clear file input
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  if (fileInput) fileInput.value = '';

  // Reset radio buttons to defaults
  const defaultBlur = document.querySelector(
    'input[name="blur-intensity"][value="10"]'
  ) as HTMLInputElement;
  if (defaultBlur) defaultBlur.checked = true;
  state.blurRadius = 10;

  const defaultLogo = document.querySelector(
    'input[name="logo-preset"][value="none"]'
  ) as HTMLInputElement;
  if (defaultLogo) defaultLogo.checked = true;
  state.logoPreset = 'none';
}
