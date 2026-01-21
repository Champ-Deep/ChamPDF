/**
 * PDF Watermark Remover - Remove watermarks from PDFs and optionally replace with logo
 *
 * Features:
 * - Quick mode: Remove annotations, forms, links (pdf-lib)
 * - Deep mode: Redact content in specified corner region (PyMuPDF)
 * - Logo replacement option
 */

import { showAlert } from '../ui.js';
import { downloadFile, formatBytes, getPDFDocument } from '../utils/helpers.js';
import { PDFDocument, PDFName } from 'pdf-lib';
import { createIcons, icons } from 'lucide';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

interface WatermarkRemoverState {
  file: File | null;
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  method: 'quick' | 'deep';
  logoPreset: 'none' | 'lakeb2b' | 'champions' | 'ampliz';
  isProcessing: boolean;
  resultBlob: Blob | null;
}

const state: WatermarkRemoverState = {
  file: null,
  position: 'bottom-right',
  method: 'deep',
  logoPreset: 'none',
  isProcessing: false,
  resultBlob: null,
};

// Logo images as base64 (will be loaded dynamically)
const LOGO_URLS: Record<string, string> = {
  lakeb2b: '/Images & Logos/lakeb2b.png',
  champions: '/Images & Logos/champions.png',
  ampliz: '/Images & Logos/ampliz.png',
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
  document.querySelectorAll('input[name="watermark-position"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.position = (e.target as HTMLInputElement).value as typeof state.position;
    });
  });

  // Method radio buttons
  document.querySelectorAll('input[name="removal-method"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.method = (e.target as HTMLInputElement).value as typeof state.method;
    });
  });

  // Logo preset radio buttons
  document.querySelectorAll('input[name="logo-preset"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.logoPreset = (e.target as HTMLInputElement).value as typeof state.logoPreset;
    });
  });

  // Process button
  document.getElementById('process-btn')?.addEventListener('click', handleProcess);

  // Download button
  document.getElementById('download-btn')?.addEventListener('click', handleDownload);

  // Process another button
  document.getElementById('process-another-btn')?.addEventListener('click', resetToUpload);

  // Try again button
  document.getElementById('try-again-btn')?.addEventListener('click', resetToUpload);

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
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showAlert('Invalid File', 'Please select a PDF file.');
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
  fileDiv.className = 'flex items-center justify-between bg-gray-700 p-3 rounded-lg';

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
    showAlert('No File', 'Please select a PDF file first.');
    return;
  }

  if (state.isProcessing) return;

  state.isProcessing = true;

  // Show processing status
  document.getElementById('options-section')?.classList.add('hidden');
  document.getElementById('processing-status')?.classList.remove('hidden');

  const processBtn = document.getElementById('process-btn') as HTMLButtonElement;
  if (processBtn) processBtn.disabled = true;

  const progressBar = document.getElementById('progress-bar') as HTMLElement;

  try {
    updateStatus('Reading PDF...', 'Loading document');
    if (progressBar) progressBar.style.width = '10%';

    const arrayBuffer = await state.file.arrayBuffer();

    let resultBytes: Uint8Array;

    if (state.method === 'quick') {
      updateStatus('Removing annotations...', 'Quick mode processing');
      if (progressBar) progressBar.style.width = '30%';
      resultBytes = await quickRemoval(arrayBuffer);
    } else {
      updateStatus('Redacting watermark region...', 'Deep mode processing');
      if (progressBar) progressBar.style.width = '30%';
      resultBytes = await deepRemoval(arrayBuffer, state.position);
    }

    // Add replacement logo if selected
    if (state.logoPreset !== 'none') {
      updateStatus('Adding logo...', `Placing ${state.logoPreset} logo`);
      if (progressBar) progressBar.style.width = '70%';
      resultBytes = await addReplacementLogo(resultBytes, state.logoPreset, state.position);
    }

    if (progressBar) progressBar.style.width = '100%';

    state.resultBlob = new Blob([resultBytes as BlobPart], { type: 'application/pdf' });

    updateStatus('Complete!', 'Watermark removed successfully');

    setTimeout(() => {
      showDownloadSection();
    }, 500);

  } catch (error) {
    console.error('Processing error:', error);
    showErrorSection((error as Error).message || 'Failed to process PDF');
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
 * Quick removal using pdf-lib - removes annotations, forms, links
 */
async function quickRemoval(arrayBuffer: ArrayBuffer): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  // Remove annotations from all pages
  for (const page of pages) {
    try {
      page.node.delete(PDFName.of('Annots'));
    } catch (e) {
      console.warn('Could not remove annotations from page:', e);
    }
  }

  // Flatten forms
  try {
    const form = pdfDoc.getForm();
    form.flatten();
  } catch (e) {
    console.warn('Could not flatten forms:', e);
  }

  // Remove AcroForm
  try {
    const catalog = pdfDoc.catalog;
    (catalog as any).delete(PDFName.of('AcroForm'));
  } catch (e) {
    console.warn('Could not remove AcroForm:', e);
  }

  return await pdfDoc.save();
}

/**
 * Deep removal - uses canvas-based column-by-column color sampling
 * Renders PDF to canvas, samples colors above watermark, fills with sampled colors
 */
async function deepRemoval(arrayBuffer: ArrayBuffer, position: string): Promise<Uint8Array> {
  const pdfJsDoc = await getPDFDocument({ data: arrayBuffer }).promise;
  const newPdfDoc = await PDFDocument.create();

  // High quality rendering (2x scale for better sampling)
  const scale = 2.0;

  for (let i = 1; i <= pdfJsDoc.numPages; i++) {
    const page = await pdfJsDoc.getPage(i);
    const viewport = page.getViewport({ scale });

    // Render page to canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Get watermark region (in canvas coordinates, scaled)
    const wm = getWatermarkRect(position, viewport.width, viewport.height, scale);

    // Sample colors from a strip above the watermark (5 pixels above in PDF coords)
    const sampleY = Math.max(0, wm.y - 10); // 10 canvas pixels above (5 PDF points * 2x scale)
    const sampleHeight = 2; // Sample 2 pixels for better averaging

    // Get image data from the sample strip
    const sampleData = ctx.getImageData(wm.x, sampleY, wm.width, sampleHeight);

    // Column-by-column color fill over the watermark
    for (let x = 0; x < wm.width; x++) {
      // Sample color from middle of the sample strip for this column
      const idx = (x + Math.floor(sampleHeight / 2) * wm.width) * 4;
      const r = sampleData.data[idx];
      const g = sampleData.data[idx + 1];
      const b = sampleData.data[idx + 2];

      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(wm.x + x, wm.y, 1, wm.height);
    }

    // Convert canvas to JPEG and embed in new PDF
    const jpegBlob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.95)
    );
    const jpegBytes = await jpegBlob.arrayBuffer();
    const jpegImage = await newPdfDoc.embedJpg(jpegBytes);

    // Add page with original dimensions (unscaled)
    const originalViewport = page.getViewport({ scale: 1.0 });
    const newPage = newPdfDoc.addPage([originalViewport.width, originalViewport.height]);
    newPage.drawImage(jpegImage, {
      x: 0,
      y: 0,
      width: originalViewport.width,
      height: originalViewport.height,
    });
  }

  return await newPdfDoc.save();
}

/**
 * Get the watermark region based on position and canvas dimensions
 * Uses exact NotebookLM watermark specifications:
 * - Position: 115px from right, 30px from bottom (in PDF points)
 * - Size: ~110x25 PDF points
 *
 * Canvas coordinates are top-down (Y increases downward)
 */
function getWatermarkRect(
  position: string,
  canvasWidth: number,
  canvasHeight: number,
  scale: number
): { x: number; y: number; width: number; height: number } {
  // NotebookLM watermark dimensions in PDF points, scaled to canvas pixels
  const wm_width = 110 * scale;
  const wm_height = 25 * scale;
  const margin = 5 * scale;
  const offset_right = 115 * scale;
  const offset_bottom = 30 * scale;

  switch (position) {
    case 'bottom-right':
      return {
        x: canvasWidth - offset_right,
        y: canvasHeight - offset_bottom,
        width: wm_width,
        height: wm_height
      };
    case 'bottom-left':
      return {
        x: margin,
        y: canvasHeight - offset_bottom,
        width: wm_width,
        height: wm_height
      };
    case 'top-right':
      return {
        x: canvasWidth - offset_right,
        y: margin + wm_height, // Canvas Y is top-down
        width: wm_width,
        height: wm_height
      };
    case 'top-left':
      return {
        x: margin,
        y: margin + wm_height,
        width: wm_width,
        height: wm_height
      };
    default:
      return {
        x: canvasWidth - offset_right,
        y: canvasHeight - offset_bottom,
        width: wm_width,
        height: wm_height
      };
  }
}

/**
 * Add replacement logo to the PDF
 */
async function addReplacementLogo(
  pdfBytes: Uint8Array,
  logoPreset: string,
  position: string
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);

  // Load logo image
  const logoUrl = LOGO_URLS[logoPreset];
  if (!logoUrl) return pdfBytes;

  try {
    const logoResponse = await fetch(logoUrl);
    if (!logoResponse.ok) {
      console.warn(`Could not load logo: ${logoPreset}`);
      return pdfBytes;
    }

    const logoArrayBuffer = await logoResponse.arrayBuffer();
    const logoImage = await pdfDoc.embedPng(new Uint8Array(logoArrayBuffer));

    const pages = pdfDoc.getPages();

    for (const page of pages) {
      const { width: pageWidth, height: pageHeight } = page.getSize();

      // Calculate logo dimensions (max 100px width, maintain aspect ratio)
      const maxLogoWidth = 100;
      const logoAspect = logoImage.width / logoImage.height;
      const logoWidth = Math.min(maxLogoWidth, pageWidth * 0.12);
      const logoHeight = logoWidth / logoAspect;

      // Calculate position
      const margin = 15;
      let x: number, y: number;

      switch (position) {
        case 'bottom-right':
          x = pageWidth - logoWidth - margin;
          y = margin;
          break;
        case 'bottom-left':
          x = margin;
          y = margin;
          break;
        case 'top-right':
          x = pageWidth - logoWidth - margin;
          y = pageHeight - logoHeight - margin;
          break;
        case 'top-left':
          x = margin;
          y = pageHeight - logoHeight - margin;
          break;
        default:
          x = pageWidth - logoWidth - margin;
          y = margin;
      }

      page.drawImage(logoImage, {
        x,
        y,
        width: logoWidth,
        height: logoHeight,
      });
    }

    return await pdfDoc.save();
  } catch (e) {
    console.warn('Could not add logo:', e);
    return pdfBytes;
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

  const originalName = state.file.name.replace(/\.pdf$/i, '');
  const downloadName = `${originalName}_no_watermark.pdf`;

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
  const defaultPosition = document.querySelector('input[name="watermark-position"][value="bottom-right"]') as HTMLInputElement;
  if (defaultPosition) defaultPosition.checked = true;
  state.position = 'bottom-right';

  const defaultMethod = document.querySelector('input[name="removal-method"][value="deep"]') as HTMLInputElement;
  if (defaultMethod) defaultMethod.checked = true;
  state.method = 'deep';

  const defaultLogo = document.querySelector('input[name="logo-preset"][value="none"]') as HTMLInputElement;
  if (defaultLogo) defaultLogo.checked = true;
  state.logoPreset = 'none';
}
