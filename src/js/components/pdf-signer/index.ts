/**
 * PDF Signer - Main orchestrator for DocuSign-like PDF signing experience
 *
 * Combines:
 * - PDFRenderer: Renders PDF pages to canvas
 * - AnnotationLayer: Manages draggable overlays
 * - SignerToolbar: Left sidebar with tools
 */

import { PDFRenderer } from './pdf-renderer.js';
import { AnnotationLayer } from './annotation-layer.js';
import { SignerToolbar, type AnnotationType } from './toolbar.js';
import type {
  Annotation,
  SignerState,
  PageDimensions,
  TextStyle,
} from './types.js';
import { PDFDocument } from 'pdf-lib';
import { drawTextBox, getTextStyle } from './text-style.js';
import { removeImageBackground } from './image-background.js';
import { downloadFile } from '../../utils/helpers.js';

export class PDFSigner {
  private state: SignerState = {
    pdfDoc: null,
    currentPage: 1,
    totalPages: 0,
    scale: 1.0,
    annotations: [],
    selectedAnnotation: null,
  };

  private renderer: PDFRenderer;
  private annotationLayer: AnnotationLayer;
  private toolbar: SignerToolbar;
  private file: File | null = null;
  private canvasContainer: HTMLElement;
  private annotationContainer: HTMLElement;
  private pageContainer: HTMLElement | null = null;
  private scrollContainer: HTMLElement | null = null;
  private onPageChange?: (current: number, total: number) => void;
  private onZoomChange?: (scale: number) => void;
  private events = new AbortController();
  private imageProcessing = false;

  constructor(
    canvasContainer: HTMLElement,
    annotationContainer: HTMLElement,
    toolbarContainer: HTMLElement,
    options?: {
      onPageChange?: (current: number, total: number) => void;
      onZoomChange?: (scale: number) => void;
    }
  ) {
    this.canvasContainer = canvasContainer;
    this.annotationContainer = annotationContainer;
    this.pageContainer = canvasContainer.parentElement;
    this.scrollContainer = document.getElementById('pdf-scroll-container');
    this.onPageChange = options?.onPageChange;
    this.onZoomChange = options?.onZoomChange;

    this.renderer = new PDFRenderer(canvasContainer);

    this.annotationLayer = new AnnotationLayer(
      annotationContainer,
      (annotation) => this.updateAnnotation(annotation),
      (id) => {
        this.state.selectedAnnotation = id;
        this.toolbar.setSelection(
          this.state.annotations.find((a) => a.id === id) || null
        );
      }
    );

    this.toolbar = new SignerToolbar(toolbarContainer, {
      onAddAnnotation: (type, data) => this.addAnnotation(type, data),
      onDeleteSelected: () => this.deleteSelected(),
      onUpdateTextStyle: (style) => this.updateSelectedTextStyle(style),
      onRemoveImageBackground: (tolerance) =>
        this.removeSelectedImageBackground(tolerance),
      onRestoreImageBackground: () => this.restoreSelectedImageBackground(),
    });

    this.setupDropZone();
    this.setupKeyboardShortcuts();
  }

  async loadPDF(file: File) {
    this.file = file;
    const { totalPages } = await this.renderer.loadPDF(file);
    this.state.totalPages = totalPages;
    this.state.currentPage = 1;
    this.state.annotations = [];
    await this.renderCurrentPage();
    this.notifyPageChange();
  }

  private async renderCurrentPage() {
    const dims = await this.renderer.renderPage(this.state.currentPage);

    // Sync annotation container size with canvas
    this.syncAnnotationLayerSize(dims);

    // Clear and re-render annotations for this page
    this.annotationLayer.clear();
    this.annotationLayer.setScale(this.state.scale);
    this.state.annotations
      .filter((a) => a.page === this.state.currentPage)
      .forEach((a) => this.annotationLayer.addAnnotation(a));

    // Update selection state
    this.toolbar.setSelection(null);
    this.state.selectedAnnotation = null;
  }

  private syncAnnotationLayerSize(dims: PageDimensions) {
    // The annotation overlay uses absolute inset-0 within pdf-page-container
    // We just need to ensure the page container is sized correctly
    if (this.pageContainer) {
      this.pageContainer.style.width = `${dims.width}px`;
      this.pageContainer.style.height = `${dims.height}px`;
    }
  }

  private setupDropZone() {
    const container = this.annotationContainer;

    container.addEventListener(
      'dragover',
      (e) => {
        e.preventDefault();
        container.classList.add('ring-2', 'ring-orange-500', 'ring-inset');
      },
      { signal: this.events.signal }
    );

    container.addEventListener(
      'dragleave',
      (e) => {
        // Only remove highlight if leaving the container entirely
        const rect = container.getBoundingClientRect();
        const x = e.clientX;
        const y = e.clientY;
        if (
          x < rect.left ||
          x > rect.right ||
          y < rect.top ||
          y > rect.bottom
        ) {
          container.classList.remove('ring-2', 'ring-orange-500', 'ring-inset');
        }
      },
      { signal: this.events.signal }
    );

    container.addEventListener(
      'drop',
      (e) => {
        e.preventDefault();
        container.classList.remove('ring-2', 'ring-orange-500', 'ring-inset');

        const dataStr = (e as DragEvent).dataTransfer?.getData(
          'application/json'
        );
        if (dataStr) {
          try {
            const data = JSON.parse(dataStr);
            const rect = container.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;

            this.addAnnotation(data.type, { imageUrl: data.imageUrl }, x, y);
          } catch (err) {
            console.error('Failed to parse drop data:', err);
          }
        }
      },
      { signal: this.events.signal }
    );
  }

  private addAnnotation(
    type: AnnotationType,
    data?: { imageUrl?: string },
    x?: number,
    y?: number
  ) {
    // If no position provided, calculate visible viewport center
    if (x === undefined || y === undefined) {
      const viewportCenter = this.getVisibleViewportCenter();
      x = viewportCenter.x;
      y = viewportCenter.y;
    }

    // Determine default size based on type
    let width = 20;
    let height = 8;

    if (type === 'checkbox') {
      width = 3;
      height = 3;
    } else if (type === 'date') {
      width = 15;
      height = 4;
    } else if (type === 'text') {
      width = 25;
      height = 12;
    } else if (type === 'initials') {
      width = 10;
      height = 6;
    }

    const annotation: Annotation = {
      id: crypto.randomUUID(),
      type,
      page: this.state.currentPage,
      x: Math.max(0, Math.min(100 - width, x - width / 2)),
      y: Math.max(0, Math.min(100 - height, y - height / 2)),
      width,
      height,
      data: {
        imageUrl: data?.imageUrl,
        text: type === 'date' ? new Date().toLocaleDateString() : undefined,
        checked: type === 'checkbox' ? false : undefined,
        ...(type === 'text' ? getTextStyle({}) : {}),
      },
    };

    this.state.annotations.push(annotation);
    this.annotationLayer.addAnnotation(annotation);
    this.annotationLayer.select(annotation.id);
  }

  private getVisibleViewportCenter(): { x: number; y: number } {
    if (!this.scrollContainer || !this.pageContainer) {
      return { x: 50, y: 50 };
    }

    const containerRect = this.pageContainer.getBoundingClientRect();
    const scrollRect = this.scrollContainer.getBoundingClientRect();

    // Calculate the visible portion of the PDF
    const visibleTop = Math.max(0, scrollRect.top - containerRect.top);
    const visibleBottom = Math.min(
      containerRect.height,
      scrollRect.bottom - containerRect.top
    );
    const visibleLeft = Math.max(0, scrollRect.left - containerRect.left);
    const visibleRight = Math.min(
      containerRect.width,
      scrollRect.right - containerRect.left
    );

    // Center of visible area as percentage
    const centerX =
      ((visibleLeft + visibleRight) / 2 / containerRect.width) * 100;
    const centerY =
      ((visibleTop + visibleBottom) / 2 / containerRect.height) * 100;

    // Clamp to valid range
    return {
      x: Math.max(10, Math.min(90, centerX)),
      y: Math.max(10, Math.min(90, centerY)),
    };
  }

  private updateAnnotation(updated: Annotation) {
    const idx = this.state.annotations.findIndex((a) => a.id === updated.id);
    if (idx !== -1) {
      this.state.annotations[idx] = updated;
    }
  }

  deleteSelected() {
    if (this.state.selectedAnnotation) {
      this.state.annotations = this.state.annotations.filter(
        (a) => a.id !== this.state.selectedAnnotation
      );
      this.annotationLayer.removeAnnotation(this.state.selectedAnnotation);
      this.state.selectedAnnotation = null;
      this.toolbar.setSelection(null);
    }
  }

  private setupKeyboardShortcuts() {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if not typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.state.selectedAnnotation) {
          e.preventDefault();
          this.deleteSelected();
        }
      } else if (e.key === 'Escape') {
        this.annotationLayer.select(null);
        this.toolbar.setSelection(null);
      }
    };

    document.addEventListener('keydown', handleKeyDown, {
      signal: this.events.signal,
    });
  }

  async goToPage(page: number) {
    if (
      page >= 1 &&
      page <= this.state.totalPages &&
      page !== this.state.currentPage
    ) {
      this.state.currentPage = page;
      await this.renderCurrentPage();
      this.notifyPageChange();
    }
  }

  async nextPage() {
    if (this.state.currentPage < this.state.totalPages) {
      await this.goToPage(this.state.currentPage + 1);
    }
  }

  async prevPage() {
    if (this.state.currentPage > 1) {
      await this.goToPage(this.state.currentPage - 1);
    }
  }

  // Zoom methods
  async setZoom(scale: number) {
    this.state.scale = Math.max(0.5, Math.min(3, scale));
    this.renderer.setScale(this.state.scale);
    await this.renderCurrentPage();
    this.onZoomChange?.(this.state.scale);
  }

  async zoomIn() {
    await this.setZoom(this.state.scale + 0.25);
  }

  async zoomOut() {
    await this.setZoom(this.state.scale - 0.25);
  }

  async fitToWidth(containerWidth: number) {
    const pdfWidth = this.renderer.getOriginalPageWidth();
    if (pdfWidth > 0) {
      const scale = (containerWidth - 48) / pdfWidth; // 48px for padding
      await this.setZoom(scale);
    }
  }

  getZoom(): number {
    return this.state.scale;
  }

  private notifyPageChange() {
    this.onPageChange?.(this.state.currentPage, this.state.totalPages);
  }

  async savePDF(): Promise<void> {
    if (this.imageProcessing)
      throw new Error(
        'Wait for image background cleanup to finish before saving.'
      );
    if (!this.file) {
      throw new Error('No PDF file loaded');
    }

    const arrayBuffer = await this.file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    const pages = pdfDoc.getPages();

    // Embed annotations into PDF
    for (const annotation of this.state.annotations) {
      if (annotation.page < 1 || annotation.page > pages.length) continue;

      const page = pages[annotation.page - 1];
      const { width: pageWidth, height: pageHeight } = page.getSize();

      const x = (annotation.x / 100) * pageWidth;
      const w = (annotation.width / 100) * pageWidth;
      const h = (annotation.height / 100) * pageHeight;
      // PDF coordinates start from bottom-left, so we need to flip Y
      const y = pageHeight - (annotation.y / 100) * pageHeight - h;

      if (
        (annotation.type === 'signature' || annotation.type === 'initials') &&
        annotation.data.imageUrl
      ) {
        try {
          const response = await fetch(annotation.data.imageUrl);
          const imageBytes = new Uint8Array(await response.arrayBuffer());

          // Determine image type and embed accordingly
          let image;
          const mimeType = response.headers.get('content-type') || '';
          if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
            image = await pdfDoc.embedJpg(imageBytes);
          } else {
            // Default to PNG
            image = await pdfDoc.embedPng(imageBytes);
          }

          const fitted = image.scaleToFit(w, h);
          page.drawImage(image, {
            x: x + (w - fitted.width) / 2,
            y: y + (h - fitted.height) / 2,
            ...fitted,
          });
        } catch (err) {
          console.error('Failed to embed signature image:', err);
          throw new Error(
            'Unable to save a signature image. Restore it or upload it again before saving.',
            { cause: err }
          );
        }
      } else if (annotation.type === 'initials' && annotation.data.text) {
        // Draw initials as text (when no image is provided)
        const text = annotation.data.text;
        page.drawText(text, {
          x: x + w * 0.1,
          y: y + h * 0.3,
          size: Math.min(w, h) * 0.4,
        });
      } else if (annotation.type === 'text') {
        await drawTextBox(pdfDoc, page, annotation);
      } else if (annotation.type === 'date') {
        const text = annotation.data.text || '';
        if (text) {
          // Adjust font size based on bounding box
          // For dates and texts, a simple fit can use bounding box height, or default to 12
          const fontSize = Math.min(12, Math.max(8, h * 0.8));
          page.drawText(text, {
            x: x + 2, // Slight padding
            y: y + (h - fontSize) / 2, // Center vertically
            size: fontSize,
            maxWidth: w - 4,
            wordBreaks: [' '],
            lineHeight: fontSize * 1.2,
          });
        }
      } else if (annotation.type === 'checkbox' && annotation.data.checked) {
        // Draw a checkmark for checked boxes
        page.drawLine({
          start: { x: x + w * 0.2, y: y + h * 0.5 },
          end: { x: x + w * 0.4, y: y + h * 0.25 },
          thickness: 1.5,
        });
        page.drawLine({
          start: { x: x + w * 0.4, y: y + h * 0.25 },
          end: { x: x + w * 0.8, y: y + h * 0.8 },
          thickness: 1.5,
        });
      }
    }

    const pdfBytes = await pdfDoc.save();
    // Cast to BlobPart to satisfy TypeScript strict mode
    const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
    downloadFile(blob, `signed_${this.file.name}`);
  }

  getPageInfo() {
    return {
      current: this.state.currentPage,
      total: this.state.totalPages,
    };
  }

  getAnnotations(): Annotation[] {
    return [...this.state.annotations];
  }

  hasAnnotations(): boolean {
    return this.state.annotations.length > 0;
  }

  async refreshToolbar() {
    await this.toolbar.refresh();
  }

  private updateSelectedTextStyle(style: Partial<TextStyle>) {
    const annotation = this.state.annotations.find(
      (a) => a.id === this.state.selectedAnnotation
    );
    if (!annotation || annotation.type !== 'text') return;
    Object.assign(
      annotation.data,
      getTextStyle({ ...annotation.data, ...style })
    );
    this.annotationLayer.updateTextStyle(annotation);
    this.toolbar.setSelection(annotation);
  }

  private async removeSelectedImageBackground(tolerance: number) {
    const annotation = this.state.annotations.find(
      (a) => a.id === this.state.selectedAnnotation
    );
    if (!annotation?.data.imageUrl) return;
    const original =
      annotation.data.originalImageUrl || annotation.data.imageUrl;
    this.imageProcessing = true;
    let processed: string;
    try {
      processed = await removeImageBackground(original, tolerance);
    } finally {
      this.imageProcessing = false;
    }
    // Selection, page or document may have changed while the image decoded.
    if (!this.state.annotations.includes(annotation)) return;
    annotation.data.originalImageUrl = original;
    annotation.data.imageUrl = processed;
    this.annotationLayer.updateAnnotationContent(annotation);
    if (this.state.selectedAnnotation === annotation.id)
      this.toolbar.setSelection(annotation);
  }

  private restoreSelectedImageBackground() {
    const annotation = this.state.annotations.find(
      (a) => a.id === this.state.selectedAnnotation
    );
    if (!annotation?.data.originalImageUrl) return;
    annotation.data.imageUrl = annotation.data.originalImageUrl;
    delete annotation.data.originalImageUrl;
    this.annotationLayer.updateAnnotationContent(annotation);
    this.toolbar.setSelection(annotation);
  }

  destroy() {
    this.events.abort();
    this.annotationLayer.destroy();
    this.state.annotations = [];
    this.state.selectedAnnotation = null;
    this.file = null;
    this.toolbar.destroy();
  }
}

export type { Annotation, SignerState, PageDimensions } from './types.js';
