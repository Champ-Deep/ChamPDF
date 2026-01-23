import { createIcons, icons } from 'lucide';
import { showLoader, hideLoader, showAlert } from '../ui.js';
import {
  readFileAsArrayBuffer,
  formatBytes,
  getPDFDocument,
} from '../utils/helpers.js';
import * as pdfjsLib from 'pdfjs-dist';
import { redact } from './redact.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

interface RedactionRect {
  x: number;
  y: number;
  width: number;
  height: number;
  pageIndex: number;
  canvasWidth: number;
  canvasHeight: number;
}

interface RedactState {
  file: File | null;
  pdfDoc: any;
  currentPageNum: number;
  originalPdfBytes: ArrayBuffer | null;
  redactions: RedactionRect[];
  scale: number;
  isDrawing: boolean;
  startX: number;
  startY: number;
  currentRect: RedactionRect | null;
}

const redactState: RedactState = {
  file: null,
  pdfDoc: null,
  currentPageNum: 1,
  originalPdfBytes: null,
  redactions: [],
  scale: 1.5,
  isDrawing: false,
  startX: 0,
  startY: 0,
  currentRect: null,
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

  if (fileInput) fileInput.addEventListener('change', handleFileUpload);

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
      const droppedFiles = e.dataTransfer?.files;
      if (droppedFiles && droppedFiles.length > 0) handleFile(droppedFiles[0]);
    });
    fileInput?.addEventListener('click', () => {
      if (fileInput) fileInput.value = '';
    });
  }

  document.getElementById('back-to-tools')?.addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });

  document
    .getElementById('prev-page')
    ?.addEventListener('click', () => changePage(-1));
  document
    .getElementById('next-page')
    ?.addEventListener('click', () => changePage(1));
  document
    .getElementById('redact-button')
    ?.addEventListener('click', performRedaction);
}

function handleFileUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files && input.files.length > 0) handleFile(input.files[0]);
}

async function handleFile(file: File) {
  if (
    file.type !== 'application/pdf' &&
    !file.name.toLowerCase().endsWith('.pdf')
  ) {
    showAlert('Invalid File', 'Please select a PDF file.');
    return;
  }

  showLoader('Loading PDF...');
  redactState.file = file;
  redactState.redactions = [];

  try {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    redactState.originalPdfBytes = arrayBuffer as ArrayBuffer;
    // Verify PDF loading
    redactState.pdfDoc = await getPDFDocument({
      data: (arrayBuffer as ArrayBuffer).slice(0),
    }).promise;

    // We also need to set the global state for the redact function to work if it uses global state
    // However, looking at redact.ts, it imports `state` from `../state.js`.
    // We should update that global state too.
    const { state } = await import('../state.js');
    const { PDFDocument } = await import('pdf-lib');
    state.pdfDoc = await PDFDocument.load(arrayBuffer as ArrayBuffer);

    redactState.currentPageNum = 1;

    updateFileDisplay();
    await renderPage(redactState.currentPageNum);
    hideLoader();
  } catch (error) {
    console.error('Error loading PDF:', error);
    hideLoader();
    showAlert('Error', 'Failed to load PDF file.');
  }
}

function updateFileDisplay() {
  const fileDisplayArea = document.getElementById('file-display-area');
  const toolUploader = document.getElementById('tool-uploader');
  const redactionEditor = document.getElementById('redaction-editor');

  if (!fileDisplayArea || !redactState.file) return;

  fileDisplayArea.innerHTML = '';
  const fileDiv = document.createElement('div');
  fileDiv.className =
    'flex items-center justify-between bg-gray-700 p-3 rounded-lg';

  const infoContainer = document.createElement('div');
  infoContainer.className = 'flex flex-col flex-1 min-w-0';

  const nameSpan = document.createElement('div');
  nameSpan.className = 'truncate font-medium text-gray-200 text-sm mb-1';
  nameSpan.textContent = redactState.file.name;

  const metaSpan = document.createElement('div');
  metaSpan.className = 'text-xs text-gray-400';
  metaSpan.textContent = `${formatBytes(redactState.file.size)} • ${redactState.pdfDoc?.numPages || 0} pages`;

  infoContainer.append(nameSpan, metaSpan);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'ml-4 text-red-400 hover:text-red-300 flex-shrink-0';
  removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
  removeBtn.onclick = () => resetState();

  fileDiv.append(infoContainer, removeBtn);
  fileDisplayArea.appendChild(fileDiv);

  // Switch views
  if (redactionEditor) redactionEditor.classList.remove('hidden');
  // We keep the uploader visible but small or maybe hide the drop zone?
  // For consistency with other tools, we usually hide the initial upload area or adjust it.
  // But here we'll just show the editor below.
  createIcons({ icons });
}

async function renderPage(pageNum: number) {
  const container = document.getElementById('canvas-container');
  if (!container || !redactState.pdfDoc) return;

  showLoader(`Rendering Page ${pageNum}...`);
  container.innerHTML = '';

  try {
    const page = await redactState.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: redactState.scale });

    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.width = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;
    wrapper.className = 'shadow-lg';

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx!, viewport }).promise;
    wrapper.appendChild(canvas);

    // Overlay canvas for drawing
    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = viewport.width;
    overlayCanvas.height = viewport.height;
    overlayCanvas.style.position = 'absolute';
    overlayCanvas.style.top = '0';
    overlayCanvas.style.left = '0';
    overlayCanvas.style.cursor = 'crosshair';
    wrapper.appendChild(overlayCanvas);

    container.appendChild(wrapper);

    setupDrawingHandlers(overlayCanvas, viewport.width, viewport.height);
    drawRedactions(overlayCanvas);

    updatePageInfo();
    enableControls();
  } catch (err) {
    console.error(err);
    showAlert('Error', 'Failed to render page');
  } finally {
    hideLoader();
  }
}

function setupDrawingHandlers(
  canvas: HTMLCanvasElement,
  width: number,
  height: number
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    redactState.startX = e.clientX - rect.left;
    redactState.startY = e.clientY - rect.top;
    redactState.isDrawing = true;
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!redactState.isDrawing) return;

    const rect = canvas.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    const w = currentX - redactState.startX;
    const h = currentY - redactState.startY;

    drawRedactions(canvas); // Redraw existing

    // Draw current selection
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(redactState.startX, redactState.startY, w, h);
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!redactState.isDrawing) return;
    redactState.isDrawing = false;

    const rect = canvas.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    const w = currentX - redactState.startX;
    const h = currentY - redactState.startY;

    // Normalize rect (handle negative width/height)
    const x = w < 0 ? currentX : redactState.startX;
    const y = h < 0 ? currentY : redactState.startY;
    const widthVal = Math.abs(w);
    const heightVal = Math.abs(h);

    if (widthVal > 5 && heightVal > 5) {
      // Minimum size threshold
      redactState.redactions.push({
        x,
        y,
        width: widthVal,
        height: heightVal,
        pageIndex: redactState.currentPageNum - 1, // 0-based
        canvasWidth: width,
        canvasHeight: height,
      });
    }

    drawRedactions(canvas);
  });
}

function drawRedactions(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw redactions for current page
  redactState.redactions.forEach((r) => {
    if (r.pageIndex === redactState.currentPageNum - 1) {
      ctx.fillStyle = 'rgba(0, 0, 0, 1)';
      ctx.fillRect(r.x, r.y, r.width, r.height);

      // Add a delete button icon or specific styling if needed later?
      // For now just simple black boxes.
    }
  });
}

function updatePageInfo() {
  const pageInfo = document.getElementById('page-info');
  if (pageInfo && redactState.pdfDoc) {
    pageInfo.textContent = `Page ${redactState.currentPageNum} of ${redactState.pdfDoc.numPages}`;
  }
}

function changePage(offset: number) {
  if (!redactState.pdfDoc) return;
  const newPage = redactState.currentPageNum + offset;
  if (newPage >= 1 && newPage <= redactState.pdfDoc.numPages) {
    redactState.currentPageNum = newPage;
    renderPage(redactState.currentPageNum);
  }
}

function enableControls() {
  const prevBtn = document.getElementById('prev-page') as HTMLButtonElement;
  const nextBtn = document.getElementById('next-page') as HTMLButtonElement;

  if (prevBtn) prevBtn.disabled = redactState.currentPageNum <= 1;
  if (nextBtn && redactState.pdfDoc)
    nextBtn.disabled =
      redactState.currentPageNum >= redactState.pdfDoc.numPages;
}

async function performRedaction() {
  if (redactState.redactions.length === 0) {
    showAlert('No Redactions', 'Please draw at least one redaction rectangle.');
    return;
  }

  // Map the redaction rects to the format expected by redact.ts
  // redact.ts expects: { pageIndex, canvasX, canvasY, canvasWidth, canvasHeight }
  // but wait, looking at redact.ts:
  // r.canvasX, r.canvasWidth... and it divides by canvasScale.
  // We used a scale of redactState.scale.
  // So if we pass canvasScale = redactState.scale, and our coords are in that scale, it should work.

  const formattedRedactions = redactState.redactions.map((r) => ({
    pageIndex: r.pageIndex,
    canvasX: r.x,
    canvasY: r.y,
    canvasWidth: r.width,
    canvasHeight: r.height,
  }));

  await redact(formattedRedactions, redactState.scale);
}

function resetState() {
  redactState.file = null;
  redactState.pdfDoc = null;
  redactState.redactions = [];
  redactState.currentPageNum = 1;

  const editor = document.getElementById('redaction-editor');
  if (editor) editor.classList.add('hidden');

  const fileDisplay = document.getElementById('file-display-area');
  if (fileDisplay) fileDisplay.innerHTML = '';
}
