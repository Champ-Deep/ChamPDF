import { showLoader, hideLoader, showAlert } from '../ui.js';
import {
  downloadFile,
  readFileAsArrayBuffer,
  formatBytes,
  getPDFDocument,
} from '../utils/helpers.js';
import { state } from '../state.js';
import { createIcons, icons } from 'lucide';
import PptxGenJS from 'pptxgenjs';

document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');
  const processBtn = document.getElementById('process-btn');
  const fileDisplayArea = document.getElementById('file-display-area');
  const convertOptions = document.getElementById('convert-options');
  const fileControls = document.getElementById('file-controls');
  const addMoreBtn = document.getElementById('add-more-btn');
  const clearFilesBtn = document.getElementById('clear-files-btn');
  const backBtn = document.getElementById('back-to-tools');

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      window.location.href = import.meta.env.BASE_URL;
    });
  }

  const updateUI = async () => {
    if (!fileDisplayArea || !convertOptions || !processBtn || !fileControls)
      return;

    if (state.files.length > 0) {
      fileDisplayArea.innerHTML = '';

      for (let index = 0; index < state.files.length; index++) {
        const file = state.files[index];
        const fileDiv = document.createElement('div');
        fileDiv.className =
          'flex items-center justify-between bg-gray-700 p-3 rounded-lg text-sm';

        const infoContainer = document.createElement('div');
        infoContainer.className = 'flex flex-col overflow-hidden';

        const nameSpan = document.createElement('div');
        nameSpan.className = 'truncate font-medium text-gray-200 text-sm mb-1';
        nameSpan.textContent = file.name;

        const metaSpan = document.createElement('div');
        metaSpan.className = 'text-xs text-gray-400';
        metaSpan.textContent = `${formatBytes(file.size)} • Loading pages...`;

        infoContainer.append(nameSpan, metaSpan);

        const removeBtn = document.createElement('button');
        removeBtn.className =
          'ml-4 text-red-400 hover:text-red-300 flex-shrink-0';
        removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
        removeBtn.onclick = () => {
          state.files = state.files.filter((_: File, i: number) => i !== index);
          updateUI();
        };

        fileDiv.append(infoContainer, removeBtn);
        fileDisplayArea.appendChild(fileDiv);

        try {
          const arrayBuffer = await readFileAsArrayBuffer(file);
          const pdfDoc = await getPDFDocument({ data: arrayBuffer }).promise;
          metaSpan.textContent = `${formatBytes(file.size)} • ${pdfDoc.numPages} pages → ${pdfDoc.numPages} slides`;
        } catch (error) {
          metaSpan.textContent = `${formatBytes(file.size)} • Could not load page count`;
        }
      }

      createIcons({ icons });
      fileControls.classList.remove('hidden');
      convertOptions.classList.remove('hidden');
      (processBtn as HTMLButtonElement).disabled = false;
    } else {
      fileDisplayArea.innerHTML = '';
      fileControls.classList.add('hidden');
      convertOptions.classList.add('hidden');
      (processBtn as HTMLButtonElement).disabled = true;
    }
  };

  const resetState = () => {
    state.files = [];
    state.pdfDoc = null;
    updateUI();
  };

  const convertPdfToPptx = async (file: File): Promise<Blob> => {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    const pdfDoc = await getPDFDocument({ data: arrayBuffer }).promise;
    const numPages = pdfDoc.numPages;

    // Create PowerPoint presentation
    const pptx = new PptxGenJS();
    pptx.author = 'ChamPDF';
    pptx.title = file.name.replace(/\.pdf$/i, '');
    pptx.subject = 'Converted from PDF';

    // Render each page at high resolution and add as slide
    const scale = 2.0; // 2x resolution for quality

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      showLoader(`Converting page ${pageNum} of ${numPages}...`);

      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale });

      // Create canvas and render page
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({
        canvasContext: ctx,
        viewport: viewport,
        canvas: canvas,
      }).promise;

      // Convert canvas to base64 image
      const imageData = canvas.toDataURL('image/png');

      // Add slide with the page image
      const slide = pptx.addSlide();

      // Calculate dimensions to fit the slide (default 10" x 7.5")
      // Maintain aspect ratio
      const pageAspect = viewport.width / viewport.height;
      const slideAspect = 10 / 7.5;

      let imgWidth: number, imgHeight: number, imgX: number, imgY: number;

      if (pageAspect > slideAspect) {
        // Page is wider than slide - fit to width
        imgWidth = 10;
        imgHeight = 10 / pageAspect;
        imgX = 0;
        imgY = (7.5 - imgHeight) / 2;
      } else {
        // Page is taller than slide - fit to height
        imgHeight = 7.5;
        imgWidth = 7.5 * pageAspect;
        imgX = (10 - imgWidth) / 2;
        imgY = 0;
      }

      slide.addImage({
        data: imageData,
        x: imgX,
        y: imgY,
        w: imgWidth,
        h: imgHeight,
      });

      // Clean up
      canvas.width = 0;
      canvas.height = 0;
    }

    // Generate PPTX blob
    showLoader('Generating PowerPoint file...');
    const pptxBlob = (await pptx.write({ outputType: 'blob' })) as Blob;

    return pptxBlob;
  };

  const convert = async () => {
    try {
      if (state.files.length === 0) {
        showAlert('No Files', 'Please select at least one PDF file.');
        return;
      }

      showLoader('Starting conversion...');

      if (state.files.length === 1) {
        const file = state.files[0];
        const pptxBlob = await convertPdfToPptx(file);
        const outName = file.name.replace(/\.pdf$/i, '') + '.pptx';

        downloadFile(pptxBlob, outName);
        hideLoader();

        showAlert(
          'Conversion Complete',
          `Successfully converted ${file.name} to PowerPoint.`,
          'success',
          () => resetState()
        );
      } else {
        showLoader('Converting multiple PDFs...');
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();

        for (let i = 0; i < state.files.length; i++) {
          const file = state.files[i];
          showLoader(
            `Converting ${i + 1}/${state.files.length}: ${file.name}...`
          );

          const pptxBlob = await convertPdfToPptx(file);
          const baseName = file.name.replace(/\.pdf$/i, '');
          const arrayBuffer = await pptxBlob.arrayBuffer();
          zip.file(`${baseName}.pptx`, arrayBuffer);
        }

        showLoader('Creating ZIP archive...');
        const zipBlob = await zip.generateAsync({ type: 'blob' });

        downloadFile(zipBlob, 'converted-presentations.zip');
        hideLoader();

        showAlert(
          'Conversion Complete',
          `Successfully converted ${state.files.length} PDF(s) to PowerPoint.`,
          'success',
          () => resetState()
        );
      }
    } catch (e: unknown) {
      hideLoader();
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      showAlert(
        'Error',
        `An error occurred during conversion. Error: ${errorMessage}`
      );
    }
  };

  const handleFileSelect = (files: FileList | null) => {
    if (files && files.length > 0) {
      const pdfFiles = Array.from(files).filter(
        (f) =>
          f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
      );
      state.files = [...state.files, ...pdfFiles];
      updateUI();
    }
  };

  if (fileInput && dropZone) {
    fileInput.addEventListener('change', (e) => {
      handleFileSelect((e.target as HTMLInputElement).files);
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('bg-gray-700');
    });

    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dropZone.classList.remove('bg-gray-700');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('bg-gray-700');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        handleFileSelect(files);
      }
    });

    fileInput.addEventListener('click', () => {
      fileInput.value = '';
    });
  }

  if (addMoreBtn) {
    addMoreBtn.addEventListener('click', () => {
      fileInput.click();
    });
  }

  if (clearFilesBtn) {
    clearFilesBtn.addEventListener('click', () => {
      resetState();
    });
  }

  if (processBtn) {
    processBtn.addEventListener('click', convert);
  }
});
