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
import { initializeOpenCV } from './watermark-opencv';
import {
  WatermarkRegionEditor,
  fractionToPixels,
  pixelsToFraction,
} from './watermark-regions';
import {
  detectWatermark,
  buildGlyphMask,
  clearDocumentMarks,
  type Raster,
} from './watermark-detect';
import {
  buildRepeatingWatermarkMask,
  repeatingMaskToPixels,
  type WatermarkMask,
} from './watermark-mask';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

const pageState: RemoveWatermarkState = {
  file: null,
  pdfDoc: null,
  currentPage: 1,
  totalPages: 0,
  scale: 1.5,
  regions: [],

  canvas: null,
  ctx: null,
};

let pdfJsDoc: any = null;
let editor: WatermarkRegionEditor;
let renderTask: pdfjsLib.RenderTask | null = null;
let renderGeneration = 0;
let busy = false;
const automaticMasks = new Map<number, WatermarkMask>();
let nextMaskId = 0;
let serverWatermarks = false;
const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) || '';

const LOCAL_VECTOR_SCALE = 3;
const MAX_RENDER_PIXELS = 40_000_000;

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
    autoDetectBtn.addEventListener('click', () => void autoDetectWatermarks());
  document
    .getElementById('server-detect-btn')
    ?.addEventListener('click', () => void autoDetectWatermarks(true));

  setupCanvas();
  setupSettings();
  setupLogoStep();
  void checkServerWatermarks();
}

async function checkServerWatermarks() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/capabilities`);
    if (!res.ok) return;
    const caps = await res.json();
    if (!caps.pdf_watermark_objects) return;
  } catch {
    return;
  }
  serverWatermarks = true;
  const select = document.getElementById(
    'inpainting-method'
  ) as HTMLSelectElement | null;
  if (select && !select.querySelector('option[value="server"]')) {
    const option = document.createElement('option');
    option.value = 'server';
    option.textContent = 'Remove watermark objects (Server, keeps text sharp)';
    select.prepend(option);
    select.value = 'server';
    select.dispatchEvent(new Event('change'));
  }
  const serverBtn = document.getElementById('server-detect-btn');
  if (serverBtn) {
    serverBtn.textContent = 'Detect on server (uploads PDF)';
    serverBtn.title =
      'Upload the PDF to find watermark text, shapes and layers. No API key needed.';
    if (pageState.file) serverBtn.classList.remove('hidden');
  }
}

function handleFileUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) handleFiles(input.files);
}

async function handleFiles(files: FileList) {
  if (busy) return;
  const file = files[0];
  if (!file || file.type !== 'application/pdf') {
    showAlert('Invalid File', 'Please upload a valid PDF file.');
    return;
  }

  showLoader('Loading PDF...');
  busy = true;

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
    pageState.regions = [];
    automaticMasks.clear();
    editor.reset();
    resetLogoStep();
    document
      .getElementById('server-detect-btn')
      ?.classList.toggle('hidden', !serverWatermarks);

    updateFileDisplay();
    document.getElementById('canvas-panel')?.classList.remove('hidden');
    await renderPage(1);
  } catch (error) {
    console.error(error);
    showAlert('Error', 'Failed to load PDF file.');
  } finally {
    busy = false;
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
  if (busy) return;
  renderGeneration++;
  renderTask?.cancel();
  pageState.file = null;
  pageState.pdfDoc = null;
  pageState.currentPage = 1;
  pageState.totalPages = 0;
  pageState.regions = [];
  automaticMasks.clear();
  editor.reset();
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
  const generation = ++renderGeneration;
  const previous = renderTask;
  previous?.cancel();
  if (previous) await previous.promise.catch(() => {});
  const page = await pdfJsDoc.getPage(pageNum);
  if (!pageState.canvas || generation !== renderGeneration) return;
  const base = page.getViewport({ scale: 1 });
  const cssWidth = Math.min(
    base.width * pageState.scale,
    pageState.canvas.parentElement!.clientWidth
  );
  const viewport = page.getViewport({ scale: cssWidth / base.width });
  const dpr = window.devicePixelRatio || 1;
  pageState.canvas.width = Math.round(viewport.width * dpr);
  pageState.canvas.height = Math.round(viewport.height * dpr);
  pageState.canvas.style.width = `${viewport.width}px`;
  pageState.canvas.style.height = 'auto';
  editor.pageChanged();
  renderTask = page.render({
    canvas: pageState.canvas,
    canvasContext: pageState.ctx!,
    viewport,
    transform: [dpr, 0, 0, dpr, 0, 0],
  });
  try {
    await renderTask.promise;
  } catch (error) {
    if (generation !== renderGeneration) return;
    throw error;
  }
  if (generation !== renderGeneration) return;
  renderTask = null;
  editor.sync();

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

  editor = new WatermarkRegionEditor(
    pageState.canvas,
    document.getElementById('region-overlay')!,
    document.getElementById('selection-info')!,
    () => pageState.regions,
    (regions) => {
      pageState.regions = regions;
    },
    () => pageState.currentPage - 1
  );
}

function changePage(delta: number) {
  if (busy) return;
  const newPage = pageState.currentPage + delta;
  if (newPage < 1 || newPage > pageState.totalPages) return;

  editor.pageChanged();
  pageState.currentPage = newPage;
  void renderPage(newPage).catch((error) =>
    showAlert('Preview failed', error.message)
  );
}

function clearAllSelections() {
  if (!busy) editor.clear();
}

async function autoDetectWatermarks(useServer = false) {
  if (busy) return;
  if (!pageState.pdfDoc || !pageState.canvas) {
    showAlert('Error', 'Please upload a PDF file first.');
    return;
  }
  busy = true;
  editor.setEnabled(false);

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
    if (useServer && serverWatermarks) {
      await detectOnServer();
      return;
    }
    if (!useServer) {
      const samples: Raster[] = [];
      const count = Math.min(6, pageState.totalPages);
      for (let i = 0; i < count; i++) {
        const index =
          count === 1
            ? 1
            : 1 + Math.round((i * (pageState.totalPages - 1)) / (count - 1));
        const samplePage = await pdfJsDoc.getPage(index);
        const base = samplePage.getViewport({ scale: 1 });
        const viewport = samplePage.getViewport({
          scale: Math.min(1.5, 1600 / base.width),
        });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d')!;
        // Fit the viewport exactly to integer backing dimensions. Otherwise
        // ceil(height) leaves a repeated partial white row that looks like ink.
        await samplePage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: [
            canvas.width / viewport.width,
            0,
            0,
            canvas.height / viewport.height,
            0,
            0,
          ],
        }).promise;
        samples.push(context.getImageData(0, 0, canvas.width, canvas.height));
      }
      const box = detectWatermark(samples);
      const evidence = box ? buildRepeatingWatermarkMask(samples, box) : null;
      // Inconclusive multi-page evidence must not become a broad per-page
      // contrast mask that could erase nearby document content.
      if (box && (samples.length === 1 || evidence)) {
        const autoMaskId = evidence ? ++nextMaskId : undefined;
        if (evidence && autoMaskId !== undefined)
          automaticMasks.set(autoMaskId, evidence);
        const regions = [...pageState.regions];
        for (let pageIndex = 0; pageIndex < pageState.totalPages; pageIndex++) {
          if (
            !regions.some(
              (r) =>
                r.pageIndex === pageIndex &&
                Math.abs(r.x - box.x) < 0.002 &&
                Math.abs(r.y - box.y) < 0.002 &&
                Math.abs(r.width - box.width) < 0.002 &&
                Math.abs(r.height - box.height) < 0.002
            )
          )
            regions.push({ ...box, pageIndex, autoMaskId });
        }
        editor.replace(regions);
        document.getElementById('server-detect-btn')?.classList.add('hidden');
        showAlert(
          'On-device detection complete',
          `Selected the same corner region on all ${pageState.totalPages} pages. Automatic multi-page removal uses repeating glyphs only. Moving or resizing a box switches it to manual local-contrast removal.`,
          'success'
        );
      } else {
        document
          .getElementById('server-detect-btn')
          ?.classList.remove('hidden');
        showAlert(
          'No local watermark found',
          serverWatermarks
            ? 'Draw a box over the mark, or use Detect on server. Server detection uploads the PDF and finds watermark text, shapes and layers that on-device detection cannot see.'
            : 'Draw a region manually, or choose the optional server detection button. Server detection uploads this page and requires a configured API key.'
        );
      }
      return;
    }
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

    // The server returns image-pixel boxes; normalize exactly once.
    const detected: WatermarkRegion[] = [];
    for (const wm of watermarks) {
      if (
        ![wm.x, wm.y, wm.w, wm.h].every(Number.isFinite) ||
        wm.w <= 0 ||
        wm.h <= 0
      )
        continue;
      const x = Math.max(0, wm.x),
        y = Math.max(0, wm.y);
      const width = Math.min(tempCanvas.width, wm.x + wm.w) - x;
      const height = Math.min(tempCanvas.height, wm.y + wm.h) - y;
      if (width > 0 && height > 0)
        detected.push(
          pixelsToFraction(
            { x, y, width, height, pageIndex: pageState.currentPage - 1 },
            tempCanvas.width,
            tempCanvas.height
          )
        );
    }
    editor.replace([...pageState.regions, ...detected]);

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
    busy = false;
    editor.setEnabled(true);
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

interface ServerWatermark {
  pageIndex: number;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

interface ServerRemovalReport {
  removed: number;
  imagePatches: number;
  pages: number[];
  unmatched: unknown[];
}

async function serverError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return body.detail || fallback;
  } catch {
    return `${fallback} (HTTP ${res.status})`;
  }
}

async function detectOnServer() {
  const form = new FormData();
  form.append('file', pageState.file!);
  const res = await fetch(`${API_BASE_URL}/api/pdf/detect-watermarks`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok)
    throw new Error(await serverError(res, 'Server detection failed'));
  const data: { regions: ServerWatermark[]; imagePages: number[] } =
    await res.json();

  if (!data.regions.length) {
    const imagePage = data.imagePages.includes(pageState.currentPage - 1);
    showAlert(
      'No watermark objects found',
      imagePage
        ? 'This page is an image, so the mark is part of the picture. Draw a box over it and choose Remove Watermark: the server repaints only that area of the image.'
        : 'Draw a box over the mark and choose Remove Watermark. The server removes what sits under the box.'
    );
    return;
  }

  const pad = 0.004;
  const found: WatermarkRegion[] = data.regions.map((r) => {
    const x = Math.max(0, r.x - pad);
    const y = Math.max(0, r.y - pad);
    return {
      pageIndex: r.pageIndex,
      x,
      y,
      width: Math.min(1 - x, r.width + 2 * pad),
      height: Math.min(1 - y, r.height + 2 * pad),
    };
  });
  editor.replace([...pageState.regions, ...found]);
  const pages = new Set(found.map((r) => r.pageIndex)).size;
  const labels = [...new Set(data.regions.map((r) => r.text || r.kind))]
    .slice(0, 3)
    .join(', ');
  showAlert(
    'Server detection complete',
    `Found ${found.length} watermark mark${found.length === 1 ? '' : 's'} on ${pages} page${pages === 1 ? '' : 's'}${labels ? ` (${labels})` : ''}. Review the boxes, then choose Remove Watermark.`,
    'success'
  );
}

async function removeOnServer(
  regions: WatermarkRegion[]
): Promise<ServerRemovalReport> {
  const form = new FormData();
  form.append('file', pageState.file!);
  if (regions.length)
    form.append(
      'regions',
      JSON.stringify(
        regions.map(({ pageIndex, x, y, width, height }) => ({
          pageIndex,
          x,
          y,
          width,
          height,
        }))
      )
    );
  const res = await fetch(`${API_BASE_URL}/api/pdf/remove-watermarks`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(await serverError(res, 'Server removal failed'));
  const report: ServerRemovalReport = JSON.parse(
    res.headers.get('X-ChamPDF-Watermark-Report') || '{}'
  );
  const bytes = new Uint8Array(await res.arrayBuffer());
  pageState.pdfDoc = await PDFLibDocument.load(bytes);
  pdfJsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  await renderPage(pageState.currentPage);
  return {
    removed: report.removed ?? 0,
    imagePatches: report.imagePatches ?? 0,
    pages: report.pages ?? [],
    unmatched: report.unmatched ?? [],
  };
}

function undoLastSelection() {
  if (!busy) editor.undo();
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
  const serverNote = document.getElementById('server-method-note');
  const updateMethodUi = () => {
    if (!methodSelect) return;
    const isGemini = methodSelect.value === 'gemini';
    const isServer = methodSelect.value === 'server';
    geminiNote?.classList.toggle('hidden', !isGemini);
    serverNote?.classList.toggle('hidden', !isServer);
    if (radiusSlider) radiusSlider.disabled = isGemini || isServer;
  };
  methodSelect?.addEventListener('change', updateMethodUi);
  updateMethodUi();
}

async function removeWatermarks() {
  if (busy) return;
  const method = (
    document.getElementById('inpainting-method') as HTMLSelectElement
  ).value as InpaintingOptions['method'];
  if (
    !pageState.pdfDoc ||
    (pageState.regions.length === 0 && method !== 'server')
  ) {
    showAlert(
      'Error',
      'Please select at least one watermark region to remove.'
    );
    return;
  }

  showLoader('Removing watermarks...');
  busy = true;
  editor.setEnabled(false);
  const loaderProgress = document.getElementById('loader-progress');

  try {
    if (method === 'server') {
      const report = await removeOnServer(pageState.regions);
      hideLoader();
      if (!report.removed && !report.imagePatches) {
        showAlert(
          'Nothing removed',
          pageState.regions.length
            ? 'The server found no watermark text, shape or image under these boxes. Adjust the boxes and try again.'
            : 'No watermark was found automatically. Draw a box over the mark and try again.'
        );
        return;
      }
      enterLogoStep(report.pages.length);
      if (report.unmatched.length)
        showAlert(
          'Some boxes were skipped',
          `${report.unmatched.length} box${report.unmatched.length === 1 ? ' had' : 'es had'} nothing the server could remove, so ${report.unmatched.length === 1 ? 'it was' : 'they were'} left unchanged.`
        );
      return;
    }

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
    busy = false;
    if (document.getElementById('logo-panel')?.classList.contains('hidden'))
      editor.setEnabled(true);
    hideLoader();
  }
}

async function loadOpenCV(): Promise<void> {
  if ((window as any).cv?.Mat) return;
  const { cv } = await initializeOpenCV();
  (window as any).cv = cv;
}

async function processPageWithInpainting(
  pdfJsDoc: any,
  pdfLibDoc: any,
  pageIndex: number,
  regions: WatermarkRegion[],
  options: InpaintingOptions
) {
  // Render at the embedded full-page raster's native size where available.
  const page = await pdfJsDoc.getPage(pageIndex + 1);
  const viewport1 = page.getViewport({ scale: 1 });
  let nativeWidth = viewport1.width;
  let nativeHeight = viewport1.height;
  let pngLike = false;
  let rasterBacked = false;
  const ops = await page.getOperatorList();
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (
      fn !== pdfjsLib.OPS.paintImageXObject &&
      fn !== pdfjsLib.OPS.paintInlineImageXObject
    )
      continue;
    const arg = ops.argsArray[i]?.[0];
    try {
      const image =
        typeof arg === 'string'
          ? await new Promise<any>((resolve) => page.objs.get(arg, resolve))
          : arg;
      if (
        image?.width &&
        image?.height &&
        image.width * image.height > nativeWidth * nativeHeight * 0.8
      ) {
        nativeWidth = image.width;
        nativeHeight = image.height;
        rasterBacked = true;
        pngLike =
          image.kind === pdfjsLib.ImageKind.RGBA_32BPP ||
          image.kind === pdfjsLib.ImageKind.GRAYSCALE_1BPP;
      }
    } catch {
      /* PDF.js may not expose this image; keep viewport dimensions. */
    }
  }
  let scale = Math.max(
    1,
    nativeWidth / viewport1.width,
    nativeHeight / viewport1.height
  );
  if (!rasterBacked) scale = Math.max(scale, LOCAL_VECTOR_SCALE);
  scale = Math.min(
    scale,
    Math.max(
      1,
      Math.sqrt(MAX_RENDER_PIXELS / (viewport1.width * viewport1.height))
    )
  );
  const viewport = page.getViewport({ scale });

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = Math.round(viewport.width);
  tempCanvas.height = Math.round(viewport.height);
  const tempCtx = tempCanvas.getContext('2d')!;

  await page.render({
    canvasContext: tempCtx,
    canvas: tempCanvas,
    viewport: viewport,
  }).promise;

  if (options.method === 'gemini') {
    const bytes = await inpaintWithGemini(tempCanvas, regions);
    const bitmap = await createImageBitmap(
      new Blob([bytes as BlobPart], { type: 'image/png' })
    );
    tempCtx.drawImage(bitmap, 0, 0, tempCanvas.width, tempCanvas.height);
  } else if (
    !rasterBacked &&
    regions.every((region) => region.autoMaskId === undefined)
  ) {
    const imgData = tempCtx.getImageData(
      0,
      0,
      tempCanvas.width,
      tempCanvas.height
    );
    clearDocumentMarks(
      imgData,
      regions.map((region) =>
        fractionToPixels(region, tempCanvas.width, tempCanvas.height)
      )
    );
    tempCtx.putImageData(imgData, 0, 0);
  } else {
    inpaintWithOpenCV(tempCanvas, tempCtx, regions, options);
  }

  await drawRegionPatches(
    pdfLibDoc,
    pageIndex,
    tempCanvas,
    regions,
    rasterBacked && !pngLike ? 'jpeg' : 'png'
  );
}

async function drawRegionPatches(
  pdfLibDoc: any,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  regions: WatermarkRegion[],
  format: 'png' | 'jpeg'
) {
  const pdfPage = pdfLibDoc.getPage(pageIndex);
  const encode = async (source: HTMLCanvasElement) => {
    const bytes = dataUrlToBytes(
      source.toDataURL(format === 'png' ? 'image/png' : 'image/jpeg', 0.95)
    );
    return format === 'png'
      ? pdfLibDoc.embedPng(bytes)
      : pdfLibDoc.embedJpg(bytes);
  };

  if (pdfPage.getRotation().angle % 360 !== 0) {
    const { width, height } = pdfPage.getSize();
    pdfPage.drawImage(await encode(canvas), { x: 0, y: 0, width, height });
    return;
  }

  const crop = pdfPage.getCropBox();
  const pad = 2;
  for (const region of regions) {
    const px = fractionToPixels(region, canvas.width, canvas.height);
    const sx = Math.max(0, Math.floor(px.x) - pad);
    const sy = Math.max(0, Math.floor(px.y) - pad);
    const sw = Math.min(canvas.width - sx, Math.ceil(px.width) + 2 * pad);
    const sh = Math.min(canvas.height - sy, Math.ceil(px.height) + 2 * pad);
    if (sw < 1 || sh < 1) continue;
    const patch = document.createElement('canvas');
    patch.width = sw;
    patch.height = sh;
    patch.getContext('2d')!.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    pdfPage.drawImage(await encode(patch), {
      x: crop.x + (sx / canvas.width) * crop.width,
      y: crop.y + crop.height - ((sy + sh) / canvas.height) * crop.height,
      width: (sw / canvas.width) * crop.width,
      height: (sh / canvas.height) * crop.height,
    });
  }
}

function inpaintWithOpenCV(
  tempCanvas: HTMLCanvasElement,
  tempCtx: CanvasRenderingContext2D,
  regions: WatermarkRegion[],
  options: InpaintingOptions
): void {
  const cv = (window as any).cv;

  const imgData = tempCtx.getImageData(
    0,
    0,
    tempCanvas.width,
    tempCanvas.height
  );
  const src = cv.matFromImageData(imgData);
  const glyphMask = buildGlyphMask(
    imgData,
    regions
      .filter((region) => region.autoMaskId === undefined)
      .map((region) =>
        fractionToPixels(region, tempCanvas.width, tempCanvas.height)
      )
  );
  for (const region of regions) {
    if (region.autoMaskId === undefined) continue;
    const evidence = automaticMasks.get(region.autoMaskId);
    if (!evidence)
      throw new Error(
        'Watermark evidence expired. Run on-device detection again.'
      );
    const repeated = repeatingMaskToPixels(
      evidence,
      tempCanvas.width,
      tempCanvas.height
    );
    for (let i = 0; i < glyphMask.length; i++)
      if (repeated[i]) glyphMask[i] = 255;
  }
  const mask = new cv.Mat(src.rows, src.cols, cv.CV_8UC1);
  mask.data.set(glyphMask);

  const dst = new cv.Mat();
  const inpaintFlag =
    options.method === 'telea' ? cv.INPAINT_TELEA : cv.INPAINT_NS;
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  cv.inpaint(rgb, mask, dst, options.radius, inpaintFlag);
  const rgba = new cv.Mat();
  cv.cvtColor(dst, rgba, cv.COLOR_RGB2RGBA);
  cv.imshow(tempCanvas, rgba);

  src.delete();
  mask.delete();
  dst.delete();
  rgb.delete();
  rgba.delete();
}

async function inpaintWithGemini(
  tempCanvas: HTMLCanvasElement,
  regions: WatermarkRegion[]
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
    const pixels = fractionToPixels(
      region,
      tempCanvas.width,
      tempCanvas.height
    );
    maskCtx.fillRect(
      Math.floor(pixels.x),
      Math.floor(pixels.y),
      Math.ceil(pixels.width),
      Math.ceil(pixels.height)
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
  editor.setEnabled(false);
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
