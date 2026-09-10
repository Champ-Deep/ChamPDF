// @vitest-environment node
/**
 * PDF → DOCX conversion. Runs in the node environment (not jsdom) because
 * mupdf's WASM loader takes its browser code path when `window` exists and then
 * cannot fetch its own .wasm from a file:// URL.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pdfToDocx, buildDocx, type DocxPage } from '../js/utils/pdf-to-docx';

const { DOMParser } = new JSDOM().window;

/** Parse as XML and fail loudly on anything Word would also reject. */
function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.querySelector('parsererror');
  expect(error?.textContent ?? null).toBeNull();
  return doc as unknown as Document;
}

async function textPdf(): Promise<Blob> {
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const p1 = pdf.addPage([595, 842]);
  p1.drawText('ChamPDF Conversion Report', {
    x: 150,
    y: 780,
    size: 20,
    font: bold,
  });
  p1.drawText('Plain body text with an ampersand & angle < bracket.', {
    x: 40,
    y: 700,
    size: 12,
    font: helv,
    color: rgb(0.2, 0.2, 0.6),
  });

  const p2 = pdf.addPage([595, 842]);
  p2.drawText('Second page paragraph.', {
    x: 40,
    y: 700,
    size: 12,
    font: helv,
  });

  // Copy into a fresh view so TS sees an ArrayBuffer-backed Uint8Array.
  return new Blob([new Uint8Array(await pdf.save())], {
    type: 'application/pdf',
  });
}

/** A page with no text at all — the scanned-document shape. */
async function imageOnlyPdf(): Promise<Blob> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 300]);
  page.drawRectangle({
    x: 20,
    y: 20,
    width: 260,
    height: 260,
    color: rgb(0.9, 0.4, 0.1),
  });
  // Copy into a fresh view so TS sees an ArrayBuffer-backed Uint8Array.
  return new Blob([new Uint8Array(await pdf.save())], {
    type: 'application/pdf',
  });
}

async function unzip(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await blob.arrayBuffer());
}

describe('pdfToDocx', () => {
  it('writes a valid OOXML package carrying the PDF text', async () => {
    const result = await pdfToDocx(await textPdf());
    expect(result.pages).toBe(2);
    expect(result.rasterizedPages).toBe(0);
    expect(result.textPages).toBe(2);

    const zip = await unzip(result.blob);
    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/_rels/document.xml.rels',
    ]) {
      expect(zip.file(part), `missing ${part}`).not.toBeNull();
    }

    const documentXml = await zip.file('word/document.xml')!.async('string');
    parseXml(documentXml);
    parseXml(await zip.file('[Content_Types].xml')!.async('string'));
    parseXml(await zip.file('word/styles.xml')!.async('string'));
    parseXml(await zip.file('word/_rels/document.xml.rels')!.async('string'));

    expect(documentXml).toContain('ChamPDF Conversion Report');
    expect(documentXml).toContain('Second page paragraph.');
    // Special characters must arrive escaped, never raw.
    expect(documentXml).toContain('ampersand &amp; angle &lt; bracket.');
    // One page break between the two pages, and one section at the end.
    expect(documentXml.match(/w:type="page"/g)).toHaveLength(1);
    expect(documentXml).toContain('<w:pgSz w:w="11900" w:h="16840"/>');
  }, 60_000);

  it('keeps font size, weight and colour per run', async () => {
    const result = await pdfToDocx(await textPdf());
    const zip = await unzip(result.blob);
    const documentXml = await zip.file('word/document.xml')!.async('string');

    // 20pt heading → 40 half-points; 12pt body → 24 half-points.
    expect(documentXml).toContain('<w:sz w:val="40"/>');
    expect(documentXml).toContain('<w:sz w:val="24"/>');
    expect(documentXml).toContain('<w:b/>');
    expect(documentXml).toMatch(/<w:color w:val="3333(99|9A)"\/>/);
  }, 60_000);

  it('falls back to a page image when a page has no text layer', async () => {
    const result = await pdfToDocx(await imageOnlyPdf(), { rasterDpi: 72 });
    expect(result.pages).toBe(1);
    expect(result.rasterizedPages).toBe(1);
    expect(result.textPages).toBe(0);

    const zip = await unzip(result.blob);
    const documentXml = await zip.file('word/document.xml')!.async('string');
    parseXml(documentXml);
    expect(documentXml).toContain('<w:drawing>');
    expect(zip.file('word/media/image1.png')).not.toBeNull();
    const rels = await zip
      .file('word/_rels/document.xml.rels')!
      .async('string');
    expect(rels).toContain('Target="media/image1.png"');
  }, 60_000);

  it('reports progress once per page', async () => {
    const seen: number[] = [];
    await pdfToDocx(await textPdf(), {
      onProgress: ({ page, totalPages }) => {
        expect(totalPages).toBe(2);
        seen.push(page);
      },
    });
    expect(seen).toEqual([1, 2]);
  }, 60_000);
});

// Characters XML 1.0 rejects, spelled with escapes so this file stays ASCII.
const NUL_ISH = '\u0000\u001F\uFFFF';

describe('buildDocx', () => {
  const page = (blocks: DocxPage['blocks']): DocxPage => ({
    widthPt: 612,
    heightPt: 792,
    blocks,
  });
  const run = (text: string) => ({
    text,
    size: 11,
    bold: false,
    italic: false,
    font: 'Calibri',
    color: '000000',
  });

  it('emits a paragraph per text block and a break between pages', async () => {
    const blob = await buildDocx([
      page([
        { kind: 'text', paragraph: { runs: [run('one')] } },
        { kind: 'text', paragraph: { runs: [run('two')], align: 'center' } },
      ]),
      page([{ kind: 'text', paragraph: { runs: [run('three')] } }]),
    ]);
    const xml = await (await unzip(blob))
      .file('word/document.xml')!
      .async('string');
    parseXml(xml);
    expect(xml.match(/<w:p>/g)).toHaveLength(4); // 3 paragraphs + 1 page break
    expect(xml).toContain('<w:jc w:val="center"/>');
    // Letter page size in twips.
    expect(xml).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
  });

  it('declares the png content type only when images are present', async () => {
    const withoutImages = await unzip(
      await buildDocx([
        page([{ kind: 'text', paragraph: { runs: [run('x')] } }]),
      ])
    );
    expect(
      await withoutImages.file('[Content_Types].xml')!.async('string')
    ).not.toContain('image/png');

    const withImages = await unzip(
      await buildDocx([
        page([
          {
            kind: 'image',
            image: {
              data: new Uint8Array([1, 2, 3]),
              widthPt: 100,
              heightPt: 50,
            },
          },
        ]),
      ])
    );
    expect(
      await withImages.file('[Content_Types].xml')!.async('string')
    ).toContain('image/png');
  });

  it('never emits a raw control character into the XML', async () => {
    const blob = await buildDocx([
      page([
        {
          kind: 'text',
          paragraph: { runs: [run(['a', 'b', 'c', 'd'].join(NUL_ISH))] },
        },
      ]),
    ]);
    const xml = await (await unzip(blob))
      .file('word/document.xml')!
      .async('string');
    parseXml(xml);
    expect(xml).toContain('>abcd<');
  });
});
