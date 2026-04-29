/**
 * Edit Banana — prompt-based AI image editor backed by Gemini's
 * image-editing model. User uploads an image, types what they want
 * changed, gets back the edited image.
 *
 * Server-side only (no client-side fallback exists for this kind of
 * generative edit). If the backend isn't configured with a Gemini key
 * the endpoint returns 503 and we surface that clearly.
 */

import { showAlert } from '../ui.js';
import { downloadFile, formatBytes } from '../utils/helpers.js';

const API_BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined) || '';

const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

interface State {
  file: File | null;
  prompt: string;
  isProcessing: boolean;
  resultBlob: Blob | null;
}

const state: State = {
  file: null,
  prompt: '',
  isProcessing: false,
  resultBlob: null,
};

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
    downloadFile(state.resultBlob, `${baseName}-edited.png`);
  });

  editAgainBtn?.addEventListener('click', () => {
    hide($('result-section'));
    show($('editor-section'));
    state.resultBlob = null;
  });

  backToToolsBtn?.addEventListener('click', () => {
    window.location.href = '/';
  });

  // Suggestion chips populate the prompt
  document.querySelectorAll<HTMLButtonElement>('[data-suggest]').forEach((b) => {
    b.addEventListener('click', () => {
      if (!promptInput) return;
      promptInput.value = b.dataset.suggest ?? '';
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));
      promptInput.focus();
    });
  });
}

function handleFile(file: File) {
  if (!ACCEPTED_MIME.includes(file.type)) {
    showAlert(
      'Unsupported file',
      'Please upload a PNG, JPEG, or WebP image.'
    );
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showAlert('File too large', 'Maximum image size is 20 MB.');
    return;
  }
  state.file = file;

  const previewImg = $<HTMLImageElement>('preview-image');
  if (previewImg) {
    if (previewImg.src.startsWith('blob:')) URL.revokeObjectURL(previewImg.src);
    previewImg.src = URL.createObjectURL(file);
  }

  const fileMeta = $('file-meta');
  if (fileMeta) {
    fileMeta.textContent = `${file.name} • ${formatBytes(file.size)}`;
  }

  hide($('dropzone-section'));
  show($('editor-section'));
  hide($('result-section'));
  hide($('error-section'));
  updateSubmitState();
}

function updateSubmitState() {
  const submitBtn = $<HTMLButtonElement>('submit-btn');
  if (!submitBtn) return;
  const ready = !!state.file && state.prompt.trim().length > 2 && !state.isProcessing;
  submitBtn.disabled = !ready;
}

async function submit() {
  if (!state.file || !state.prompt.trim()) return;
  state.isProcessing = true;
  updateSubmitState();
  hide($('editor-section'));
  hide($('error-section'));
  show($('processing-section'));

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

    const blob = await res.blob();
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
  } catch (err) {
    hide($('processing-section'));
    show($('error-section'));
    const msg = err instanceof Error ? err.message : 'Something went wrong.';
    const errorMsgEl = $('error-message');
    if (errorMsgEl) errorMsgEl.textContent = msg;
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
    return 'AI editing is not configured on this server.';
  }
  if (status === 413) {
    return 'Image is too large (20 MB max).';
  }
  if (status === 422) {
    return 'Please describe what you want changed in more detail.';
  }
  if (status === 502) {
    return 'The model couldn\'t complete this edit. Try a different prompt or image.';
  }
  return raw.slice(0, 200) || `Request failed with status ${status}.`;
}

function resetForNewFile() {
  state.file = null;
  state.prompt = '';
  state.resultBlob = null;
  state.isProcessing = false;

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
