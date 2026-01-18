/**
 * Sign PDF Page - DocuSign-like PDF signing experience
 *
 * Features:
 * - Drag-and-drop signature placement
 * - Add signatures, dates, text, checkboxes
 * - Resize and reposition annotations
 * - Multi-page navigation
 * - Export signed PDF with embedded annotations
 */

import { createIcons, icons } from 'lucide';
import { showAlert, showLoader, hideLoader } from '../ui.js';
import { formatBytes } from '../utils/helpers.js';
import { PDFSigner } from '../components/pdf-signer/index.js';

let signer: PDFSigner | null = null;
let currentFile: File | null = null;

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

  // Page navigation
  document.getElementById('prev-page')?.addEventListener('click', async () => {
    await signer?.prevPage();
  });

  document.getElementById('next-page')?.addEventListener('click', async () => {
    await signer?.nextPage();
  });

  // Zoom controls
  document.getElementById('zoom-in')?.addEventListener('click', async () => {
    await signer?.zoomIn();
    updateZoomDisplay();
  });

  document.getElementById('zoom-out')?.addEventListener('click', async () => {
    await signer?.zoomOut();
    updateZoomDisplay();
  });

  document.getElementById('zoom-fit')?.addEventListener('click', async () => {
    const scrollContainer = document.getElementById('pdf-scroll-container');
    if (scrollContainer && signer) {
      await signer.fitToWidth(scrollContainer.clientWidth);
      updateZoomDisplay();
    }
  });

  // Save button
  document
    .getElementById('save-signed-pdf')
    ?.addEventListener('click', handleSave);

  // Back button
  document
    .getElementById('back-to-upload')
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

async function handleFile(file: File) {
  if (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) {
    showAlert('Invalid File', 'Please select a PDF file.');
    return;
  }

  currentFile = file;
  updateFileDisplay(file);
  showLoader('Loading PDF...');

  try {
    const canvasContainer = document.getElementById('pdf-canvas-container');
    const annotationOverlay = document.getElementById('annotation-overlay');
    const toolbarContainer = document.getElementById('signer-toolbar');

    if (!canvasContainer || !annotationOverlay || !toolbarContainer) {
      throw new Error('Required containers not found');
    }

    // Clear any existing content
    canvasContainer.innerHTML = '';
    annotationOverlay.innerHTML = '';
    toolbarContainer.innerHTML = '';

    // Initialize the signer with callbacks
    signer = new PDFSigner(
      canvasContainer,
      annotationOverlay,
      toolbarContainer,
      {
        onPageChange: updatePageIndicator,
        onZoomChange: updateZoomDisplay,
      }
    );

    await signer.loadPDF(file);

    // Show editor, hide upload
    document.getElementById('signature-editor')?.classList.remove('hidden');
    document.getElementById('tool-uploader')?.classList.add('hidden');

    // Update zoom display after load
    updateZoomDisplay();

    hideLoader();
    createIcons({ icons });
  } catch (error) {
    hideLoader();
    console.error('Failed to load PDF:', error);
    showAlert('Error', 'Failed to load the PDF. Please try a different file.');
  }
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

function updatePageIndicator(current: number, total: number) {
  const indicator = document.getElementById('page-indicator');
  if (indicator) {
    indicator.textContent = `Page ${current} of ${total}`;
  }

  // Update button states
  const prevBtn = document.getElementById('prev-page') as HTMLButtonElement;
  const nextBtn = document.getElementById('next-page') as HTMLButtonElement;

  if (prevBtn) prevBtn.disabled = current <= 1;
  if (nextBtn) nextBtn.disabled = current >= total;
}

function updateZoomDisplay() {
  const zoomLevel = document.getElementById('zoom-level');
  if (zoomLevel && signer) {
    zoomLevel.textContent = `${Math.round(signer.getZoom() * 100)}%`;
  }
}

async function handleSave() {
  if (!signer) {
    showAlert('Error', 'No PDF loaded.');
    return;
  }

  showLoader('Saving signed PDF...');

  try {
    await signer.savePDF();
    hideLoader();
    showAlert('Success!', 'Your signed PDF has been saved.', 'success', () => {
      // Optionally reset after successful save
    });
  } catch (error) {
    hideLoader();
    console.error('Failed to save PDF:', error);
    showAlert('Error', 'Failed to save the PDF. Please try again.');
  }
}

function resetToUpload() {
  cleanup();

  // Reset state
  signer = null;
  currentFile = null;

  // Hide editor, show upload
  document.getElementById('signature-editor')?.classList.add('hidden');
  document.getElementById('tool-uploader')?.classList.remove('hidden');

  // Clear containers
  const canvasContainer = document.getElementById('pdf-canvas-container');
  const annotationOverlay = document.getElementById('annotation-overlay');
  const toolbarContainer = document.getElementById('signer-toolbar');
  const fileDisplayArea = document.getElementById('file-display-area');

  if (canvasContainer) canvasContainer.innerHTML = '';
  if (annotationOverlay) annotationOverlay.innerHTML = '';
  if (toolbarContainer) toolbarContainer.innerHTML = '';
  if (fileDisplayArea) fileDisplayArea.innerHTML = '';

  // Reset page indicator
  const indicator = document.getElementById('page-indicator');
  if (indicator) indicator.textContent = 'Page 1 of 1';

  // Clear file input
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  if (fileInput) fileInput.value = '';
}

function cleanup() {
  // Any cleanup needed (e.g., revoking object URLs)
  signer = null;
}
