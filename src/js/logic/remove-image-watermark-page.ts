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

/** A selection rectangle in preview-canvas pixels (including CANVAS_PADDING). */
type Box = { x: number; y: number; width: number; height: number };

interface WatermarkRemoverState {
  file: File | null;
  /** All watermark regions the user has marked, in canvas pixels. */
  selections: Box[];
  /** Index of the highlighted box (the one with resize handles); -1 = none. */
  activeIndex: number;
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
}

const state: WatermarkRemoverState = {
  file: null,
  selections: [],
  activeIndex: -1,
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
};

/** The highlighted box, falling back to the first one. Used to anchor the logo. */
function activeBox(): Box | null {
  if (state.selections.length === 0) return null;
  const i =
    state.activeIndex >= 0 && state.activeIndex < state.selections.length
      ? state.activeIndex
      : 0;
  return state.selections[i];
}

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

  // Clear all boxes / remove the highlighted box
  document
    .getElementById('clear-selection-btn')
    ?.addEventListener('click', () => clearSelections());
  document
    .getElementById('delete-box-btn')
    ?.addEventListener('click', () => deleteActiveBox());

  // Delete/Backspace removes the highlighted box, Escape un-highlights it.
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' ||
        t.isContentEditable)
    ) {
      return;
    }
    if (!state.previewCanvas || state.selections.length === 0) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (deleteActiveBox()) e.preventDefault();
    } else if (e.key === 'Escape') {
      state.activeIndex = -1;
      renderSelections();
      syncSelectionUi();
    }
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

    // Size canvas to fit the card while maintaining aspect ratio. The canvas
    // is also CSS-scaled (max-w-full) on narrow screens; pointer maths in the
    // selection editor converts screen px -> canvas px, so any scale is fine.
    const container = canvas.parentElement?.parentElement;
    const available = container
      ? Math.max(200, container.clientWidth - CANVAS_PADDING * 2)
      : 800;
    const maxWidth = Math.min(800, available);
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

/* ── Selection editor: several boxes, draw / move / resize with pointer events ── */

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLE_IDS: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/** Boxes smaller than this (canvas px) are treated as a click, not a selection. */
const MIN_BOX_PX = 8;
/** Screen-pixel radius within which a pointer grabs a resize handle. */
const HANDLE_GRAB_CSS_PX = 10;
const HANDLE_SIZE_CSS_PX = 9;

type Drag =
  | { kind: 'draw'; startX: number; startY: number }
  | { kind: 'move'; index: number; offsetX: number; offsetY: number }
  | { kind: 'resize'; index: number; handle: HandleId; start: Box };

let overlayEl: HTMLCanvasElement | null = null;
let drag: Drag | null = null;
let editorBound = false;

/** Internal canvas px per CSS px (the overlay is CSS-scaled to the card width). */
function overlayScale(): number {
  const o = overlayEl;
  if (!o || o.clientWidth === 0) return 1;
  return o.width / o.clientWidth;
}

/** Screen coordinates -> canvas pixels, correcting for CSS scaling and the border. */
function pointerToCanvas(e: { clientX: number; clientY: number }): {
  x: number;
  y: number;
} {
  const o = overlayEl!;
  const r = o.getBoundingClientRect();
  const s = overlayScale();
  return {
    x: (e.clientX - r.left - o.clientLeft) * s,
    y: (e.clientY - r.top - o.clientTop) * s,
  };
}

function clampPoint(p: { x: number; y: number }): { x: number; y: number } {
  const o = overlayEl!;
  return {
    x: Math.min(Math.max(p.x, 0), o.width),
    y: Math.min(Math.max(p.y, 0), o.height),
  };
}

function normalizeBox(x1: number, y1: number, x2: number, y2: number): Box {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** Keep a box inside the canvas (padding included) without changing its size. */
function clampBox(b: Box): Box {
  const o = overlayEl!;
  const width = Math.min(b.width, o.width);
  const height = Math.min(b.height, o.height);
  return {
    x: Math.min(Math.max(b.x, 0), o.width - width),
    y: Math.min(Math.max(b.y, 0), o.height - height),
    width,
    height,
  };
}

function handlePoints(b: Box): Record<HandleId, { x: number; y: number }> {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const r = b.x + b.width;
  const btm = b.y + b.height;
  return {
    nw: { x: b.x, y: b.y },
    n: { x: cx, y: b.y },
    ne: { x: r, y: b.y },
    e: { x: r, y: cy },
    se: { x: r, y: btm },
    s: { x: cx, y: btm },
    sw: { x: b.x, y: btm },
    w: { x: b.x, y: cy },
  };
}

function hitHandle(b: Box, p: { x: number; y: number }): HandleId | null {
  const tol = HANDLE_GRAB_CSS_PX * overlayScale();
  const pts = handlePoints(b);
  for (const id of HANDLE_IDS) {
    const h = pts[id];
    if (Math.abs(p.x - h.x) <= tol && Math.abs(p.y - h.y) <= tol) return id;
  }
  return null;
}

function insideBox(b: Box, p: { x: number; y: number }): boolean {
  return (
    p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
  );
}

/** Index of the box under the pointer: the highlighted one wins, then the topmost. */
function boxAt(p: { x: number; y: number }): number {
  const a = state.activeIndex;
  if (
    a >= 0 &&
    a < state.selections.length &&
    insideBox(state.selections[a], p)
  )
    return a;
  for (let i = state.selections.length - 1; i >= 0; i--) {
    if (insideBox(state.selections[i], p)) return i;
  }
  return -1;
}

function cursorForHandle(h: HandleId): string {
  if (h === 'nw' || h === 'se') return 'nwse-resize';
  if (h === 'ne' || h === 'sw') return 'nesw-resize';
  if (h === 'n' || h === 's') return 'ns-resize';
  return 'ew-resize';
}

function updateCursor(p: { x: number; y: number }) {
  const o = overlayEl!;
  const active = activeBox();
  if (active) {
    const h = hitHandle(active, p);
    if (h) {
      o.style.cursor = cursorForHandle(h);
      return;
    }
  }
  o.style.cursor = boxAt(p) >= 0 ? 'move' : 'crosshair';
}

function onPointerDown(e: PointerEvent) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (!overlayEl || drag) return;
  e.preventDefault();
  const p = pointerToCanvas(e);

  // 1. A handle of the highlighted box -> resize.
  const active = activeBox();
  if (active) {
    const h = hitHandle(active, p);
    if (h) {
      drag = {
        kind: 'resize',
        index: state.selections.indexOf(active),
        handle: h,
        start: { ...active },
      };
      overlayEl.setPointerCapture(e.pointerId);
      overlayEl.style.cursor = cursorForHandle(h);
      return;
    }
  }

  // 2. Inside an existing box -> highlight it and move.
  const idx = boxAt(p);
  if (idx >= 0) {
    const b = state.selections[idx];
    state.activeIndex = idx;
    drag = { kind: 'move', index: idx, offsetX: p.x - b.x, offsetY: p.y - b.y };
    overlayEl.setPointerCapture(e.pointerId);
    overlayEl.style.cursor = 'move';
    renderSelections();
    syncSelectionUi();
    return;
  }

  // 3. Empty area -> start a new box.
  const c = clampPoint(p);
  drag = { kind: 'draw', startX: c.x, startY: c.y };
  state.selections.push({ x: c.x, y: c.y, width: 0, height: 0 });
  state.activeIndex = state.selections.length - 1;
  overlayEl.setPointerCapture(e.pointerId);
  renderSelections();
}

function onPointerMove(e: PointerEvent) {
  if (!overlayEl) return;
  const p = pointerToCanvas(e);
  if (!drag) {
    updateCursor(p);
    return;
  }
  e.preventDefault();
  const c = clampPoint(p);
  if (drag.kind === 'draw') {
    state.selections[state.selections.length - 1] = normalizeBox(
      drag.startX,
      drag.startY,
      c.x,
      c.y
    );
  } else if (drag.kind === 'move') {
    const b = state.selections[drag.index];
    state.selections[drag.index] = clampBox({
      x: p.x - drag.offsetX,
      y: p.y - drag.offsetY,
      width: b.width,
      height: b.height,
    });
  } else {
    const st = drag.start;
    let left = st.x;
    let top = st.y;
    let right = st.x + st.width;
    let bottom = st.y + st.height;
    if (drag.handle.includes('w')) left = c.x;
    if (drag.handle.includes('e')) right = c.x;
    if (drag.handle.includes('n')) top = c.y;
    if (drag.handle.includes('s')) bottom = c.y;
    state.selections[drag.index] = normalizeBox(left, top, right, bottom);
  }
  renderSelections();
}

function onPointerUp(e: PointerEvent) {
  if (!overlayEl || !drag) return;
  e.preventDefault();
  if (overlayEl.hasPointerCapture(e.pointerId)) {
    overlayEl.releasePointerCapture(e.pointerId);
  }
  const p = pointerToCanvas(e);
  const cancelled = e.type === 'pointercancel';

  if (drag.kind === 'draw') {
    const b = state.selections[state.selections.length - 1];
    if (cancelled || b.width < MIN_BOX_PX || b.height < MIN_BOX_PX) {
      // A click (or a cancelled drag): drop the stub and treat it as "select
      // whatever is under the pointer", or clear the highlight on empty space.
      state.selections.pop();
      state.activeIndex = cancelled ? -1 : boxAt(p);
    }
  } else if (drag.kind === 'resize') {
    const b = state.selections[drag.index];
    if (cancelled || b.width < MIN_BOX_PX || b.height < MIN_BOX_PX) {
      state.selections[drag.index] = drag.start;
    }
  }
  drag = null;
  updateCursor(p);
  renderSelections();
  syncSelectionUi();
}

/** Draw every box; the highlighted one gets resize handles. */
function renderSelections() {
  const o = overlayEl;
  if (!o) return;
  const ctx = o.getContext('2d')!;
  ctx.clearRect(0, 0, o.width, o.height);
  const s = overlayScale();
  const active = activeBox();

  state.selections.forEach((b, i) => {
    const isActive = b === active;
    ctx.fillStyle = isActive
      ? 'rgba(255, 165, 0, 0.32)'
      : 'rgba(255, 165, 0, 0.18)';
    ctx.strokeStyle = isActive
      ? 'rgba(255, 165, 0, 1)'
      : 'rgba(255, 165, 0, 0.75)';
    ctx.lineWidth = 2 * s;
    ctx.fillRect(b.x, b.y, b.width, b.height);
    ctx.strokeRect(b.x, b.y, b.width, b.height);

    if (state.selections.length > 1 && b.width > 18 * s && b.height > 18 * s) {
      // Small index badge so the user can tell the boxes apart.
      const size = 16 * s;
      ctx.fillStyle = isActive
        ? 'rgba(255, 165, 0, 1)'
        : 'rgba(255, 165, 0, 0.75)';
      ctx.fillRect(b.x, b.y, size, size);
      ctx.fillStyle = '#111';
      ctx.font = `bold ${11 * s}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), b.x + size / 2, b.y + size / 2 + s);
    }
  });

  if (active && drag?.kind !== 'draw') {
    const half = (HANDLE_SIZE_CSS_PX * s) / 2;
    const pts = handlePoints(active);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(255, 140, 0, 1)';
    ctx.lineWidth = 1.5 * s;
    for (const id of HANDLE_IDS) {
      const h = pts[id];
      ctx.fillRect(h.x - half, h.y - half, half * 2, half * 2);
      ctx.strokeRect(h.x - half, h.y - half, half * 2, half * 2);
    }
  }
}

/** Enable the process button and update the counter / delete button. */
function syncSelectionUi() {
  const n = state.selections.length;
  const processBtn = document.getElementById(
    'process-btn'
  ) as HTMLButtonElement | null;
  if (processBtn) processBtn.disabled = n === 0;

  const deleteBtn = document.getElementById(
    'delete-box-btn'
  ) as HTMLButtonElement | null;
  if (deleteBtn) deleteBtn.disabled = !activeBox();

  const count = document.getElementById('selection-count');
  if (count) {
    count.textContent =
      n === 0
        ? 'No area selected yet'
        : n === 1
          ? '1 area selected'
          : `${n} areas selected`;
  }
}

/** Remove the highlighted box. Returns true if something was removed. */
function deleteActiveBox(): boolean {
  const active = activeBox();
  if (!active) return false;
  const idx = state.selections.indexOf(active);
  state.selections.splice(idx, 1);
  state.activeIndex = state.selections.length
    ? Math.min(idx, state.selections.length - 1)
    : -1;
  renderSelections();
  syncSelectionUi();
  return true;
}

function clearSelections() {
  state.selections = [];
  state.activeIndex = -1;
  renderSelections();
  syncSelectionUi();
}

/**
 * Size the overlay to the preview canvas and bind the editor once. Loading a
 * new image resets the boxes.
 */
function setupSelectionOverlay(canvas: HTMLCanvasElement) {
  const overlay = document.getElementById(
    'selection-overlay'
  ) as HTMLCanvasElement | null;
  if (!overlay) return;

  overlay.width = canvas.width;
  overlay.height = canvas.height;
  overlay.style.cursor = 'crosshair';
  overlay.style.touchAction = 'none';
  overlayEl = overlay;
  drag = null;

  if (!editorBound) {
    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('pointercancel', onPointerUp);
    overlay.addEventListener('pointerleave', () => {
      if (!drag) overlay.style.cursor = 'crosshair';
    });
    // Stop the browser from scrolling/zooming while drawing on touch screens.
    overlay.addEventListener('touchstart', (e) => e.preventDefault(), {
      passive: false,
    });
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    editorBound = true;
  }

  clearSelections();
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

  if (state.selections.length === 0) {
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

    // Blur every marked area
    for (const box of state.selections) {
      removeWatermark(ctx, canvas.width, canvas.height, box);
    }

    // Add replacement logo if selected (anchored to the highlighted box)
    if (state.logoPreset !== 'none') {
      updateStatus('Adding logo...', `Placing ${state.logoPreset} logo`);
      if (progressBar) progressBar.style.width = '70%';
      await addReplacementLogo(
        ctx,
        canvas.width,
        canvas.height,
        state.logoPreset,
        activeBox()!
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
function selectionToSourcePixels(box: Box): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
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
}): Box {
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
    // Add every detection as its own box (the user can still adjust or
    // delete them), highlighting the first new one.
    const firstNew = state.selections.length;
    for (const d of data.detections as {
      x: number;
      y: number;
      w: number;
      h: number;
    }[]) {
      state.selections.push(
        canvasBoxFromSourceBox({ x: d.x, y: d.y, w: d.w, h: d.h })
      );
    }
    state.activeIndex = firstNew;
    renderSelections();
    syncSelectionUi();
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
async function compositeLogo(blob: Blob, selectionBox: Box): Promise<Blob> {
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

    const regions = state.selections
      .map(selectionToSourcePixels)
      .filter((r) => r.w > 0 && r.h > 0);
    if (regions.length === 0) {
      throw new Error('The selected area lies outside the image.');
    }
    const formData = new FormData();
    formData.append('file', state.file!);
    formData.append('regions', JSON.stringify(regions));

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

    const anchor = activeBox();
    if (state.logoPreset !== 'none' && anchor) {
      updateStatus('Adding logo...', `Placing ${state.logoPreset} logo`);
      blob = await compositeLogo(blob, anchor);
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
  selectionBox: Box
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
  selectionBox: Box
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
  state.selections = [];
  state.activeIndex = -1;
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
