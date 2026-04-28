/**
 * Video Downloader Page - Download videos from URLs (YouTube, Instagram)
 * as MP4 video or 320 kbps MP3 audio.
 */

import { createIcons, icons } from 'lucide';
import { showAlert } from '../ui.js';
import { downloadFile } from '../utils/helpers.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

type OutputFormat = 'mp4' | 'mp3';

interface State {
  format: OutputFormat;
  isProcessing: boolean;
  resultBlob: Blob | null;
  resultFilename: string;
}

const state: State = {
  format: 'mp4',
  isProcessing: false,
  resultBlob: null,
  resultFilename: 'download.mp4',
};

const ERROR_MESSAGES: Record<string, string> = {
  unsupported_url: "This link isn't from a supported platform.",
  private_or_login_required: 'This video requires login or is private.',
  geo_restricted: 'Not available in this region.',
  live_stream: "Live streams aren't supported.",
  too_long: 'Video exceeds the 30-minute limit.',
  download_failed: "Couldn't download from this link. Try another.",
  rate_limited: 'Too many requests. Please wait a moment.',
  timeout: 'Download took too long and was cancelled.',
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePage);
} else {
  initializePage();
}

function initializePage() {
  createIcons({ icons });

  const urlInput = document.getElementById('url-input') as HTMLInputElement | null;
  urlInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleDownload();
    }
  });

  document.getElementById('paste-btn')?.addEventListener('click', handlePaste);

  document.querySelectorAll('input[name="output-format"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      const value = (e.target as HTMLInputElement).value;
      if (value === 'mp4' || value === 'mp3') {
        state.format = value;
        updateActionLabel();
      }
    });
  });

  document
    .getElementById('download-action-btn')
    ?.addEventListener('click', handleDownload);

  document.getElementById('save-file-btn')?.addEventListener('click', () => {
    if (state.resultBlob) {
      downloadFile(state.resultBlob, state.resultFilename);
    }
  });

  document
    .getElementById('download-another-btn')
    ?.addEventListener('click', resetForm);

  document
    .getElementById('try-again-btn')
    ?.addEventListener('click', resetForm);

  document.getElementById('back-to-tools')?.addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });

  updateActionLabel();
}

function updateActionLabel() {
  const label = document.getElementById('download-action-label');
  if (label) {
    label.textContent = state.format === 'mp4' ? 'Download MP4' : 'Download MP3';
  }
}

async function handlePaste() {
  const urlInput = document.getElementById('url-input') as HTMLInputElement | null;
  if (!urlInput) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      urlInput.value = text.trim();
      urlInput.focus();
    }
  } catch {
    showAlert(
      'Clipboard Unavailable',
      'Your browser blocked clipboard access. Paste the URL manually.'
    );
  }
}

function getValidatedUrl(): string | null {
  const urlInput = document.getElementById('url-input') as HTMLInputElement | null;
  const raw = urlInput?.value.trim() ?? '';
  if (!raw) {
    showAlert('Missing URL', 'Paste a video URL first.');
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    showAlert('Invalid URL', 'That doesn’t look like a valid URL.');
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    showAlert('Invalid URL', 'URL must start with http:// or https://.');
    return null;
  }
  return raw;
}

async function handleDownload() {
  if (state.isProcessing) return;

  const url = getValidatedUrl();
  if (!url) return;

  state.isProcessing = true;
  state.resultBlob = null;

  showProcessing();
  setProgress(5);

  const actionBtn = document.getElementById(
    'download-action-btn'
  ) as HTMLButtonElement | null;
  if (actionBtn) actionBtn.disabled = true;

  // Indeterminate progress animation that creeps up to 90%.
  let progress = 5;
  const progressInterval = window.setInterval(() => {
    progress = Math.min(progress + Math.random() * 4, 90);
    setProgress(progress);
  }, 600);

  try {
    updateStatus(
      state.format === 'mp4' ? 'Downloading…' : 'Downloading and converting…',
      'This can take a minute for longer videos'
    );

    const response = await fetch(`${API_BASE_URL}/api/download-from-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format: state.format }),
    });

    window.clearInterval(progressInterval);

    if (!response.ok) {
      let code = '';
      let message = '';
      try {
        const body = await response.json();
        code = body?.code ?? '';
        message = body?.message ?? '';
      } catch {
        // ignore — fall through to generic message
      }
      const friendly =
        ERROR_MESSAGES[code] ||
        message ||
        'Something went wrong. Please try again.';
      showError(friendly);
      return;
    }

    const blob = await response.blob();

    // Filename from Content-Disposition, with format-appropriate fallback.
    let filename = state.format === 'mp4' ? 'video.mp4' : 'audio.mp3';
    const cd = response.headers.get('Content-Disposition');
    if (cd) {
      const match = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      if (match) {
        try {
          filename = decodeURIComponent(match[1]);
        } catch {
          filename = match[1];
        }
      }
    }

    state.resultBlob = blob;
    state.resultFilename = filename;

    setProgress(100);
    showSuccess(filename);
  } catch (err) {
    window.clearInterval(progressInterval);
    console.error('Download error:', err);
    showError('Network error. Please check your connection and try again.');
  } finally {
    state.isProcessing = false;
    if (actionBtn) actionBtn.disabled = false;
  }
}

function showProcessing() {
  document.getElementById('processing-status')?.classList.remove('hidden');
  document.getElementById('success-section')?.classList.add('hidden');
  document.getElementById('error-section')?.classList.add('hidden');
}

function showSuccess(filename: string) {
  document.getElementById('processing-status')?.classList.add('hidden');
  document.getElementById('success-section')?.classList.remove('hidden');
  document.getElementById('error-section')?.classList.add('hidden');
  const detail = document.getElementById('success-detail');
  if (detail) {
    detail.textContent = `Saved as: ${filename}`;
  }
  createIcons({ icons });
}

function showError(message: string) {
  document.getElementById('processing-status')?.classList.add('hidden');
  document.getElementById('success-section')?.classList.add('hidden');
  document.getElementById('error-section')?.classList.remove('hidden');
  const errorMessage = document.getElementById('error-message');
  if (errorMessage) errorMessage.textContent = message;
  createIcons({ icons });
}

function updateStatus(text: string, detail: string) {
  const statusText = document.getElementById('status-text');
  const statusDetail = document.getElementById('status-detail');
  if (statusText) statusText.textContent = text;
  if (statusDetail) statusDetail.textContent = detail;
}

function setProgress(value: number) {
  const progressBar = document.getElementById('progress-bar') as HTMLElement | null;
  if (progressBar) progressBar.style.width = `${value}%`;
}

function resetForm() {
  state.resultBlob = null;
  state.resultFilename =
    state.format === 'mp4' ? 'download.mp4' : 'download.mp3';
  document.getElementById('processing-status')?.classList.add('hidden');
  document.getElementById('success-section')?.classList.add('hidden');
  document.getElementById('error-section')?.classList.add('hidden');
  setProgress(0);
}
