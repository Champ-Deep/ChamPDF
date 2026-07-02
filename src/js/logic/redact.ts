import { showLoader, hideLoader, showAlert } from '../ui.js';
import { downloadFile } from '../utils/helpers.js';
import { PyMuPDF } from '../utils/mupdf-engine.js';
import { getWasmBaseUrl } from '../config/wasm-cdn-config.js';

/**
 * True redaction — removes the underlying text/images inside each rectangle,
 * not just a black box over them. Uses PyMuPDF (WASM) addRedaction +
 * applyRedactions, which deletes the covered content from the page before
 * saving. Runs entirely in the browser; the file is never uploaded.
 */

interface RedactionInput {
  pageIndex: number; // 0-based
  canvasX: number;
  canvasY: number;
  canvasWidth: number;
  canvasHeight: number;
}

let pymupdf: PyMuPDF | null = null;

async function ensurePyMuPDF(): Promise<PyMuPDF> {
  if (!pymupdf) {
    pymupdf = new PyMuPDF(getWasmBaseUrl('pymupdf'));
    await pymupdf.load();
  }
  return pymupdf;
}

export async function redact(
  source: ArrayBuffer | Uint8Array | Blob,
  redactions: RedactionInput[],
  canvasScale: number
) {
  showLoader('Applying redactions...');
  try {
    const mupdf = await ensurePyMuPDF();
    const blob =
      source instanceof Blob
        ? source
        : new Blob([source as BlobPart], { type: 'application/pdf' });
    const doc = await mupdf.open(blob);

    // Canvas was rendered at `canvasScale`; PDF points = canvas px / scale.
    // PyMuPDF and the rendered canvas share a top-left origin, so no y-flip.
    const toPdf = 1 / canvasScale;

    // Group by page so applyRedactions runs once per page.
    const byPage = new Map<number, RedactionInput[]>();
    for (const r of redactions) {
      const list = byPage.get(r.pageIndex) ?? [];
      list.push(r);
      byPage.set(r.pageIndex, list);
    }

    try {
      for (const [pageIndex, rects] of byPage) {
        const page = doc.getPage(pageIndex);
        for (const r of rects) {
          page.addRedaction(
            {
              x0: r.canvasX * toPdf,
              y0: r.canvasY * toPdf,
              x1: (r.canvasX + r.canvasWidth) * toPdf,
              y1: (r.canvasY + r.canvasHeight) * toPdf,
            },
            undefined,
            { r: 0, g: 0, b: 0 }
          );
        }
        // Removes the covered content, then paints the redaction box.
        page.applyRedactions();
      }

      const out = doc.save({ garbage: 3, deflate: true, clean: true });
      downloadFile(
        new Blob([out as BlobPart], { type: 'application/pdf' }),
        'redacted.pdf'
      );
    } finally {
      doc.close();
    }
  } catch (e) {
    console.error(e);
    showAlert('Error', 'Failed to apply redactions.');
  } finally {
    hideLoader();
  }
}
