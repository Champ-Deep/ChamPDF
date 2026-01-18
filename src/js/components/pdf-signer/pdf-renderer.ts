/**
 * PDF Renderer - Renders PDF pages to canvas using PDF.js
 */

import { getPDFDocument } from '../../utils/helpers.js';
import type { PageDimensions } from './types.js';

export class PDFRenderer {
  private pdfDoc: any = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 1.0;
  private currentPage = 1;
  private container: HTMLElement;
  private originalPageWidth = 0;
  private originalPageHeight = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pdf-canvas block';
    this.ctx = this.canvas.getContext('2d')!;
    container.appendChild(this.canvas);
  }

  async loadPDF(file: File): Promise<{ totalPages: number }> {
    const arrayBuffer = await file.arrayBuffer();
    this.pdfDoc = await getPDFDocument({ data: arrayBuffer }).promise;
    return { totalPages: this.pdfDoc.numPages };
  }

  async renderPage(pageNum: number): Promise<PageDimensions> {
    if (!this.pdfDoc) {
      throw new Error('PDF not loaded');
    }

    const page = await this.pdfDoc.getPage(pageNum);

    // Store original (unscaled) dimensions
    const originalViewport = page.getViewport({ scale: 1.0 });
    this.originalPageWidth = originalViewport.width;
    this.originalPageHeight = originalViewport.height;

    // Render at current scale
    const viewport = page.getViewport({ scale: this.scale });

    this.canvas.width = viewport.width;
    this.canvas.height = viewport.height;

    await page.render({
      canvasContext: this.ctx,
      viewport: viewport,
    }).promise;

    this.currentPage = pageNum;
    return { width: viewport.width, height: viewport.height };
  }

  getPageDimensions(): PageDimensions {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  setScale(scale: number) {
    this.scale = scale;
  }

  getScale(): number {
    return this.scale;
  }

  getCurrentPage(): number {
    return this.currentPage;
  }

  getOriginalPageWidth(): number {
    return this.originalPageWidth;
  }

  getOriginalPageHeight(): number {
    return this.originalPageHeight;
  }
}
