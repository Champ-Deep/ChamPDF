/**
 * mupdf-engine — a drop-in replacement for `@bentopdf/pymupdf-wasm` backed by
 * Artifex's official `mupdf` (mupdf.js) WASM build.
 *
 * Why: the old engine ran MuPDF *inside Pyodide* (a full CPython-in-WASM),
 * which was ~54MB of assets, booted a Python VM before any PDF work, and
 * crashed on load ("No module named 'encodings'"). mupdf.js is the same MuPDF
 * engine compiled straight to WASM (~10MB, no Python), so rendering/text/
 * redaction fidelity is identical while load + reliability improve massively.
 *
 * This module mirrors the subset of the old `PyMuPDF` API the tools use, so a
 * tool migrates by only changing its import. mupdf (and pdf-lib, used to
 * assemble image/text PDFs) are lazy-imported: the wasm is fetched the first
 * time a tool actually runs, never at page load.
 *
 * Table detection (findTables) is intentionally NOT here — MuPDF core has no
 * table finder (it was a PyMuPDF Python-layer feature). Those tools call the
 * backend /api/extract-tables (server-side PyMuPDF) instead.
 */

type Mupdf = typeof import('mupdf');
let _mupdf: Mupdf | null = null;
let _loading: Promise<Mupdf> | null = null;

async function loadMupdf(): Promise<Mupdf> {
  if (_mupdf) return _mupdf;
  if (!_loading) _loading = import('mupdf').then((m) => (_mupdf = m));
  return _loading;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface Color {
  r: number;
  g: number;
  b: number;
}
export interface SaveOptions {
  garbage?: number;
  deflate?: boolean;
  clean?: boolean;
}
export interface ExtractedImage {
  data: Uint8Array;
  ext: string;
}

async function toBytes(
  src: Blob | ArrayBuffer | Uint8Array
): Promise<Uint8Array> {
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  return new Uint8Array(await src.arrayBuffer());
}

function saveOptsToString(o?: SaveOptions): string {
  const parts = [`garbage=${o?.garbage ?? 3}`];
  if (o?.deflate !== false) parts.push('compress=yes');
  if (o?.clean) parts.push('sanitize=yes');
  return parts.join(',');
}

/** Render every page of an opened mupdf document to a fresh image-only PDF. */
async function renderDocToImagePdf(
  m: Mupdf,
  doc: any,
  dpi: number
): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();
  const scale = dpi / 72;
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const pix = page.toPixmap(
      m.Matrix.scale(scale, scale),
      m.ColorSpace.DeviceRGB,
      false
    );
    const png = pix.asPNG();
    pix.destroy?.();
    page.destroy?.();
    const img = await out.embedPng(png);
    const p = out.addPage([img.width, img.height]);
    p.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  return out.save();
}

class MuPage {
  private _imageCache: ExtractedImage[] | null = null;

  constructor(
    private m: Mupdf,
    public readonly _page: any
  ) {}

  getSize(): { width: number; height: number } {
    const [x0, y0, x1, y1] = this._page.getBounds();
    return { width: x1 - x0, height: y1 - y0 };
  }

  getRotation(): number {
    return typeof this._page.getRotation === 'function'
      ? this._page.getRotation()
      : 0;
  }

  setRotation(angle: number): void {
    if (typeof this._page.setRotation === 'function')
      this._page.setRotation(angle);
  }

  getText(format: 'text' | 'json' = 'text'): string {
    const st = this._page.toStructuredText('preserve-whitespace');
    try {
      return format === 'json' ? st.asJSON() : st.asText();
    } finally {
      st.destroy?.();
    }
  }

  toSvg(): string {
    const buf = new this.m.Buffer();
    const writer = new this.m.DocumentWriter(buf, 'svg', '');
    const dev = writer.beginPage(this._page.getBounds());
    this._page.run(dev, this.m.Matrix.identity);
    writer.endPage();
    writer.close();
    dev.destroy?.();
    return buf.asString();
  }

  /** Embedded images on the page, extracted as PNG. */
  getImages(): { xref: number }[] {
    if (!this._imageCache) {
      const cache: ExtractedImage[] = [];
      const st = this._page.toStructuredText('preserve-images');
      st.walk({
        onImageBlock: (_bbox: any, _transform: any, image: any) => {
          try {
            const pix = image.toPixmap();
            cache.push({ data: pix.asPNG(), ext: 'png' });
            pix.destroy?.();
          } catch {
            /* skip undecodable image */
          }
        },
      });
      st.destroy?.();
      this._imageCache = cache;
    }
    return this._imageCache.map((_, i) => ({ xref: i }));
  }

  extractImage(xref: number): ExtractedImage | null {
    return this._imageCache?.[xref] ?? null;
  }

  addRedaction(rect: Rect, _text?: string, _fill?: Color): void {
    const annot = this._page.createAnnotation('Redact');
    annot.setRect([rect.x0, rect.y0, rect.x1, rect.y1]);
    annot.update();
  }

  applyRedactions(): void {
    this._page.applyRedactions();
  }
}

class MuDocument {
  constructor(
    private m: Mupdf,
    public readonly _doc: any
  ) {}

  get pageCount(): number {
    return this._doc.countPages();
  }
  getPageCount(): number {
    return this._doc.countPages();
  }

  getPage(index: number): MuPage {
    return new MuPage(this.m, this._doc.loadPage(index));
  }

  save(options?: SaveOptions): Uint8Array {
    return this._doc.saveToBuffer(saveOptsToString(options)).asUint8Array();
  }

  close(): void {
    try {
      this._doc.destroy?.();
    } catch {
      /* already freed */
    }
  }
}

export class PyMuPDF {
  // Options are accepted for API compatibility but unused: mupdf.js locates its
  // own wasm through the bundler, so there is no manual asset path to get wrong.
  constructor(_opts?: unknown) {}

  async load(): Promise<void> {
    await loadMupdf();
  }

  /** Open a PDF for reading/editing. */
  async open(src: Blob | ArrayBuffer | Uint8Array): Promise<MuDocument> {
    const m = await loadMupdf();
    const doc = m.PDFDocument.openDocument(
      await toBytes(src),
      'application/pdf'
    );
    return new MuDocument(m, doc);
  }

  /** Extract all text from a PDF as plain text. */
  async pdfToText(file: Blob): Promise<string> {
    const doc = await this.open(file);
    try {
      const out: string[] = [];
      for (let i = 0; i < doc.getPageCount(); i++)
        out.push(doc.getPage(i).getText('text'));
      return out.join('\n');
    } finally {
      doc.close();
    }
  }

  /**
   * Basic Markdown extraction. MuPDF core has no rich markdown exporter
   * (PyMuPDF's was a Python add-on), so this emits paragraph-separated text —
   * good enough for LLM ingestion; layout-heavy tables are best via the backend.
   */
  async pdfToMarkdown(
    file: Blob,
    _opts?: { includeImages?: boolean }
  ): Promise<string> {
    const doc = await this.open(file);
    try {
      const parts: string[] = [];
      for (let i = 0; i < doc.getPageCount(); i++) {
        parts.push(`<!-- page ${i + 1} -->`);
        parts.push(doc.getPage(i).getText('text').trim());
      }
      return parts.join('\n\n');
    } finally {
      doc.close();
    }
  }

  /** Recompress / garbage-collect a PDF to shrink it. */
  async compressPdf(file: Blob): Promise<Uint8Array> {
    const doc = await this.open(file);
    try {
      return doc.save({ garbage: 4, deflate: true, clean: true });
    } finally {
      doc.close();
    }
  }

  /** Rasterize a PDF: render each page to an image and rebuild as an image PDF. */
  async rasterizePdf(file: Blob, opts?: { dpi?: number }): Promise<Blob> {
    const m = await loadMupdf();
    const doc = m.Document.openDocument(await toBytes(file), 'application/pdf');
    const bytes = await renderDocToImagePdf(m, doc, opts?.dpi ?? 150);
    return new Blob([bytes as BlobPart], { type: 'application/pdf' });
  }

  /**
   * Open ANY MuPDF-supported format (epub, xps, cbz, fb2, mobi, svg…) and write
   * it out as a PDF. `filetype`/filename drives format auto-detection.
   */
  async convertToPdf(
    src: Blob & { name?: string },
    opts?: { filetype?: string }
  ): Promise<Blob> {
    const m = await loadMupdf();
    const magic = opts?.filetype || (src as any).name || 'document';
    const doc = m.Document.openDocument(await toBytes(src), magic);
    const buf = new m.Buffer();
    const writer = new m.DocumentWriter(buf, 'pdf', '');
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const dev = writer.beginPage(page.getBounds());
      page.run(dev, m.Matrix.identity);
      writer.endPage();
      dev.destroy?.();
      page.destroy?.();
    }
    writer.close();
    return new Blob([buf.asUint8Array() as BlobPart], {
      type: 'application/pdf',
    });
  }

  /**
   * Build a PDF from one or more images (png/jpg/webp/psd/gif/bmp/tiff…). Each
   * image is decoded by MuPDF, rendered, and placed on its own page.
   */
  async imagesToPdf(files: (Blob & { name?: string })[]): Promise<Blob> {
    const m = await loadMupdf();
    const { PDFDocument } = await import('pdf-lib');
    const out = await PDFDocument.create();
    for (const f of files) {
      const magic = (f as any).name || 'image.png';
      const doc = m.Document.openDocument(await toBytes(f), magic);
      const page = doc.loadPage(0);
      const pix = page.toPixmap(
        m.Matrix.identity,
        m.ColorSpace.DeviceRGB,
        false
      );
      const png = pix.asPNG();
      pix.destroy?.();
      const img = await out.embedPng(png);
      const p = out.addPage([img.width, img.height]);
      p.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
    return new Blob([(await out.save()) as BlobPart], {
      type: 'application/pdf',
    });
  }

  /** Single-image variant of imagesToPdf. */
  async imageToPdf(
    file: Blob & { name?: string },
    _opts?: { imageType?: string }
  ): Promise<Blob> {
    return this.imagesToPdf([file]);
  }

  /** Lay plain text out into a simple multi-page PDF. */
  async textToPdf(text: string, opts?: { fontSize?: number }): Promise<Blob> {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Courier);
    const size = opts?.fontSize ?? 11;
    const margin = 48;
    const [pw, ph] = [595, 842]; // A4 pt
    const maxChars = Math.floor((pw - margin * 2) / (size * 0.6));
    const lineH = size * 1.4;
    const wrapped: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      if (raw.length <= maxChars) {
        wrapped.push(raw);
        continue;
      }
      for (let i = 0; i < raw.length; i += maxChars)
        wrapped.push(raw.slice(i, i + maxChars));
    }
    let page = doc.addPage([pw, ph]);
    let y = ph - margin;
    for (const line of wrapped) {
      if (y < margin) {
        page = doc.addPage([pw, ph]);
        y = ph - margin;
      }
      page.drawText(line, { x: margin, y, size, font });
      y -= lineH;
    }
    return new Blob([(await doc.save()) as BlobPart], {
      type: 'application/pdf',
    });
  }
}

export type { MuDocument, MuPage };
