import { createIcons, icons } from 'lucide';
import { showAlert, showLoader, hideLoader } from '../ui.js';
import { downloadFile, formatBytes } from '../utils/helpers.js';
import { PDFDocument as PDFLibDocument } from 'pdf-lib';
import { ReplaceLogoState, LogoRegion, LogoReplacementOptions } from '@/types';
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

// Lake B2B logo SVG (as data URL - you can replace this with actual logo)
const LAKE_B2B_LOGO_SVG = `data:image/svg+xml;base64,${btoa(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60">
  <rect width="200" height="60" fill="#0066cc"/>
  <text x="100" y="35" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="white" text-anchor="middle">Lake B2B</text>
</svg>
`)}`;

const pageState: ReplaceLogoState = {
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
  replacementLogo: null,
};

let pdfJsDoc: any = null;
let currentRect: LogoRegion | null = null;

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
  const autoDetectBtn = document.getElementById('auto-detect-notebooklm');
  const useLakeB2BBtn = document.getElementById('use-lakeb2b-logo');
  const uploadCustomBtn = document.getElementById('upload-custom-logo');
  const logoInput = document.getElementById('replacement-logo-input') as HTMLInputElement;
  const addBgCheckbox = document.getElementById('add-background') as HTMLInputElement;
  const bgColorInput = document.getElementById('background-color') as HTMLInputElement;

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

  if (backBtn) backBtn.addEventListener('click', () => (window.location.href = import.meta.env.BASE_URL));
  if (processBtn) processBtn.addEventListener('click', replaceLogos);
  if (prevPageBtn) prevPageBtn.addEventListener('click', () => changePage(-1));
  if (nextPageBtn) nextPageBtn.addEventListener('click', () => changePage(1));
  if (clearBtn) clearBtn.addEventListener('click', clearAllSelections);
  if (undoBtn) undoBtn.addEventListener('click', undoLastSelection);
  if (autoDetectBtn) autoDetectBtn.addEventListener('click', autoDetectNotebookLM);
  if (useLakeB2BBtn) useLakeB2BBtn.addEventListener('click', useLakeB2BLogo);
  if (uploadCustomBtn) uploadCustomBtn.addEventListener('click', () => {
    const customUploadDiv = document.getElementById('custom-logo-upload');
    if (customUploadDiv) {
      customUploadDiv.classList.toggle('hidden');
    }
  });
  if (logoInput) logoInput.addEventListener('change', handleLogoUpload);
  if (addBgCheckbox) {
    addBgCheckbox.addEventListener('change', () => {
      bgColorInput.disabled = !addBgCheckbox.checked;
    });
  }

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
    const arrayBuffer = await file.arrayBuffer();
    pageState.pdfDoc = await PDFLibDocument.load(arrayBuffer);
    pageState.file = file;

    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    pdfJsDoc = await loadingTask.promise;
    pageState.totalPages = pdfJsDoc.numPages;
    pageState.currentPage = 1;

    updateFileDisplay();
    document.getElementById('logo-upload-section')?.classList.remove('hidden');
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
  fileDiv.className = 'flex items-center justify-between bg-gray-700 p-3 rounded-lg';

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
  pageState.replacementLogo = null;
  pdfJsDoc = null;

  const fileDisplayArea = document.getElementById('file-display-area');
  if (fileDisplayArea) fileDisplayArea.innerHTML = '';
  document.getElementById('logo-upload-section')?.classList.add('hidden');
  document.getElementById('canvas-panel')?.classList.add('hidden');
  document.getElementById('logo-preview-container')?.classList.add('hidden');

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  if (fileInput) fileInput.value = '';

  if (pageState.canvas) {
    const ctx = pageState.canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, pageState.canvas.width, pageState.canvas.height);
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

  drawSelections();

  const pageInfo = document.getElementById('page-info');
  if (pageInfo) pageInfo.textContent = `Page ${pageNum} of ${pageState.totalPages}`;

  const prevBtn = document.getElementById('prev-page') as HTMLButtonElement;
  const nextBtn = document.getElementById('next-page') as HTMLButtonElement;
  if (prevBtn) prevBtn.disabled = pageNum <= 1;
  if (nextBtn) nextBtn.disabled = pageNum >= pageState.totalPages;
}

function setupCanvas() {
  pageState.canvas = document.getElementById('pdf-canvas') as HTMLCanvasElement;
  if (!pageState.canvas) return;

  pageState.ctx = pageState.canvas.getContext('2d');

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

  renderPage(pageState.currentPage);
  drawCurrentSelection();
}

function handleMouseUp() {
  if (!pageState.isDrawing || !currentRect) return;

  pageState.isDrawing = false;

  if (Math.abs(currentRect.width) > 10 && Math.abs(currentRect.height) > 10) {
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

  pageState.ctx.strokeStyle = '#3b82f6';
  pageState.ctx.lineWidth = 2;
  pageState.ctx.setLineDash([5, 5]);
  pageState.ctx.strokeRect(currentRect.x, currentRect.y, currentRect.width, currentRect.height);
  pageState.ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
  pageState.ctx.fillRect(currentRect.x, currentRect.y, currentRect.width, currentRect.height);
  pageState.ctx.setLineDash([]);
}

function drawSelections() {
  if (!pageState.ctx) return;

  const currentPageRegions = pageState.regions.filter((r) => r.pageIndex === pageState.currentPage - 1);

  currentPageRegions.forEach((region) => {
    pageState.ctx!.strokeStyle = '#3b82f6';
    pageState.ctx!.lineWidth = 2;
    pageState.ctx!.strokeRect(region.x, region.y, region.width, region.height);
    pageState.ctx!.fillStyle = 'rgba(59, 130, 246, 0.2)';
    pageState.ctx!.fillRect(region.x, region.y, region.width, region.height);
  });
}

function updateSelectionInfo() {
  const infoDiv = document.getElementById('selection-info');
  if (!infoDiv) return;

  const count = pageState.regions.length;
  const currentPageCount = pageState.regions.filter((r) => r.pageIndex === pageState.currentPage - 1).length;

  infoDiv.innerHTML = `
    <span class="text-sm text-gray-400">
      ${count} logo${count !== 1 ? 's' : ''} selected
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
  const opacitySlider = document.getElementById('logo-opacity') as HTMLInputElement;
  const opacityValue = document.getElementById('opacity-value');

  opacitySlider?.addEventListener('input', () => {
    if (opacityValue) opacityValue.textContent = opacitySlider.value;
  });
}

async function useLakeB2BLogo() {
  showLoader('Loading Lake B2B logo...');

  try {
    const img = new Image();
    img.src = LAKE_B2B_LOGO_SVG;

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    pageState.replacementLogo = img;
    showLogoPreview(img);
    showAlert('Success', 'Lake B2B logo loaded successfully!', 'success');
  } catch (error) {
    console.error(error);
    showAlert('Error', 'Failed to load Lake B2B logo.');
  } finally {
    hideLoader();
  }
}

function handleLogoUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];

  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showAlert('Invalid File', 'Please upload an image file (PNG, JPG, or SVG).');
    return;
  }

  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.src = event.target?.result as string;

    img.onload = () => {
      pageState.replacementLogo = img;
      showLogoPreview(img);
      showAlert('Success', 'Custom logo uploaded successfully!', 'success');
    };

    img.onerror = () => {
      showAlert('Error', 'Failed to load the image.');
    };
  };

  reader.readAsDataURL(file);
}

function showLogoPreview(img: HTMLImageElement) {
  const previewContainer = document.getElementById('logo-preview-container');
  const previewImg = document.getElementById('logo-preview') as HTMLImageElement;

  if (previewContainer && previewImg) {
    previewImg.src = img.src;
    previewContainer.classList.remove('hidden');
  }
}

async function autoDetectNotebookLM() {
  if (!pdfJsDoc || !pageState.canvas) {
    showAlert('Error', 'Please load a PDF first.');
    return;
  }

  showLoader('Detecting NotebookLM logos...');

  try {
    let detectedCount = 0;

    // Scan all pages for NotebookLM text/logo
    for (let pageNum = 1; pageNum <= pageState.totalPages; pageNum++) {
      const page = await pdfJsDoc.getPage(pageNum);
      const textContent = await page.getTextContent();

      // Look for "Made with NotebookLM" or "NotebookLM" text
      const notebookLMItems = textContent.items.filter((item: any) => {
        const text = item.str.toLowerCase();
        return text.includes('notebooklm') || text.includes('made with');
      });

      if (notebookLMItems.length > 0) {
        // Get viewport for coordinate conversion
        const viewport = page.getViewport({ scale: pageState.scale });

        notebookLMItems.forEach((item: any) => {
          const transform = item.transform;
          const x = transform[4];
          const y = viewport.height - transform[5];

          // Create a region around the detected text
          // Adjust size based on typical NotebookLM branding dimensions
          const estimatedWidth = 150;
          const estimatedHeight = 40;

          pageState.regions.push({
            x: x - 10,
            y: y - estimatedHeight - 10,
            width: estimatedWidth,
            height: estimatedHeight,
            pageIndex: pageNum - 1,
          });

          detectedCount++;
        });
      }
    }

    if (detectedCount > 0) {
      updateSelectionInfo();
      renderPage(pageState.currentPage);
      showAlert(
        'Success',
        `Auto-detected ${detectedCount} NotebookLM logo${detectedCount !== 1 ? 's' : ''} across ${pageState.totalPages} page${pageState.totalPages !== 1 ? 's' : ''}. Review and adjust selections as needed.`,
        'success'
      );
    } else {
      showAlert('No Logos Found', 'Could not auto-detect NotebookLM logos. Please manually select logo areas.', 'info');
    }
  } catch (error) {
    console.error(error);
    showAlert('Error', 'Failed to auto-detect logos. Please manually select logo areas.');
  } finally {
    hideLoader();
  }
}

async function replaceLogos() {
  if (!pageState.pdfDoc || pageState.regions.length === 0) {
    showAlert('Error', 'Please select at least one logo region to replace.');
    return;
  }

  if (!pageState.replacementLogo) {
    showAlert('Error', 'Please upload a replacement logo first.');
    return;
  }

  showLoader('Replacing logos...');
  const loaderProgress = document.getElementById('loader-progress');

  try {
    const opacity = parseFloat((document.getElementById('logo-opacity') as HTMLInputElement).value);
    const maintainAspectRatio = (document.getElementById('maintain-aspect-ratio') as HTMLInputElement).checked;
    const addBackground = (document.getElementById('add-background') as HTMLInputElement).checked;
    const backgroundColor = (document.getElementById('background-color') as HTMLInputElement).value;

    const options: LogoReplacementOptions = {
      opacity,
      maintainAspectRatio,
      autoResize: true,
      backgroundColor,
      addBackground,
    };

    // Embed the replacement logo
    const logoCanvas = document.createElement('canvas');
    logoCanvas.width = pageState.replacementLogo.width;
    logoCanvas.height = pageState.replacementLogo.height;
    const logoCtx = logoCanvas.getContext('2d')!;
    logoCtx.drawImage(pageState.replacementLogo, 0, 0);

    const logoDataUrl = logoCanvas.toDataURL('image/png');
    const logoBytes = dataUrlToBytes(logoDataUrl);
    const embeddedLogo = await pageState.pdfDoc.embedPng(logoBytes);

    // Process each page that has regions
    const pagesWithRegions = new Set(pageState.regions.map((r) => r.pageIndex));
    let processedCount = 0;

    for (const pageIndex of pagesWithRegions) {
      if (loaderProgress) {
        loaderProgress.textContent = `Processing page ${pageIndex + 1} of ${pageState.totalPages}...`;
      }

      const pageRegions = pageState.regions.filter((r) => r.pageIndex === pageIndex);
      await processPageWithReplacement(pdfJsDoc, pageState.pdfDoc, pageIndex, pageRegions, embeddedLogo, options);
      processedCount++;
    }

    // Save the modified PDF
    const pdfBytes = await pageState.pdfDoc.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    downloadFile(blob, 'logo-replaced.pdf');

    showAlert('Success', `Logos replaced successfully on ${processedCount} page${processedCount !== 1 ? 's' : ''}!`, 'success', () => {
      resetState();
    });
  } catch (error: any) {
    console.error(error);
    showAlert('Error', error.message || 'Failed to replace logos. Please try again.');
  } finally {
    hideLoader();
  }
}

async function processPageWithReplacement(
  pdfJsDoc: any,
  pdfLibDoc: any,
  pageIndex: number,
  regions: LogoRegion[],
  embeddedLogo: any,
  options: LogoReplacementOptions
) {
  const pdfPage = pdfLibDoc.getPage(pageIndex);
  const { width: pageWidth, height: pageHeight } = pdfPage.getSize();

  // Scale ratio to convert from canvas coordinates to PDF coordinates
  const scaleRatio = pageState.scale;

  regions.forEach((region) => {
    // Convert canvas coordinates to PDF coordinates
    const pdfX = region.x / scaleRatio;
    const pdfY = pageHeight - (region.y / scaleRatio) - (region.height / scaleRatio);
    const pdfWidth = region.width / scaleRatio;
    const pdfHeight = region.height / scaleRatio;

    // Draw background if enabled
    if (options.addBackground) {
      const bgColor = hexToRgb(options.backgroundColor);
      pdfPage.drawRectangle({
        x: pdfX,
        y: pdfY,
        width: pdfWidth,
        height: pdfHeight,
        color: { type: 'RGB', red: bgColor.r / 255, green: bgColor.g / 255, blue: bgColor.b / 255 },
        opacity: 1,
      });
    }

    // Calculate logo dimensions
    let logoWidth = pdfWidth;
    let logoHeight = pdfHeight;

    if (options.maintainAspectRatio) {
      const logoAspectRatio = embeddedLogo.width / embeddedLogo.height;
      const regionAspectRatio = pdfWidth / pdfHeight;

      if (logoAspectRatio > regionAspectRatio) {
        // Logo is wider, fit to width
        logoHeight = logoWidth / logoAspectRatio;
      } else {
        // Logo is taller, fit to height
        logoWidth = logoHeight * logoAspectRatio;
      }
    }

    // Center the logo in the region
    const logoX = pdfX + (pdfWidth - logoWidth) / 2;
    const logoY = pdfY + (pdfHeight - logoHeight) / 2;

    // Draw the replacement logo
    pdfPage.drawImage(embeddedLogo, {
      x: logoX,
      y: logoY,
      width: logoWidth,
      height: logoHeight,
      opacity: options.opacity,
    });
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

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 255, g: 255, b: 255 };
}
