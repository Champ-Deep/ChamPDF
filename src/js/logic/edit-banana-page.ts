/**
 * AI Image Editor — two modes over a single image:
 *
 *  1. "Prompt edit"  → describe a change in words; Gemini's image-editing
 *     model applies it. POST image + prompt to /api/edit-image.
 *  2. "Remove (brush)" → paint over a watermark / logo / object; our
 *     self-hosted LaMa inpainting model reconstructs the area. POST image +
 *     a 1-channel mask (white = remove) to /api/inpaint.
 *
 * Both paths are server-side. If the backend isn't configured for a mode the
 * endpoint returns a 4xx/503 and we surface that clearly.
 */

import { showAlert } from '../ui.js';
import { downloadFile, formatBytes } from '../utils/helpers.js';
import { createIcons, icons } from 'lucide';

const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) || '';

const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type EditMode = 'prompt' | 'remove';

interface State {
  file: File | null;
  prompt: string;
  mode: EditMode;
  hasMask: boolean;
  isProcessing: boolean;
  resultBlob: Blob | null;
}

const state: State = {
  file: null,
  prompt: '',
  mode: 'prompt',
  hasMask: false,
  isProcessing: false,
  resultBlob: null,
};

/* ── Brush-mode canvas state ─────────────────────────────────────────────── */
let brushImage: HTMLImageElement | null = null; // natural-resolution source
let brushReady = false; // canvas sized + image drawn for current file
let brushDisplayW = 0;
let brushDisplayH = 0;
let maskCanvas: HTMLCanvasElement | null = null; // offscreen white-on-transparent
let painting = false;
let lastX = 0;
let lastY = 0;
let brushSize = 30;

function $<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function show(el: HTMLElement | null) {
  el?.classList.remove('hidden');
}
function hide(el: HTMLElement | null) {
  el?.classList.add('hidden');
}

function init() {
  const dropzone = $<HTMLDivElement>('dropzone');
  const fileInput = $<HTMLInputElement>('file-input');
  const promptInput = $<HTMLTextAreaElement>('prompt-input');
  const submitBtn = $<HTMLButtonElement>('submit-btn');
  const resetBtn = $<HTMLButtonElement>('reset-btn');
  const tryAgainBtn = $<HTMLButtonElement>('try-again-btn');
  const downloadBtn = $<HTMLButtonElement>('download-btn');
  const editAgainBtn = $<HTMLButtonElement>('edit-again-btn');
  const backToToolsBtn = $<HTMLButtonElement>('back-to-tools');

  dropzone?.addEventListener('click', () => fileInput?.click());
  dropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('border-orange-500');
  });
  dropzone?.addEventListener('dragleave', () => {
    dropzone.classList.remove('border-orange-500');
  });
  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('border-orange-500');
    const dropped = e.dataTransfer?.files?.[0];
    if (dropped) handleFile(dropped);
  });

  fileInput?.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) handleFile(f);
  });

  promptInput?.addEventListener('input', () => {
    state.prompt = promptInput.value;
    updateSubmitState();
  });

  submitBtn?.addEventListener('click', () => {
    if (!state.isProcessing) submit();
  });

  resetBtn?.addEventListener('click', () => resetForNewFile());
  tryAgainBtn?.addEventListener('click', () => {
    hide($('error-section'));
    show($('editor-section'));
  });

  downloadBtn?.addEventListener('click', () => {
    if (!state.resultBlob) return;
    const baseName = state.file?.name.replace(/\.[^.]+$/, '') ?? 'image';
    const suffix = state.mode === 'remove' ? 'cleaned' : 'edited';
    downloadFile(state.resultBlob, `${baseName}-${suffix}.png`);
  });

  // Re-edit: pipe the result back in as the new source so edits can chain
  // (remove → prompt, remove → remove, etc.).
  editAgainBtn?.addEventListener('click', () => {
    if (state.resultBlob) {
      const f = new File([state.resultBlob], `${baseFileName()}-edit.png`, {
        type: 'image/png',
      });
      handleFile(f);
    } else {
      hide($('result-section'));
      show($('editor-section'));
    }
  });

  backToToolsBtn?.addEventListener('click', () => {
    window.location.href = '/';
  });

  // Suggestion chips populate the prompt
  document
    .querySelectorAll<HTMLButtonElement>('[data-suggest]')
    .forEach((b) => {
      b.addEventListener('click', () => {
        if (!promptInput) return;
        promptInput.value = b.dataset.suggest ?? '';
        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
        promptInput.focus();
      });
    });

  // Mode toggle
  document.querySelectorAll<HTMLButtonElement>('.mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = (btn.dataset.mode as EditMode) || 'prompt';
      switchMode(mode);
    });
  });

  // Brush controls
  const brushSizeEl = $<HTMLInputElement>('brush-size');
  const brushSizeValue = $('brush-size-value');
  brushSizeEl?.addEventListener('input', () => {
    brushSize = parseInt(brushSizeEl.value, 10) || 30;
    if (brushSizeValue) brushSizeValue.textContent = `${brushSize}px`;
  });
  $('clear-mask-btn')?.addEventListener('click', clearMask);
  $('auto-detect-btn')?.addEventListener('click', handleAutoDetect);

  setupBrushPointerEvents();
}

function baseFileName(): string {
  return state.file?.name.replace(/\.[^.]+$/, '') ?? 'image';
}

function handleFile(file: File) {
  if (!ACCEPTED_MIME.includes(file.type)) {
    showAlert('Unsupported file', 'Please upload a PNG, JPEG, or WebP image.');
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showAlert('File too large', 'Maximum image size is 20 MB.');
    return;
  }
  state.file = file;
  state.resultBlob = null;

  const previewImg = $<HTMLImageElement>('preview-image');
  if (previewImg) {
    if (previewImg.src.startsWith('blob:')) URL.revokeObjectURL(previewImg.src);
    previewImg.src = URL.createObjectURL(file);
  }

  const fileMeta = $('file-meta');
  if (fileMeta) {
    fileMeta.textContent = `${file.name} • ${formatBytes(file.size)}`;
  }

  // Reset brush state for the new image; rebuild lazily when needed.
  brushReady = false;
  brushImage = null;
  state.hasMask = false;

  hide($('dropzone-section'));
  show($('editor-section'));
  hide($('result-section'));
  hide($('error-section'));

  if (state.mode === 'remove') void setupBrushCanvas();
  updateSubmitState();
}

/* ── Mode switching ──────────────────────────────────────────────────────── */

function switchMode(mode: EditMode) {
  state.mode = mode;

  const promptBtn = $<HTMLButtonElement>('mode-prompt-btn');
  const removeBtn = $<HTMLButtonElement>('mode-remove-btn');
  const activeCls = ['bg-orange-600', 'text-white'];
  const idleCls = ['text-gray-300', 'hover:text-white'];
  const apply = (btn: HTMLButtonElement | null, active: boolean) => {
    if (!btn) return;
    btn.classList.remove(...activeCls, ...idleCls);
    btn.classList.add(...(active ? activeCls : idleCls));
  };
  apply(promptBtn, mode === 'prompt');
  apply(removeBtn, mode === 'remove');

  if (mode === 'prompt') {
    show($('prompt-mode-panel'));
    hide($('remove-mode-panel'));
  } else {
    hide($('prompt-mode-panel'));
    show($('remove-mode-panel'));
    if (state.file && !brushReady) void setupBrushCanvas();
  }

  updateSubmitButtonLabel();
  updateSubmitState();
}

function updateSubmitButtonLabel() {
  const btn = $<HTMLButtonElement>('submit-btn');
  if (!btn) return;
  if (state.mode === 'remove') {
    btn.innerHTML =
      '<i data-lucide="eraser" class="w-5 h-5"></i> Remove painted area';
  } else {
    btn.innerHTML = '<i data-lucide="wand-2" class="w-5 h-5"></i> Apply edit';
  }
  createIcons({ icons });
}

/* ── Brush canvas ────────────────────────────────────────────────────────── */

async function setupBrushCanvas() {
  if (!state.file) return;
  const base = $<HTMLCanvasElement>('brush-base');
  const overlay = $<HTMLCanvasElement>('brush-overlay');
  const panel = $('remove-mode-panel');
  if (!base || !overlay || !panel) return;

  const img = await loadImage(state.file);
  brushImage = img;

  // Fit the image into the available panel width.
  const avail = panel.clientWidth || base.parentElement?.clientWidth || 640;
  const maxW = Math.min(avail, img.naturalWidth, 800);
  const scale = maxW / img.naturalWidth;
  brushDisplayW = Math.max(1, Math.round(img.naturalWidth * scale));
  brushDisplayH = Math.max(1, Math.round(img.naturalHeight * scale));

  base.width = brushDisplayW;
  base.height = brushDisplayH;
  overlay.width = brushDisplayW;
  overlay.height = brushDisplayH;

  const bctx = base.getContext('2d');
  if (bctx) bctx.drawImage(img, 0, 0, brushDisplayW, brushDisplayH);

  const octx = overlay.getContext('2d');
  if (octx) octx.clearRect(0, 0, brushDisplayW, brushDisplayH);

  // Offscreen mask: white strokes on transparent (composited over black later).
  maskCanvas = document.createElement('canvas');
  maskCanvas.width = brushDisplayW;
  maskCanvas.height = brushDisplayH;

  state.hasMask = false;
  brushReady = true;
  updateSubmitState();
}

function setupBrushPointerEvents() {
  const overlay = $<HTMLCanvasElement>('brush-overlay');
  if (!overlay) return;

  const coords = (e: PointerEvent): [number, number] => {
    const rect = overlay.getBoundingClientRect();
    const sx = overlay.width / rect.width;
    const sy = overlay.height / rect.height;
    return [(e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy];
  };

  overlay.addEventListener('pointerdown', (e) => {
    if (!brushReady) return;
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    painting = true;
    [lastX, lastY] = coords(e);
    paintDot(lastX, lastY);
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!painting) return;
    e.preventDefault();
    const [x, y] = coords(e);
    paintLine(lastX, lastY, x, y);
    lastX = x;
    lastY = y;
  });

  const stop = () => {
    painting = false;
  };
  overlay.addEventListener('pointerup', stop);
  overlay.addEventListener('pointercancel', stop);
  overlay.addEventListener('pointerleave', stop);
}

function strokeStyleSetup(ctx: CanvasRenderingContext2D, color: string) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = brushSize;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function paintDot(x: number, y: number) {
  const octx = $<HTMLCanvasElement>('brush-overlay')?.getContext('2d');
  const mctx = maskCanvas?.getContext('2d');
  if (octx) {
    strokeStyleSetup(octx, 'rgba(249, 115, 22, 0.55)');
    octx.beginPath();
    octx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    octx.fill();
  }
  if (mctx) {
    strokeStyleSetup(mctx, '#ffffff');
    mctx.beginPath();
    mctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    mctx.fill();
  }
  state.hasMask = true;
  updateSubmitState();
}

function paintLine(x0: number, y0: number, x1: number, y1: number) {
  const octx = $<HTMLCanvasElement>('brush-overlay')?.getContext('2d');
  const mctx = maskCanvas?.getContext('2d');
  if (octx) {
    strokeStyleSetup(octx, 'rgba(249, 115, 22, 0.55)');
    octx.beginPath();
    octx.moveTo(x0, y0);
    octx.lineTo(x1, y1);
    octx.stroke();
  }
  if (mctx) {
    strokeStyleSetup(mctx, '#ffffff');
    mctx.beginPath();
    mctx.moveTo(x0, y0);
    mctx.lineTo(x1, y1);
    mctx.stroke();
  }
  state.hasMask = true;
}

function clearMask() {
  const octx = $<HTMLCanvasElement>('brush-overlay')?.getContext('2d');
  if (octx) octx.clearRect(0, 0, brushDisplayW, brushDisplayH);
  const mctx = maskCanvas?.getContext('2d');
  if (mctx) mctx.clearRect(0, 0, brushDisplayW, brushDisplayH);
  state.hasMask = false;
  updateSubmitState();
}

/** Paint a filled rectangle (display coords) on both the overlay and mask. */
function paintRect(x: number, y: number, w: number, h: number) {
  const octx = $<HTMLCanvasElement>('brush-overlay')?.getContext('2d');
  const mctx = maskCanvas?.getContext('2d');
  if (octx) {
    octx.fillStyle = 'rgba(249, 115, 22, 0.55)';
    octx.fillRect(x, y, w, h);
  }
  if (mctx) {
    mctx.fillStyle = '#ffffff';
    mctx.fillRect(x, y, w, h);
  }
  state.hasMask = true;
  updateSubmitState();
}

/** Ask the server to locate a known watermark and paint it onto the mask. */
async function handleAutoDetect() {
  if (!state.file) return;
  if (!brushReady) await setupBrushCanvas();
  if (!brushImage) return;

  const btn = $<HTMLButtonElement>('auto-detect-btn');
  if (btn) btn.disabled = true;
  try {
    const form = new FormData();
    form.append('file', state.file);
    const res = await fetch(`${API_BASE_URL}/api/detect-watermark`, {
      method: 'POST',
      body: form,
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
        'No watermark reference is installed on the server. Brush over the area manually instead.'
      );
      return;
    }
    if (!data.detections || data.detections.length === 0) {
      showAlert(
        'No watermark found',
        'Could not detect a known watermark. Brush over it manually instead.'
      );
      return;
    }
    const scale = brushDisplayW / brushImage.naturalWidth;
    const pad = Math.round(brushSize / 2);
    for (const d of data.detections) {
      paintRect(
        d.x * scale - pad,
        d.y * scale - pad,
        d.w * scale + pad * 2,
        d.h * scale + pad * 2
      );
    }
  } catch (e) {
    showAlert(
      'Auto-detect failed',
      (e as Error).message || 'Could not reach the server.'
    );
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Composite the white-on-transparent mask over black at natural resolution. */
function buildMaskBlob(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!brushImage || !maskCanvas) {
      reject(new Error('Mask not ready'));
      return;
    }
    const out = document.createElement('canvas');
    out.width = brushImage.naturalWidth;
    out.height = brushImage.naturalHeight;
    const ctx = out.getContext('2d');
    if (!ctx) {
      reject(new Error('Canvas unavailable'));
      return;
    }
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(maskCanvas, 0, 0, out.width, out.height);
    out.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to build mask'))),
      'image/png'
    );
  });
}

function loadImage(file: File | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* ── Submit ──────────────────────────────────────────────────────────────── */

function updateSubmitState() {
  const submitBtn = $<HTMLButtonElement>('submit-btn');
  if (!submitBtn) return;
  const ready =
    state.mode === 'prompt'
      ? !!state.file && state.prompt.trim().length > 2
      : !!state.file && state.hasMask;
  submitBtn.disabled = !ready || state.isProcessing;
}

async function submit() {
  if (state.mode === 'remove') {
    await submitRemove();
  } else {
    await submitPrompt();
  }
}

function beginProcessing(title: string, detail: string) {
  state.isProcessing = true;
  updateSubmitState();
  hide($('editor-section'));
  hide($('error-section'));
  const t = $('processing-title');
  const d = $('processing-detail');
  if (t) t.textContent = title;
  if (d) d.textContent = detail;
  show($('processing-section'));
}

function showResult(blob: Blob) {
  state.resultBlob = blob;

  const beforeImg = $<HTMLImageElement>('before-image');
  const previewImg = $<HTMLImageElement>('preview-image');
  if (beforeImg && previewImg) beforeImg.src = previewImg.src;

  const resultImg = $<HTMLImageElement>('result-image');
  if (resultImg) {
    if (resultImg.src.startsWith('blob:')) URL.revokeObjectURL(resultImg.src);
    resultImg.src = URL.createObjectURL(blob);
  }

  hide($('processing-section'));
  show($('result-section'));
}

function showError(err: unknown) {
  hide($('processing-section'));
  show($('error-section'));
  const msg = err instanceof Error ? err.message : 'Something went wrong.';
  const errorMsgEl = $('error-message');
  if (errorMsgEl) errorMsgEl.textContent = msg;
}

async function submitPrompt() {
  if (!state.file || !state.prompt.trim()) return;
  beginProcessing(
    'Editing your image…',
    'Gemini takes 5–20 seconds for most edits.'
  );

  try {
    const form = new FormData();
    form.append('image', state.file);
    form.append('prompt', state.prompt.trim());

    const res = await fetch(`${API_BASE_URL}/api/edit-image`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(extractError(res.status, text));
    }
    showResult(await res.blob());
  } catch (err) {
    showError(err);
  } finally {
    state.isProcessing = false;
    updateSubmitState();
  }
}

async function submitRemove() {
  if (!state.file || !state.hasMask) return;
  beginProcessing(
    'Removing the painted area…',
    'Our self-hosted inpainting model reconstructs the background.'
  );

  try {
    const maskBlob = await buildMaskBlob();
    const form = new FormData();
    form.append('file', state.file);
    form.append(
      'mask',
      new File([maskBlob], 'mask.png', { type: 'image/png' })
    );

    const res = await fetch(`${API_BASE_URL}/api/inpaint`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(extractError(res.status, text));
    }
    showResult(await res.blob());
  } catch (err) {
    showError(err);
  } finally {
    state.isProcessing = false;
    updateSubmitState();
  }
}

function extractError(status: number, raw: string): string {
  // FastAPI HTTPExceptions come back as { detail: "..." }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    /* not JSON */
  }
  if (status === 503) {
    return 'This feature is not configured on this server.';
  }
  if (status === 413) {
    return 'Image is too large (20 MB max).';
  }
  if (status === 422) {
    return state.mode === 'remove'
      ? 'Paint over the area you want removed first.'
      : 'Please describe what you want changed in more detail.';
  }
  if (status === 400) {
    return 'AI editing is not enabled on this server.';
  }
  if (status === 502) {
    return "The model couldn't complete this edit. Try a different prompt or selection.";
  }
  return raw.slice(0, 200) || `Request failed with status ${status}.`;
}

function resetForNewFile() {
  state.file = null;
  state.prompt = '';
  state.hasMask = false;
  state.resultBlob = null;
  state.isProcessing = false;
  brushReady = false;
  brushImage = null;

  const fileInput = $<HTMLInputElement>('file-input');
  if (fileInput) fileInput.value = '';
  const promptInput = $<HTMLTextAreaElement>('prompt-input');
  if (promptInput) promptInput.value = '';

  show($('dropzone-section'));
  hide($('editor-section'));
  hide($('processing-section'));
  hide($('result-section'));
  hide($('error-section'));
  updateSubmitState();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
