import { createIcons, icons } from 'lucide';
import { showAlert, showLoader, hideLoader } from '../ui.js';
import { downloadFile, formatBytes } from '../utils/helpers.js';
import { PDFDocument as PDFLibDocument } from 'pdf-lib';
import {
  RemoveWatermarkState,
  WatermarkRegion,
  InpaintingOptions,
} from '@/types';
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const pageState: RemoveWatermarkState = {
  file: null,
  pdfDoc: null,
  currentPage: 1,
  totalPages: 0,
  scale: 1.5,
  regions: [],
  isDrawing: false,
  startX: 0,
  startY: 0,
  canvas: null,
  ctx: null,
};

let pdfJsDoc: any = null;
let currentRect: WatermarkRegion | null = null;

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

  const autoDetectBtn = document.getElementById('auto-detect-btn');
  if (autoDetectBtn)
    autoDetectBtn.addEventListener('click', autoDetectWatermarks);

  setupCanvas();
  setupSettings();
  setupLogoStep();
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

  const infoContainer = document.createElement('div');
  infoContainer.className = 'flex flex-col flex-1 min-w-0';

  const nameSpan = document.createElement('div');
  nameSpan.className = 'truncate font-medium text-gray-200 text-sm mb-1';
  nameSpan.textContent = pageState.file.name;

  const metaSpan = document.createElement('div');
  metaSpan.className = 'text-xs text-gray-400';
  metaSpan.textContent = `${formatBytes(pageState.file.size)} • ${pageState.totalPages} pages`;

  infoContainer.append(nameSpan, metaSpan);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'ml-4 text-red-400 hover:text-red-300 flex-shrink-0';
  removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
  removeBtn.onclick = resetState;

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
  resetLogoStep();

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

  // Keep the logo overlay aligned to the (possibly resized) canvas.
  positionLogoOverlay();
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

async function autoDetectWatermarks() {
  if (!pageState.pdfDoc || !pageState.canvas) {
    showAlert('Error', 'Please upload a PDF file first.');
    return;
  }

  const btn = document.getElementById(
    'auto-detect-btn'
  ) as HTMLButtonElement | null;
  const originalLabel = btn?.innerHTML ?? '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML =
      '<i data-lucide="loader" class="w-4 h-4 inline mr-1 animate-spin"></i> Detecting…';
  }

  try {
    // Render the current page to a canvas at the same scale used for
    // selection so coordinates line up with pageState.regions.
    if (!pdfJsDoc) throw new Error('PDF not yet loaded');
    const page = await pdfJsDoc.getPage(pageState.currentPage);
    const viewport = page.getViewport({ scale: pageState.scale });
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = viewport.width;
    tempCanvas.height = viewport.height;
    const tempCtx = tempCanvas.getContext('2d')!;
    await page.render({ canvasContext: tempCtx, viewport }).promise;

    const blob = await new Promise<Blob | null>((resolve) =>
      tempCanvas.toBlob((b) => resolve(b), 'image/png')
    );
    if (!blob) throw new Error('Could not capture page image');

    const form = new FormData();
    form.append('image', blob, 'page.png');

    const apiBaseUrl =
      (import.meta.env.VITE_API_URL as string | undefined) || '';
    const res = await fetch(`${apiBaseUrl}/api/detect-watermarks`, {
      method: 'POST',
      body: form,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        res.status === 503
          ? 'Auto-detect requires a Gemini API key on the server.'
          : `Detection failed (${res.status}): ${detail.slice(0, 200)}`
      );
    }

    const { watermarks } = (await res.json()) as {
      watermarks: Array<{
        x: number;
        y: number;
        w: number;
        h: number;
        label: string;
        confidence: number;
      }>;
    };

    if (!watermarks || watermarks.length === 0) {
      showAlert(
        'No watermarks found',
        'Gemini did not detect any watermarks on this page. Try drawing a rectangle manually.'
      );
      return;
    }

    // Append (don't replace) so users can keep manual selections too.
    for (const wm of watermarks) {
      pageState.regions.push({
        x: wm.x,
        y: wm.y,
        width: wm.w,
        height: wm.h,
        pageIndex: pageState.currentPage - 1,
      });
    }

    updateSelectionInfo();
    renderPage(pageState.currentPage);
    drawSelections();

    showAlert(
      'Auto-detect complete',
      `Found ${watermarks.length} watermark${watermarks.length === 1 ? '' : 's'} on this page. Review the boxes; you can adjust, undo, or clear before removing.`,
      'success'
    );
  } catch (err) {
    showAlert(
      'Auto-detect failed',
      err instanceof Error ? err.message : 'Unknown error'
    );
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalLabel;
      // Re-mount lucide icons that were torn out
      try {
        // @ts-ignore - lucide is available via /utils/lucide-init
        if ((window as any).lucide?.createIcons)
          (window as any).lucide.createIcons();
      } catch {
        /* noop */
      }
    }
  }
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

  // The Gemini option doesn't use the radius (it's an ML model, not a
  // local kernel). Show a note when it's selected and disable the radius
  // slider so users don't think it does something.
  const methodSelect = document.getElementById(
    'inpainting-method'
  ) as HTMLSelectElement | null;
  const geminiNote = document.getElementById('gemini-method-note');
  const updateMethodUi = () => {
    if (!methodSelect) return;
    const isGemini = methodSelect.value === 'gemini';
    geminiNote?.classList.toggle('hidden', !isGemini);
    if (radiusSlider) radiusSlider.disabled = isGemini;
  };
  methodSelect?.addEventListener('change', updateMethodUi);
  updateMethodUi();
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
    const method = (
      document.getElementById('inpainting-method') as HTMLSelectElement
    ).value as 'telea' | 'ns' | 'gemini';

    // OpenCV is only needed for the local methods. Gemini path uploads to
    // the backend instead.
    if (method !== 'gemini') {
      await loadOpenCV();
    }
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

    // Watermarks removed — move to the logo placement step instead of
    // downloading immediately (issue #41: choose a logo, position + size it,
    // then apply to all pages).
    hideLoader();
    enterLogoStep(processedCount);
    return;
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

  const scaleRatio = scale / pageState.scale;

  let imageBytes: Uint8Array;

  if (options.method === 'gemini') {
    imageBytes = await inpaintWithGemini(tempCanvas, regions, scaleRatio);
  } else {
    imageBytes = inpaintWithOpenCV(
      tempCanvas,
      tempCtx,
      regions,
      scaleRatio,
      options
    );
  }

  // Replace page in PDF with processed image
  const pdfPage = pdfLibDoc.getPage(pageIndex);
  const jpgImage =
    options.method === 'gemini'
      ? await pdfLibDoc.embedPng(imageBytes)
      : await pdfLibDoc.embedJpg(imageBytes);

  const { width, height } = pdfPage.getSize();
  pdfPage.drawImage(jpgImage, {
    x: 0,
    y: 0,
    width: width,
    height: height,
  });
}

function inpaintWithOpenCV(
  tempCanvas: HTMLCanvasElement,
  tempCtx: CanvasRenderingContext2D,
  regions: WatermarkRegion[],
  scaleRatio: number,
  options: InpaintingOptions
): Uint8Array {
  const cv = (window as any).cv;

  const imgData = tempCtx.getImageData(
    0,
    0,
    tempCanvas.width,
    tempCanvas.height
  );
  const src = cv.matFromImageData(imgData);
  const mask = new cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);

  regions.forEach((region) => {
    const rect = new cv.Rect(
      Math.floor(region.x * scaleRatio),
      Math.floor(region.y * scaleRatio),
      Math.floor(region.width * scaleRatio),
      Math.floor(region.height * scaleRatio)
    );
    cv.rectangle(
      mask,
      rect.tl(),
      rect.br(),
      new cv.Scalar(255, 255, 255, 255),
      -1
    );
  });

  const dst = new cv.Mat();
  const inpaintFlag =
    options.method === 'telea' ? cv.INPAINT_TELEA : cv.INPAINT_NS;
  cv.inpaint(src, mask, dst, options.radius, inpaintFlag);

  cv.imshow(tempCanvas, dst);

  src.delete();
  mask.delete();
  dst.delete();

  return dataUrlToBytes(tempCanvas.toDataURL('image/jpeg', 0.95));
}

const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) || '';

async function inpaintWithGemini(
  tempCanvas: HTMLCanvasElement,
  regions: WatermarkRegion[],
  scaleRatio: number
): Promise<Uint8Array> {
  // Build a binary mask matching the rendered canvas size: white = inpaint.
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = tempCanvas.width;
  maskCanvas.height = tempCanvas.height;
  const maskCtx = maskCanvas.getContext('2d')!;
  maskCtx.fillStyle = '#000';
  maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
  maskCtx.fillStyle = '#fff';
  regions.forEach((region) => {
    maskCtx.fillRect(
      Math.floor(region.x * scaleRatio),
      Math.floor(region.y * scaleRatio),
      Math.floor(region.width * scaleRatio),
      Math.floor(region.height * scaleRatio)
    );
  });

  const imageBlob = await canvasToBlob(tempCanvas, 'image/png');
  const maskBlob = await canvasToBlob(maskCanvas, 'image/png');

  const form = new FormData();
  form.append('image', imageBlob, 'page.png');
  form.append('mask', maskBlob, 'mask.png');

  const res = await fetch(`${API_BASE_URL}/api/inpaint-image`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Gemini inpaint failed (HTTP ${res.status}): ${detail.slice(0, 200)}`
    );
  }
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null')),
      type
    );
  });
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

/* ──────────────────────────────────────────────────────────────────────────
 * Logo placement step (issue #41)
 * After watermark removal, let the user pick a logo, drag it to position and
 * size it on the page preview, then stamp it onto every page of the PDF.
 * ────────────────────────────────────────────────────────────────────────── */

type PdfLogoSource = 'lakeb2b' | 'champions' | 'ampliz' | 'custom' | 'none';

interface PdfLogoState {
  source: PdfLogoSource;
  customUrl: string | null; // object URL for custom upload preview
  widthPct: number; // logo width as a fraction of page width (0-1)
  xFrac: number; // logo top-left X as a fraction of page width (0-1)
  yFrac: number; // logo top-left Y as a fraction of page height (0-1)
  aspect: number; // logo intrinsic width / height
  dragging: boolean;
  dragOffsetX: number;
  dragOffsetY: number;
}

const logoState: PdfLogoState = {
  source: 'lakeb2b',
  customUrl: null,
  widthPct: 0.15,
  xFrac: 0.78,
  yFrac: 0.88,
  aspect: 1,
  dragging: false,
  dragOffsetX: 0,
  dragOffsetY: 0,
};

function logoPresetUrl(source: PdfLogoSource): string | null {
  if (source === 'none' || source === 'custom') return null;
  return `${import.meta.env.BASE_URL}logos/${source}.png`;
}

function setupLogoStep() {
  document
    .querySelectorAll('input[name="pdf-logo-source"]')
    .forEach((radio) => {
      radio.addEventListener('change', (e) => {
        logoState.source = (e.target as HTMLInputElement)
          .value as PdfLogoSource;
        const customInput = document.getElementById(
          'custom-logo-input'
        ) as HTMLInputElement | null;
        customInput?.classList.toggle('hidden', logoState.source !== 'custom');
        if (logoState.source === 'custom') {
          if (logoState.customUrl) {
            void loadLogoPreview(logoState.customUrl);
          } else {
            customInput?.click();
          }
        } else {
          void loadLogoPreview(logoPresetUrl(logoState.source));
        }
      });
    });

  const customInput = document.getElementById(
    'custom-logo-input'
  ) as HTMLInputElement | null;
  customInput?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (logoState.customUrl) URL.revokeObjectURL(logoState.customUrl);
    logoState.customUrl = URL.createObjectURL(file);
    void loadLogoPreview(logoState.customUrl);
  });

  const sizeSlider = document.getElementById(
    'logo-size'
  ) as HTMLInputElement | null;
  const sizeValue = document.getElementById('logo-size-value');
  sizeSlider?.addEventListener('input', () => {
    logoState.widthPct = parseInt(sizeSlider.value, 10) / 100;
    if (sizeValue) sizeValue.textContent = sizeSlider.value;
    positionLogoOverlay();
  });

  document
    .getElementById('apply-logo-btn')
    ?.addEventListener('click', () => void applyLogoAndDownload());
  document
    .getElementById('skip-logo-btn')
    ?.addEventListener('click', () => downloadProcessedPdf());

  window.addEventListener('resize', positionLogoOverlay);

  setupLogoDrag();
}

function enterLogoStep(processedCount: number) {
  // Hide the selection settings; reveal the logo panel.
  document.getElementById('logo-panel')?.classList.remove('hidden');
  const processBtn = document.getElementById('process-btn');
  processBtn?.classList.add('hidden');

  const info = document.getElementById('selection-info');
  if (info) {
    info.innerHTML = `<span class="text-sm text-green-400">Watermarks removed from ${processedCount} page${
      processedCount !== 1 ? 's' : ''
    }. Now add a logo (optional).</span>`;
  }

  // Make the canvas non-crosshair during placement.
  pageState.canvas?.classList.remove('cursor-crosshair');

  // Default to the LakeB2B preset preview.
  logoState.source = 'lakeb2b';
  void loadLogoPreview(logoPresetUrl('lakeb2b'));
  createIcons({ icons });
}

function resetLogoStep() {
  if (logoState.customUrl) {
    URL.revokeObjectURL(logoState.customUrl);
    logoState.customUrl = null;
  }
  logoState.source = 'lakeb2b';
  logoState.widthPct = 0.15;
  logoState.xFrac = 0.78;
  logoState.yFrac = 0.88;
  logoState.aspect = 1;
  document.getElementById('logo-panel')?.classList.add('hidden');
  document.getElementById('logo-overlay')?.classList.add('hidden');
  document.getElementById('process-btn')?.classList.remove('hidden');
}

async function loadLogoPreview(url: string | null) {
  const overlay = document.getElementById(
    'logo-overlay'
  ) as HTMLImageElement | null;
  if (!overlay) return;

  if (!url) {
    // "None" selected — hide the overlay.
    overlay.classList.add('hidden');
    return;
  }

  await new Promise<void>((resolve) => {
    overlay.onload = () => {
      logoState.aspect =
        overlay.naturalWidth / Math.max(1, overlay.naturalHeight);
      resolve();
    };
    overlay.onerror = () => resolve();
    overlay.src = url;
  });

  overlay.classList.remove('hidden');
  positionLogoOverlay();
}

/** Position the draggable overlay over the displayed canvas using fractions. */
function positionLogoOverlay() {
  const overlay = document.getElementById(
    'logo-overlay'
  ) as HTMLImageElement | null;
  const canvas = pageState.canvas;
  if (!overlay || !canvas || overlay.classList.contains('hidden')) return;

  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const w = logoState.widthPct * cw;
  const h = w / (logoState.aspect || 1);

  // Clamp so the logo stays on the page.
  logoState.xFrac = Math.min(Math.max(logoState.xFrac, 0), 1 - w / cw);
  logoState.yFrac = Math.min(Math.max(logoState.yFrac, 0), 1 - h / ch);

  overlay.style.width = `${w}px`;
  overlay.style.height = `${h}px`;
  overlay.style.left = `${canvas.offsetLeft + logoState.xFrac * cw}px`;
  overlay.style.top = `${canvas.offsetTop + logoState.yFrac * ch}px`;
}

function setupLogoDrag() {
  const overlay = document.getElementById(
    'logo-overlay'
  ) as HTMLImageElement | null;
  if (!overlay) return;

  const start = (clientX: number, clientY: number) => {
    const rect = overlay.getBoundingClientRect();
    logoState.dragging = true;
    logoState.dragOffsetX = clientX - rect.left;
    logoState.dragOffsetY = clientY - rect.top;
  };

  const move = (clientX: number, clientY: number) => {
    if (!logoState.dragging) return;
    const canvas = pageState.canvas;
    if (!canvas) return;
    const cRect = canvas.getBoundingClientRect();
    const left = clientX - logoState.dragOffsetX - cRect.left;
    const top = clientY - logoState.dragOffsetY - cRect.top;
    logoState.xFrac = left / canvas.clientWidth;
    logoState.yFrac = top / canvas.clientHeight;
    positionLogoOverlay();
  };

  const end = () => {
    logoState.dragging = false;
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

function downloadProcessedPdf() {
  if (!pageState.pdfDoc) return;
  void (async () => {
    showLoader('Saving PDF...');
    try {
      const pdfBytes = await pageState.pdfDoc!.save();
      const blob = new Blob([pdfBytes as BlobPart], {
        type: 'application/pdf',
      });
      downloadFile(blob, 'watermark-removed.pdf');
      showAlert('Success', 'Your PDF is ready.', 'success', () => resetState());
    } catch (e: any) {
      showAlert('Error', e?.message || 'Failed to save PDF.');
    } finally {
      hideLoader();
    }
  })();
}

async function getLogoBytes(): Promise<{
  bytes: Uint8Array;
  isPng: boolean;
} | null> {
  if (logoState.source === 'none') return null;

  let url: string | null;
  if (logoState.source === 'custom') {
    url = logoState.customUrl;
    if (!url) {
      showAlert('No logo', 'Please upload a logo image first.');
      return null;
    }
  } else {
    url = logoPresetUrl(logoState.source);
  }
  if (!url) return null;

  const res = await fetch(url);
  const buf = new Uint8Array(await res.arrayBuffer());
  const isPng = buf[0] === 0x89 && buf[1] === 0x50; // PNG magic bytes
  return { bytes: buf, isPng };
}

async function applyLogoAndDownload() {
  if (!pageState.pdfDoc) return;

  if (logoState.source === 'none') {
    downloadProcessedPdf();
    return;
  }

  showLoader('Applying logo to all pages...');
  try {
    const logo = await getLogoBytes();
    if (!logo) {
      hideLoader();
      return;
    }

    const pdfLibDoc = pageState.pdfDoc;
    const embedded = logo.isPng
      ? await pdfLibDoc.embedPng(logo.bytes)
      : await pdfLibDoc.embedJpg(logo.bytes);

    const pages = pdfLibDoc.getPages();
    for (const page of pages) {
      const { width: pw, height: ph } = page.getSize();
      const lw = logoState.widthPct * pw;
      const lh = lw / (logoState.aspect || 1);
      const x = logoState.xFrac * pw;
      // Canvas Y is top-down; pdf-lib origin is bottom-left.
      const y = ph - logoState.yFrac * ph - lh;
      page.drawImage(embedded, { x, y, width: lw, height: lh });
    }

    const pdfBytes = await pdfLibDoc.save();
    const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
    downloadFile(blob, 'watermark-removed-rebranded.pdf');

    showAlert(
      'Success',
      `Logo applied to ${pages.length} page${pages.length !== 1 ? 's' : ''} and downloaded.`,
      'success',
      () => resetState()
    );
  } catch (e: any) {
    console.error(e);
    showAlert('Error', e?.message || 'Failed to apply logo.');
  } finally {
    hideLoader();
  }
}
