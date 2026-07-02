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
 * tool migrates by only changing its import. mupdf is lazy-imported: the ~10MB
 * wasm is fetched the first time a tool actually calls load()/open(), never at
 * page load.
 *
 * Table detection (findTables) is intentionally NOT here — MuPDF core has no
 * table finder (it was a PyMuPDF Python-layer feature). Those tools call the
 * backend /api/extract-tables (server-side PyMuPDF) instead.
 */

// mupdf ships ESM with top-level await; import() it lazily.
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

function toBytes(
  src: Blob | ArrayBuffer | Uint8Array
): Promise<Uint8Array> | Uint8Array {
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  return src.arrayBuffer().then((b) => new Uint8Array(b));
}

function saveOptsToString(o?: SaveOptions): string {
  const parts: string[] = [];
  parts.push(`garbage=${o?.garbage ?? 3}`);
  if (o?.deflate !== false) parts.push('compress=yes');
  if (o?.clean) parts.push('sanitize=yes');
  return parts.join(',');
}

class MuPage {
  constructor(
    private m: Mupdf,
    /** underlying mupdf PDFPage */
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

  /** text | json — matches the formats the tools request. */
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

  /** Render at `scale` (1 = 72dpi) to PNG bytes. */
  toPNG(scale = 2): Uint8Array {
    const pix = this._page.toPixmap(
      this.m.Matrix.scale(scale, scale),
      this.m.ColorSpace.DeviceRGB,
      false
    );
    const png = pix.asPNG();
    pix.destroy?.();
    return png;
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
    /** underlying mupdf PDFDocument */
    public readonly _doc: any
  ) {}

  getPageCount(): number {
    return this._doc.countPages();
  }

  getPage(index: number): MuPage {
    return new MuPage(this.m, this._doc.loadPage(index));
  }

  save(options?: SaveOptions): Uint8Array {
    const buf = this._doc.saveToBuffer(saveOptsToString(options));
    return buf.asUint8Array();
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
  // baseUrl is accepted for API compatibility but unused: mupdf.js locates its
  // own wasm through the bundler, so there is no manual asset path to get wrong.
  constructor(_baseUrl?: string) {}

  async load(): Promise<void> {
    await loadMupdf();
  }

  /** Open a PDF for reading/editing. */
  async open(src: Blob | ArrayBuffer | Uint8Array): Promise<MuDocument> {
    const m = await loadMupdf();
    const bytes = await toBytes(src);
    const doc = m.PDFDocument.openDocument(bytes, 'application/pdf');
    return new MuDocument(m, doc);
  }

  /** Extract all text from a PDF as plain text. */
  async pdfToText(file: Blob): Promise<string> {
    const doc = await this.open(file);
    try {
      const out: string[] = [];
      const n = doc.getPageCount();
      for (let i = 0; i < n; i++) out.push(doc.getPage(i).getText('text'));
      return out.join('\n');
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

  /**
   * Open ANY MuPDF-supported format (epub, xps, cbz, fb2, mobi, svg, images…)
   * and write it out as a PDF. `filename` drives format auto-detection.
   */
  async convertToPdf(src: Blob & { name?: string }): Promise<Uint8Array> {
    const m = await loadMupdf();
    const bytes = await toBytes(src);
    const magic = (src as any).name || 'document';
    const doc = m.Document.openDocument(bytes, magic);
    const buf = new m.Buffer();
    const writer = new m.DocumentWriter(buf, 'pdf', '');
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      const dev = writer.beginPage(page.getBounds());
      page.run(dev, m.Matrix.identity);
      writer.endPage();
      dev.destroy?.();
      page.destroy?.();
    }
    writer.close();
    return buf.asUint8Array();
  }
}

export type { MuDocument, MuPage };
