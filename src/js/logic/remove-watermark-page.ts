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
  if (autoDetectBtn) autoDetectBtn.addEventListener('click', autoDetectWatermarks);

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
    imageBytes = inpaintWithOpenCV(tempCanvas, tempCtx, regions, scaleRatio, options);
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

  const imgData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
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

const API_BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined) || '';

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
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))),
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
