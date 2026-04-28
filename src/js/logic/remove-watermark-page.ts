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
import { PDFDocument } from 'pdf-lib';
import { createIcons, icons } from 'lucide';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

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
  const backBtn = document.getElementById('back-to-tools');
  const processBtn = document.getElementById('process-btn');
  const prevPageBtn = document.getElementById('prev-page');
  const nextPageBtn = document.getElementById('next-page');
  const clearBtn = document.getElementById('clear-selections');
  const undoBtn = document.getElementById('undo-selection');

  if (fileInput) {
    fileInput.addEventListener('change', handleFileUpload);
    fileInput.addEventListener('click', () => {
      fileInput.value = '';
    });
  }

  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('border-red-500');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('border-red-500');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-red-500');
      if (e.dataTransfer?.files.length) handleFiles(e.dataTransfer.files);
    });
  }

  if (backBtn)
    backBtn.addEventListener(
      'click',
      () => (window.location.href = import.meta.env.BASE_URL)
    );
  if (processBtn) processBtn.addEventListener('click', removeWatermarks);
  if (prevPageBtn) prevPageBtn.addEventListener('click', () => changePage(-1));
  if (nextPageBtn) nextPageBtn.addEventListener('click', () => changePage(1));
  if (clearBtn) clearBtn.addEventListener('click', clearAllSelections);
  if (undoBtn) undoBtn.addEventListener('click', undoLastSelection);

  setupCanvas();
  setupSettings();
}

function handleFileUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) handleFiles(input.files);
}

async function handleFiles(files: FileList) {
  const file = files[0];
  if (!file || file.type !== 'application/pdf') {
    showAlert('Invalid File', 'Please upload a valid PDF file.');
    return;
  }

  showLoader('Loading PDF...');

  try {
    // Load with pdf-lib for later reconstruction
    const arrayBuffer = await file.arrayBuffer();
    pageState.pdfDoc = await PDFLibDocument.load(arrayBuffer);
    pageState.file = file;

    // Load with pdf.js for rendering
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    pdfJsDoc = await loadingTask.promise;
    pageState.totalPages = pdfJsDoc.numPages;
    pageState.currentPage = 1;

    updateFileDisplay();
    document.getElementById('canvas-panel')?.classList.remove('hidden');
    await renderPage(1);
  } catch (error) {
    console.error(error);
    showAlert('Error', 'Failed to load PDF file.');
  } finally {
    hideLoader();
  }
}

function updateFileDisplay() {
  const fileDisplayArea = document.getElementById('file-display-area');
  if (!fileDisplayArea || !pageState.file || !pageState.pdfDoc) return;

  fileDisplayArea.innerHTML = '';
  const fileDiv = document.createElement('div');
  fileDiv.className =
    'flex items-center justify-between bg-gray-700 p-3 rounded-lg';

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
  if (
    file.type !== 'application/pdf' &&
    !file.name.toLowerCase().endsWith('.pdf')
  ) {
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
  fileDiv.className =
    'flex items-center justify-between bg-gray-700 p-3 rounded-lg';

  const infoContainer = document.createElement('div');
  infoContainer.className = 'flex flex-col flex-1 min-w-0';

  const nameSpan = document.createElement('div');
  nameSpan.className = 'truncate font-medium text-gray-200 text-sm mb-1';
  nameSpan.textContent = pageState.file.name;

  const metaSpan = document.createElement('div');
  metaSpan.className = 'text-xs text-gray-400';
  metaSpan.textContent = `${formatBytes(pageState.file.size)} • ${pageState.totalPages} pages`;
  nameSpan.textContent = file.name;

  const metaSpan = document.createElement('div');
  metaSpan.className = 'text-xs text-gray-400';
  metaSpan.textContent = formatBytes(file.size);

  infoContainer.append(nameSpan, metaSpan);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'ml-4 text-red-400 hover:text-red-300 flex-shrink-0';
  removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
  removeBtn.onclick = resetState;
  removeBtn.onclick = () => resetToUpload();

  fileDiv.append(infoContainer, removeBtn);
  fileDisplayArea.appendChild(fileDiv);
  createIcons({ icons });
}

function resetState() {
  pageState.file = null;
  pageState.pdfDoc = null;
  pageState.currentPage = 1;
  pageState.totalPages = 0;
  pageState.regions = [];
  pdfJsDoc = null;

  const fileDisplayArea = document.getElementById('file-display-area');
  if (fileDisplayArea) fileDisplayArea.innerHTML = '';
  document.getElementById('canvas-panel')?.classList.add('hidden');

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  if (fileInput) fileInput.value = '';

  if (pageState.canvas) {
    const ctx = pageState.canvas.getContext('2d');
    if (ctx)
      ctx.clearRect(0, 0, pageState.canvas.width, pageState.canvas.height);
  }
}

async function renderPage(pageNum: number) {
  if (!pdfJsDoc) return;

  const page = await pdfJsDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: pageState.scale });

  if (!pageState.canvas) return;

  pageState.canvas.width = viewport.width;
  pageState.canvas.height = viewport.height;

  const renderContext = {
    canvasContext: pageState.ctx!,
    viewport: viewport,
  };

  await page.render(renderContext).promise;

  // Draw existing selections for this page
  drawSelections();

  // Update page info
  const pageInfo = document.getElementById('page-info');
  if (pageInfo)
    pageInfo.textContent = `Page ${pageNum} of ${pageState.totalPages}`;

  // Update navigation buttons
  const prevBtn = document.getElementById('prev-page') as HTMLButtonElement;
  const nextBtn = document.getElementById('next-page') as HTMLButtonElement;
  if (prevBtn) prevBtn.disabled = pageNum <= 1;
  if (nextBtn) nextBtn.disabled = pageNum >= pageState.totalPages;
}

function setupCanvas() {
  pageState.canvas = document.getElementById('pdf-canvas') as HTMLCanvasElement;
  if (!pageState.canvas) return;

  pageState.ctx = pageState.canvas.getContext('2d');

  // Mouse events for drawing selections
  pageState.canvas.addEventListener('mousedown', handleMouseDown);
  pageState.canvas.addEventListener('mousemove', handleMouseMove);
  pageState.canvas.addEventListener('mouseup', handleMouseUp);
}

function handleMouseDown(e: MouseEvent) {
  const rect = pageState.canvas!.getBoundingClientRect();
  pageState.isDrawing = true;
  pageState.startX = e.clientX - rect.left;
  pageState.startY = e.clientY - rect.top;

  currentRect = {
    x: pageState.startX,
    y: pageState.startY,
    width: 0,
    height: 0,
    pageIndex: pageState.currentPage - 1,
  };
}

function handleMouseMove(e: MouseEvent) {
  if (!pageState.isDrawing || !currentRect) return;

  const rect = pageState.canvas!.getBoundingClientRect();
  const currentX = e.clientX - rect.left;
  const currentY = e.clientY - rect.top;

  currentRect.width = currentX - pageState.startX;
  currentRect.height = currentY - pageState.startY;

  // Redraw
  renderPage(pageState.currentPage);
  drawCurrentSelection();
}

function handleMouseUp() {
  if (!pageState.isDrawing || !currentRect) return;

  pageState.isDrawing = false;

  // Only add if the selection has meaningful size
  if (Math.abs(currentRect.width) > 10 && Math.abs(currentRect.height) > 10) {
    // Normalize negative dimensions
    if (currentRect.width < 0) {
      currentRect.x += currentRect.width;
      currentRect.width = Math.abs(currentRect.width);
    }
    if (currentRect.height < 0) {
      currentRect.y += currentRect.height;
      currentRect.height = Math.abs(currentRect.height);
    }

    pageState.regions.push({ ...currentRect });
    updateSelectionInfo();
  }

  currentRect = null;
  renderPage(pageState.currentPage);
}

function drawCurrentSelection() {
  if (!currentRect || !pageState.ctx) return;

  pageState.ctx.strokeStyle = '#ef4444';
  pageState.ctx.lineWidth = 2;
  pageState.ctx.setLineDash([5, 5]);
  pageState.ctx.strokeRect(
    currentRect.x,
    currentRect.y,
    currentRect.width,
    currentRect.height
  );
  pageState.ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
  pageState.ctx.fillRect(
    currentRect.x,
    currentRect.y,
    currentRect.width,
    currentRect.height
  );
  pageState.ctx.setLineDash([]);
}

function drawSelections() {
  if (!pageState.ctx) return;

  const currentPageRegions = pageState.regions.filter(
    (r) => r.pageIndex === pageState.currentPage - 1
  );

  currentPageRegions.forEach((region) => {
    pageState.ctx!.strokeStyle = '#ef4444';
    pageState.ctx!.lineWidth = 2;
    pageState.ctx!.strokeRect(region.x, region.y, region.width, region.height);
    pageState.ctx!.fillStyle = 'rgba(239, 68, 68, 0.2)';
    pageState.ctx!.fillRect(region.x, region.y, region.width, region.height);
  });
}

function updateSelectionInfo() {
  const infoDiv = document.getElementById('selection-info');
  if (!infoDiv) return;

  const count = pageState.regions.length;
  const currentPageCount = pageState.regions.filter(
    (r) => r.pageIndex === pageState.currentPage - 1
  ).length;

  infoDiv.innerHTML = `
    <span class="text-sm text-gray-400">
      ${count} total region${count !== 1 ? 's' : ''} selected
      ${currentPageCount > 0 ? `(${currentPageCount} on this page)` : ''}
    </span>
  `;
}

function changePage(delta: number) {
  const newPage = pageState.currentPage + delta;
  if (newPage < 1 || newPage > pageState.totalPages) return;

  pageState.currentPage = newPage;
  renderPage(newPage);
}

function clearAllSelections() {
  pageState.regions = [];
  updateSelectionInfo();
  renderPage(pageState.currentPage);
}

function undoLastSelection() {
  if (pageState.regions.length === 0) return;
  pageState.regions.pop();
  updateSelectionInfo();
  renderPage(pageState.currentPage);
}

function setupSettings() {
  const radiusSlider = document.getElementById(
    'inpainting-radius'
  ) as HTMLInputElement;
  const radiusValue = document.getElementById('radius-value');

  radiusSlider?.addEventListener('input', () => {
    if (radiusValue) radiusValue.textContent = radiusSlider.value;
  });
}

async function removeWatermarks() {
  if (!pageState.pdfDoc || pageState.regions.length === 0) {
    showAlert(
      'Error',
      'Please select at least one watermark region to remove.'
    );
    return;
  }

  showLoader('Removing watermarks...');
  const loaderProgress = document.getElementById('loader-progress');

  try {
    // Load OpenCV.js dynamically
    await loadOpenCV();

    const method = (
      document.getElementById('inpainting-method') as HTMLSelectElement
    ).value as 'telea' | 'ns';
    const radius = parseInt(
      (document.getElementById('inpainting-radius') as HTMLInputElement).value
    );

    const options: InpaintingOptions = { method, radius };

    // Process each page that has regions
    const pagesWithRegions = new Set(pageState.regions.map((r) => r.pageIndex));
    const pdfLibDoc = pageState.pdfDoc;
    const pages = pdfLibDoc.getPages();

    let processedCount = 0;
    for (const pageIndex of pagesWithRegions) {
      if (loaderProgress) {
        loaderProgress.textContent = `Processing page ${pageIndex + 1} of ${pageState.totalPages}...`;
      }

      const pageRegions = pageState.regions.filter(
        (r) => r.pageIndex === pageIndex
      );
      await processPageWithInpainting(
        pdfJsDoc,
        pdfLibDoc,
        pageIndex,
        pageRegions,
        options
      );
      processedCount++;
    }

    // Save the modified PDF
    const pdfBytes = await pdfLibDoc.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    downloadFile(blob, 'watermark-removed.pdf');

    showAlert(
      'Success',
      `Watermarks removed successfully from ${processedCount} page${processedCount !== 1 ? 's' : ''}!`,
      'success',
      () => {
        resetState();
      }
    );
  } catch (error: any) {
    console.error(error);
    showAlert(
      'Error',
      error.message || 'Failed to remove watermarks. Please try again.'
    );
  } finally {
    hideLoader();
  }
}

async function loadOpenCV(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).cv && (window as any).cv.Mat) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.x/opencv.js';
    script.async = true;
    script.onload = () => {
      // Wait for OpenCV to be ready
      const checkOpenCV = setInterval(() => {
        if ((window as any).cv && (window as any).cv.Mat) {
          clearInterval(checkOpenCV);
          resolve();
        }
      }, 100);

      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkOpenCV);
        reject(new Error('OpenCV.js failed to load'));
      }, 10000);
    };
    script.onerror = () => reject(new Error('Failed to load OpenCV.js'));
    document.head.appendChild(script);
  });
}

async function processPageWithInpainting(
  pdfJsDoc: any,
  pdfLibDoc: any,
  pageIndex: number,
  regions: WatermarkRegion[],
  options: InpaintingOptions
) {
  const cv = (window as any).cv;

  // Render page to canvas at higher resolution
  const page = await pdfJsDoc.getPage(pageIndex + 1);
  const scale = 2.0; // Higher resolution for better quality
  const viewport = page.getViewport({ scale });

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = viewport.width;
  tempCanvas.height = viewport.height;
  const tempCtx = tempCanvas.getContext('2d')!;

  await page.render({
    canvasContext: tempCtx,
    viewport: viewport,
  }).promise;

  // Convert to OpenCV Mat
  const imgData = tempCtx.getImageData(
    0,
    0,
    tempCanvas.width,
    tempCanvas.height
  );
  const src = cv.matFromImageData(imgData);

  // Create mask
  const mask = new cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);

  // Draw regions on mask (scaled to match rendered resolution)
  const scaleRatio = scale / pageState.scale;
  regions.forEach((region) => {
    const scaledX = Math.floor(region.x * scaleRatio);
    const scaledY = Math.floor(region.y * scaleRatio);
    const scaledWidth = Math.floor(region.width * scaleRatio);
    const scaledHeight = Math.floor(region.height * scaleRatio);

    const rect = new cv.Rect(scaledX, scaledY, scaledWidth, scaledHeight);
    cv.rectangle(
      mask,
      rect.tl(),
      rect.br(),
      new cv.Scalar(255, 255, 255, 255),
      -1
    );
  });

  // Apply inpainting
  const dst = new cv.Mat();
  const inpaintFlag =
    options.method === 'telea' ? cv.INPAINT_TELEA : cv.INPAINT_NS;
  cv.inpaint(src, mask, dst, options.radius, inpaintFlag);

  // Convert back to canvas
  cv.imshow(tempCanvas, dst);

  // Convert canvas to image and embed in PDF
  const imageDataUrl = tempCanvas.toDataURL('image/jpeg', 0.95);
  const imageBytes = dataUrlToBytes(imageDataUrl);

  // Replace page in PDF with processed image
  const pdfPage = pdfLibDoc.getPage(pageIndex);
  const jpgImage = await pdfLibDoc.embedJpg(imageBytes);

  const { width, height } = pdfPage.getSize();
  pdfPage.drawImage(jpgImage, {
    x: 0,
    y: 0,
    width: width,
    height: height,
  });

  // Clean up
  src.delete();
  mask.delete();
  dst.delete();
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1];
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
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

  const processBtn = document.getElementById(
    'process-btn'
  ) as HTMLButtonElement;
  if (processBtn) processBtn.disabled = true;

  const progressBar = document.getElementById('progress-bar') as HTMLElement;

  try {
    updateStatus('Reading PDF...', 'Loading document');
    if (progressBar) progressBar.style.width = '10%';

    const arrayBuffer = await state.file.arrayBuffer();

    updateStatus('Removing watermark...', 'Processing pages');
    if (progressBar) progressBar.style.width = '30%';
    let resultBytes = await deepRemoval(arrayBuffer, state.position);

    // Add replacement logo if selected
    if (state.logoPreset !== 'none') {
      updateStatus('Adding logo...', `Placing ${state.logoPreset} logo`);
      if (progressBar) progressBar.style.width = '70%';
      resultBytes = await addReplacementLogo(
        resultBytes,
        state.logoPreset,
        state.position
      );
    }

    if (progressBar) progressBar.style.width = '100%';

    state.resultBlob = new Blob([resultBytes as BlobPart], {
      type: 'application/pdf',
    });

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
 * Deep removal - uses canvas-based column-by-column color sampling
 * Renders PDF to canvas, samples colors above watermark, fills with sampled colors
 */
async function deepRemoval(
  arrayBuffer: ArrayBuffer,
  position: string
): Promise<Uint8Array> {
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
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;

    // Get watermark region (in canvas coordinates, scaled)
    const wm = getWatermarkRect(
      position,
      viewport.width,
      viewport.height,
      scale
    );

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
    const newPage = newPdfDoc.addPage([
      originalViewport.width,
      originalViewport.height,
    ]);
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
        height: wm_height,
      };
    case 'bottom-left':
      return {
        x: margin,
        y: canvasHeight - offset_bottom,
        width: wm_width,
        height: wm_height,
      };
    case 'top-right':
      return {
        x: canvasWidth - offset_right,
        y: margin + wm_height, // Canvas Y is top-down
        width: wm_width,
        height: wm_height,
      };
    case 'top-left':
      return {
        x: margin,
        y: margin + wm_height,
        width: wm_width,
        height: wm_height,
      };
    default:
      return {
        x: canvasWidth - offset_right,
        y: canvasHeight - offset_bottom,
        width: wm_width,
        height: wm_height,
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
    console.log(`[Logo] Fetching logo from: ${logoUrl}`);
    const logoResponse = await fetch(logoUrl);
    if (!logoResponse.ok) {
      console.error(
        `[Logo] Failed to load logo: ${logoPreset}, status: ${logoResponse.status}`
      );
      return pdfBytes;
    }
    console.log(`[Logo] Successfully loaded ${logoPreset}`);

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
      console.log(
        `[Logo] Added ${logoPreset} to page at (${x.toFixed(0)}, ${y.toFixed(0)}), size: ${logoWidth.toFixed(0)}x${logoHeight.toFixed(0)}`
      );
    }

    console.log(`[Logo] Successfully added logo to all ${pages.length} pages`);
    return await pdfDoc.save();
  } catch (e) {
    console.error('[Logo] Error adding logo:', e);
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
