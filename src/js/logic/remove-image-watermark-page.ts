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

// API endpoint - empty string makes relative URLs work behind the Nginx proxy.
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

interface WatermarkRemoverState {
  file: File | null;
  selectionBox: { x: number; y: number; width: number; height: number } | null;
  method: 'ai' | 'blur';
  blurRadius: number; // 5, 10, 15 for light/medium/heavy
  logoPreset: 'none' | 'lakeb2b' | 'champions' | 'ampliz';
  logoScale: number;
  // Normalized top-left of the logo within the image area (0-1). null = anchor
  // to the selection box (legacy behaviour). Set when the user drags the logo.
  logoPos: { xFrac: number; yFrac: number } | null;
  isProcessing: boolean;
  resultBlob: Blob | null;
  previewCanvas: HTMLCanvasElement | null;
  imgNaturalWidth: number;
  imgNaturalHeight: number;
  isDrawing: boolean;
  drawStartX: number;
  drawStartY: number;
}

const state: WatermarkRemoverState = {
  file: null,
  selectionBox: null,
  method: 'ai', // Default: AI inpaint (server)
  blurRadius: 10, // Default: medium blur
  logoPreset: 'none',
  logoScale: 1.0,
  logoPos: null,
  isProcessing: false,
  resultBlob: null,
  previewCanvas: null,
  imgNaturalWidth: 0,
  imgNaturalHeight: 0,
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

  // Removal method radio buttons (ai = server inpaint, blur = local)
  document.querySelectorAll('input[name="removal-method"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.method = (e.target as HTMLInputElement).value as 'ai' | 'blur';
      updateMethodVisibility();
    });
  });
  updateMethodVisibility();

  // Auto-detect watermark button
  document
    .getElementById('auto-detect-btn')
    ?.addEventListener('click', handleAutoDetect);

  // Logo preset radio buttons
  document.querySelectorAll('input[name="logo-preset"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.logoPreset = (e.target as HTMLInputElement)
        .value as typeof state.logoPreset;
      void updateLogoOverlay();
    });
  });

  // Logo scale slider (50–200% of default size; 1.0 = default)
  const logoScaleEl = document.getElementById(
    'logo-scale'
  ) as HTMLInputElement | null;
  const logoScaleValueEl = document.getElementById('logo-scale-value');
  logoScaleEl?.addEventListener('input', () => {
    const pct = parseInt(logoScaleEl.value, 10) || 100;
    state.logoScale = pct / 100;
    if (logoScaleValueEl) logoScaleValueEl.textContent = `${pct}%`;
    positionLogoOverlay();
  });

  setupLogoDrag();
  window.addEventListener('resize', positionLogoOverlay);

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

    // Remember source dimensions for canvas<->source coordinate mapping.
    state.imgNaturalWidth = img.naturalWidth;
    state.imgNaturalHeight = img.naturalHeight;

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

    // If a logo is already chosen, show its draggable preview.
    void updateLogoOverlay();
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
  document.getElementById('logo-overlay')?.classList.add('hidden');
  document.getElementById('logo-drag-hint')?.classList.add('hidden');
  document.getElementById('processing-status')?.classList.remove('hidden');

  const processBtn = document.getElementById(
    'process-btn'
  ) as HTMLButtonElement;
  if (processBtn) processBtn.disabled = true;

  const progressBar = document.getElementById('progress-bar') as HTMLElement;

  // AI inpaint path is handled server-side.
  if (state.method === 'ai') {
    await runAiRemoval(progressBar, processBtn);
    return;
  }

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

    // Export — preserve the source format for the local blur path.
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

function loadBlobImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

/** Show the blur-intensity options only when the local "blur" method is active. */
function updateMethodVisibility() {
  const group = document.getElementById('blur-intensity-group');
  if (group) group.classList.toggle('hidden', state.method !== 'blur');
}

/** Convert a selection box (canvas coords incl. padding) to source-image pixels. */
function selectionToSourcePixels(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; w: number; h: number } {
  const previewCanvas = state.previewCanvas!;
  const scaledImageWidth = previewCanvas.width - CANVAS_PADDING * 2;
  const scaledImageHeight = previewCanvas.height - CANVAS_PADDING * 2;
  const scaleX = state.imgNaturalWidth / scaledImageWidth;
  const scaleY = state.imgNaturalHeight / scaledImageHeight;

  let x = Math.round((box.x - CANVAS_PADDING) * scaleX);
  let y = Math.round((box.y - CANVAS_PADDING) * scaleY);
  let w = Math.round(box.width * scaleX);
  let h = Math.round(box.height * scaleY);

  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(w, state.imgNaturalWidth - x);
  h = Math.min(h, state.imgNaturalHeight - y);
  return { x, y, w, h };
}

/** Convert a source-pixel box (from server detection) to canvas coords for display. */
function canvasBoxFromSourceBox(src: {
  x: number;
  y: number;
  w: number;
  h: number;
}): { x: number; y: number; width: number; height: number } {
  const previewCanvas = state.previewCanvas!;
  const scaleX =
    (previewCanvas.width - CANVAS_PADDING * 2) / state.imgNaturalWidth;
  const scaleY =
    (previewCanvas.height - CANVAS_PADDING * 2) / state.imgNaturalHeight;
  return {
    x: src.x * scaleX + CANVAS_PADDING,
    y: src.y * scaleY + CANVAS_PADDING,
    width: src.w * scaleX,
    height: src.h * scaleY,
  };
}

function drawOverlayBox(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const overlay = document.getElementById(
    'selection-overlay'
  ) as HTMLCanvasElement;
  if (!overlay) return;
  const ctx = overlay.getContext('2d')!;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.fillStyle = 'rgba(255, 165, 0, 0.3)';
  ctx.strokeStyle = 'rgba(255, 165, 0, 1)';
  ctx.lineWidth = 2;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeRect(box.x, box.y, box.width, box.height);
}

/** Ask the server to locate a known watermark and pre-fill the selection. */
async function handleAutoDetect() {
  if (!state.file) {
    showAlert('No File', 'Please select an image first.');
    return;
  }
  const btn = document.getElementById('auto-detect-btn') as HTMLButtonElement;
  if (btn) btn.disabled = true;

  try {
    const formData = new FormData();
    formData.append('file', state.file);
    const res = await fetch(`${API_BASE_URL}/api/detect-watermark`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const err = await res
        .json()
        .catch(() => ({ detail: 'Detection failed' }));
      throw new Error(err.detail || `Server error: ${res.status}`);
    }
    const data = await res.json();
    if (!data.has_templates) {
      showAlert(
        'Auto-detect unavailable',
        'No watermark reference is installed on the server. Draw a selection manually, or add a template under backend/assets/watermark_templates.'
      );
      return;
    }
    if (!data.detections || data.detections.length === 0) {
      showAlert(
        'No watermark found',
        'Could not detect a known watermark. Please drag to select it manually.'
      );
      return;
    }
    const d = data.detections[0];
    const canvasBox = canvasBoxFromSourceBox({
      x: d.x,
      y: d.y,
      w: d.w,
      h: d.h,
    });
    state.selectionBox = canvasBox;
    drawOverlayBox(canvasBox);

    const processBtn = document.getElementById(
      'process-btn'
    ) as HTMLButtonElement;
    if (processBtn) processBtn.disabled = false;
  } catch (e) {
    showAlert(
      'Auto-detect failed',
      (e as Error).message || 'Could not reach the server.'
    );
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Composite a replacement logo over a cleaned image and return a PNG blob. */
async function compositeLogo(
  blob: Blob,
  selectionBox: { x: number; y: number; width: number; height: number }
): Promise<Blob> {
  const img = await loadBlobImage(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  await addReplacementLogo(
    ctx,
    canvas.width,
    canvas.height,
    state.logoPreset,
    selectionBox
  );
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to export image'))),
      'image/png'
    );
  });
}

/** Server-side AI inpainting (LaMa) path. */
async function runAiRemoval(
  progressBar: HTMLElement | null,
  processBtn: HTMLButtonElement | null
) {
  try {
    updateStatus('Uploading...', 'Sending to AI inpainting server');
    if (progressBar) progressBar.style.width = '20%';

    const region = selectionToSourcePixels(state.selectionBox!);
    const formData = new FormData();
    formData.append('file', state.file!);
    formData.append('regions', JSON.stringify([region]));

    const res = await fetch(`${API_BASE_URL}/api/remove-image-watermark`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || `Server error: ${res.status}`);
    }

    if (progressBar) progressBar.style.width = '70%';
    let blob = await res.blob();

    if (state.logoPreset !== 'none' && state.selectionBox) {
      updateStatus('Adding logo...', `Placing ${state.logoPreset} logo`);
      blob = await compositeLogo(blob, state.selectionBox);
    }

    state.resultBlob = blob;
    if (progressBar) progressBar.style.width = '100%';
    updateStatus('Complete!', 'Watermark removed with AI inpainting');
    setTimeout(() => showDownloadSection(), 400);
  } catch (e) {
    console.error('AI removal error:', e);
    showErrorSection((e as Error).message || 'Failed to process image');
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
/* ── Draggable logo overlay (issue #41: move + size the logo) ────────────── */

let logoAspectRatio = 1;
let logoDragging = false;
let logoDragDX = 0;
let logoDragDY = 0;

/** The displayed image area (excluding canvas padding) in client coordinates. */
function imgAreaRect() {
  const c = state.previewCanvas!;
  const r = c.getBoundingClientRect();
  const s = r.width / c.width; // client px per internal canvas px
  return {
    left: r.left + CANVAS_PADDING * s,
    top: r.top + CANVAS_PADDING * s,
    w: (c.width - CANVAS_PADDING * 2) * s,
    h: (c.height - CANVAS_PADDING * 2) * s,
    s,
  };
}

/** Show/hide + (re)load the logo overlay when the preset changes. */
async function updateLogoOverlay() {
  const overlay = document.getElementById(
    'logo-overlay'
  ) as HTMLImageElement | null;
  const hint = document.getElementById('logo-drag-hint');
  if (!overlay) return;

  const url = LOGO_URLS[state.logoPreset];
  if (!url || !state.previewCanvas) {
    overlay.classList.add('hidden');
    hint?.classList.add('hidden');
    return;
  }

  await new Promise<void>((resolve) => {
    overlay.onload = () => {
      logoAspectRatio =
        overlay.naturalWidth / Math.max(1, overlay.naturalHeight);
      resolve();
    };
    overlay.onerror = () => resolve();
    overlay.src = url;
  });

  if (!state.logoPos) state.logoPos = { xFrac: 0.62, yFrac: 0.82 };
  overlay.classList.remove('hidden');
  hint?.classList.remove('hidden');
  positionLogoOverlay();
}

/** Place the overlay over the image area according to logoPos + logoScale. */
function positionLogoOverlay() {
  const overlay = document.getElementById(
    'logo-overlay'
  ) as HTMLImageElement | null;
  if (
    !overlay ||
    overlay.classList.contains('hidden') ||
    !state.previewCanvas ||
    !state.logoPos
  )
    return;

  const c = state.previewCanvas;
  const s = c.clientWidth / c.width;
  const areaLeft = c.offsetLeft + CANVAS_PADDING * s;
  const areaTop = c.offsetTop + CANVAS_PADDING * s;
  const areaW = (c.width - CANVAS_PADDING * 2) * s;
  const areaH = (c.height - CANVAS_PADDING * 2) * s;

  const logoWidthImg =
    Math.min(200, state.imgNaturalWidth * 0.15) * state.logoScale;
  const wClient = logoWidthImg * (areaW / Math.max(1, state.imgNaturalWidth));
  const hClient = wClient / (logoAspectRatio || 1);

  state.logoPos.xFrac = Math.min(
    Math.max(state.logoPos.xFrac, 0),
    Math.max(0, 1 - wClient / areaW)
  );
  state.logoPos.yFrac = Math.min(
    Math.max(state.logoPos.yFrac, 0),
    Math.max(0, 1 - hClient / areaH)
  );

  overlay.style.width = `${wClient}px`;
  overlay.style.height = `${hClient}px`;
  overlay.style.left = `${areaLeft + state.logoPos.xFrac * areaW}px`;
  overlay.style.top = `${areaTop + state.logoPos.yFrac * areaH}px`;
}

function setupLogoDrag() {
  const overlay = document.getElementById(
    'logo-overlay'
  ) as HTMLImageElement | null;
  if (!overlay) return;

  const start = (x: number, y: number) => {
    const r = overlay.getBoundingClientRect();
    logoDragging = true;
    logoDragDX = x - r.left;
    logoDragDY = y - r.top;
  };
  const move = (x: number, y: number) => {
    if (!logoDragging || !state.logoPos) return;
    const area = imgAreaRect();
    state.logoPos.xFrac = (x - logoDragDX - area.left) / area.w;
    state.logoPos.yFrac = (y - logoDragDY - area.top) / area.h;
    positionLogoOverlay();
  };
  const end = () => {
    logoDragging = false;
  };

  overlay.addEventListener('mousedown', (e) => {
    e.preventDefault();
    start(e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
  document.addEventListener('mouseup', end);
  overlay.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      start(t.clientX, t.clientY);
    },
    { passive: true }
  );
  overlay.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      const t = e.touches[0];
      move(t.clientX, t.clientY);
    },
    { passive: false }
  );
  overlay.addEventListener('touchend', end);
}

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
    const baseLogoWidth = Math.min(200, maxLogoWidth);
    const logoWidth = baseLogoWidth * state.logoScale;
    const logoHeight = logoWidth / logoAspect;

    // Use the dragged position when set (issue #41); otherwise fall back to the
    // bottom of the selection box.
    let x: number;
    let y: number;
    if (state.logoPos) {
      x = state.logoPos.xFrac * width;
      y = state.logoPos.yFrac * height;
    } else {
      x = actualSelection.x;
      y = actualSelection.y + actualSelection.height - logoHeight;
    }

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
  // AI inpainting always returns PNG; local blur preserves the source format.
  const ext = state.method === 'ai' ? 'png' : state.file.name.split('.').pop();
  const downloadName = `${originalName}_no_watermark.${ext}`;

  downloadFile(state.resultBlob, downloadName);
}

function resetToUpload() {
  state.file = null;
  state.resultBlob = null;
  state.isProcessing = false;
  state.selectionBox = null;
  state.previewCanvas = null;
  state.logoPos = null;
  document.getElementById('logo-overlay')?.classList.add('hidden');
  document.getElementById('logo-drag-hint')?.classList.add('hidden');

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

  const defaultMethod = document.querySelector(
    'input[name="removal-method"][value="ai"]'
  ) as HTMLInputElement;
  if (defaultMethod) defaultMethod.checked = true;
  state.method = 'ai';
  updateMethodVisibility();
}
