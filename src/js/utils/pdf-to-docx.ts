/**
 * pdf-to-docx — client-side PDF → Word (.docx).
 *
 * Why this is hand-written instead of routed through LibreOffice-wasm:
 * LibreOffice imports a PDF into *Draw*, and Draw has no word-processing export
 * filter, so `convert({ inputFormat: 'pdf', outputFormat: 'docx' })` is rejected
 * before the engine even touches the file ("PDF files are imported as Draw
 * documents and cannot be exported to Office formats") — that path could never
 * produce a document.
 *
 * So this reads the PDF's own text layout with MuPDF's structured-text device
 * (the engine already shipped for every other text tool) and writes
 * WordprocessingML with JSZip: one paragraph per text block, runs split whenever
 * font/size/weight/colour changes, a page break between pages, and embedded
 * images in document order. A page with no text layer (a scan) is inserted as a
 * rendered image so the output is never silently blank — the caller can then
 * point the user at OCR.
 *
 * Known limits, inherent to text-flow output: vector artwork (charts, rules,
 * shapes drawn as paths) is not carried over, and multi-column layouts reflow
 * into single-column paragraph order. Use PDF → Images if the goal is a pixel-
 * faithful copy rather than editable text.
 */

import JSZip from 'jszip';

type Mupdf = typeof import('mupdf');

/** A styled span of text inside a paragraph. */
export interface DocxRun {
  text: string;
  /** Font size in points. */
  size: number;
  bold: boolean;
  italic: boolean;
  /** Word font name (already mapped from the PDF's base font). */
  font: string;
  /** Hex RRGGBB, no leading '#'. */
  color: string;
}

export interface DocxParagraph {
  runs: DocxRun[];
  align?: 'left' | 'center' | 'right';
}

export interface DocxImage {
  data: Uint8Array;
  /** Rendered size in points (PDF user space == points). */
  widthPt: number;
  heightPt: number;
}

export type DocxBlock =
  | { kind: 'text'; paragraph: DocxParagraph }
  | { kind: 'image'; image: DocxImage };

export interface DocxPage {
  widthPt: number;
  heightPt: number;
  blocks: DocxBlock[];
  /** True when the page had no extractable text and was rasterized instead. */
  rasterized?: boolean;
}

export interface PdfToDocxOptions {
  /** Embed the PDF's images in the DOCX (default true). */
  includeImages?: boolean;
  /** Insert a rendered page image for pages with no text layer (default true). */
  rasterizeTextlessPages?: boolean;
  /** DPI used when rasterizing a textless page (default 150). */
  rasterDpi?: number;
  onProgress?: (progress: { page: number; totalPages: number }) => void;
}

export interface PdfToDocxResult {
  blob: Blob;
  pages: number;
  /** Pages that yielded real text. */
  textPages: number;
  /** Pages with no text layer, inserted as images. */
  rasterizedPages: number;
}

// ---------------------------------------------------------------------------
// Extraction (MuPDF structured text → DocxPage[])
// ---------------------------------------------------------------------------

interface FontInfo {
  name: string;
  bold: boolean;
  italic: boolean;
}

/** Strip a subset prefix ("ABCDEF+Foo") and style suffixes off a PDF font name. */
function baseFontName(raw: string): string {
  const name = raw.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0];
  return name.replace(/(MT|PS|Std|Pro)$/i, '') || name;
}

/** Map a PDF base font onto a font name Word actually ships. */
function wordFontName(raw: string, serif: boolean, mono: boolean): string {
  const base = baseFontName(raw).toLowerCase();
  if (mono || base.includes('courier') || base.includes('mono'))
    return 'Courier New';
  if (base.includes('times') || base.includes('roman'))
    return 'Times New Roman';
  if (base.includes('helvetica') || base.includes('arial')) return 'Arial';
  if (base.includes('georgia')) return 'Georgia';
  if (base.includes('garamond')) return 'Garamond';
  if (base.includes('cambria')) return 'Cambria';
  if (base.includes('calibri')) return 'Calibri';
  if (base.includes('verdana')) return 'Verdana';
  if (base.includes('tahoma')) return 'Tahoma';
  if (base.includes('symbol') || base.includes('dingbat')) return 'Symbol';
  // Unknown face: keep the PDF's own name (Word substitutes a metric-compatible
  // one) but fall back to a generic when the name is unusable.
  const cleaned = baseFontName(raw);
  if (/^[\w .-]{2,40}$/.test(cleaned)) return cleaned;
  return serif ? 'Times New Roman' : 'Arial';
}

function fontInfo(font: any, cache: Map<number, FontInfo>): FontInfo {
  const key = font.pointer as number;
  const hit = cache.get(key);
  if (hit) return hit;
  const raw = font.getName?.() || 'Helvetica';
  const info: FontInfo = {
    name: wordFontName(raw, !!font.isSerif?.(), !!font.isMono?.()),
    bold: !!font.isBold?.() || /bold|black|heavy|semibold|demibold/i.test(raw),
    italic: !!font.isItalic?.() || /italic|oblique/i.test(raw),
  };
  cache.set(key, info);
  return info;
}

/** MuPDF hands colours back as 0..1 RGB; Word wants hex RRGGBB. */
function toHex(color: number[] | undefined): string {
  if (!color || color.length < 3) return '000000';
  return color
    .slice(0, 3)
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c * 255)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
    .toUpperCase();
}

interface WipRun extends DocxRun {
  /** Style fingerprint — adjacent chars sharing it merge into one run. */
  key: string;
}
interface WipLine {
  runs: WipRun[];
  x0: number;
  x1: number;
}

/** Join a block's lines into one paragraph, de-hyphenating across line ends. */
export function linesToParagraph(
  lines: WipLine[],
  pageWidthPt: number
): DocxParagraph | null {
  const runs: WipRun[] = [];
  for (const line of lines) {
    const lineRuns = line.runs.filter((r) => r.text.length > 0);
    if (lineRuns.length === 0) continue;
    if (runs.length > 0) {
      const prev = runs[runs.length - 1];
      if (/[\p{Ll}\p{Lu}]-$/u.test(prev.text))
        prev.text = prev.text.slice(0, -1);
      else if (!/\s$/.test(prev.text)) prev.text += ' ';
    }
    for (const run of lineRuns) {
      const prev = runs[runs.length - 1];
      if (prev && prev.key === run.key) prev.text += run.text;
      else runs.push({ ...run });
    }
  }
  if (runs.length === 0) return null;
  if (!runs.some((r) => r.text.trim())) return null;

  // Centring is only inferred for a single short line (a heading or caption);
  // guessing it for a wrapped paragraph would wreck the layout.
  let align: DocxParagraph['align'] | undefined;
  if (lines.length === 1) {
    const leftGap = lines[0].x0;
    const rightGap = pageWidthPt - lines[0].x1;
    const width = lines[0].x1 - lines[0].x0;
    if (
      width < pageWidthPt * 0.8 &&
      leftGap > 36 &&
      Math.abs(leftGap - rightGap) < Math.max(12, pageWidthPt * 0.03)
    ) {
      align = 'center';
    } else if (leftGap > pageWidthPt * 0.5 && rightGap < 48) {
      align = 'right';
    }
  }
  return align ? { runs, align } : { runs };
}

/** Read one page's text blocks and images, in document order. */
function extractPage(
  page: any,
  opts: { includeImages: boolean },
  fontCache: Map<number, FontInfo>
): { blocks: DocxBlock[]; hasText: boolean } {
  const [px0, , px1] = page.getBounds();
  const pageWidthPt = px1 - px0;
  const blocks: DocxBlock[] = [];
  let hasText = false;

  const stext = page.toStructuredText(
    opts.includeImages
      ? 'preserve-whitespace,preserve-images'
      : 'preserve-whitespace'
  );
  try {
    let lines: WipLine[] = [];
    let line: WipLine | null = null;

    stext.walk({
      beginTextBlock: () => {
        lines = [];
        line = null;
      },
      beginLine: (bbox: number[]) => {
        line = { runs: [], x0: bbox[0] - px0, x1: bbox[2] - px0 };
      },
      onChar: (
        c: string,
        _origin: unknown,
        font: any,
        size: number,
        _quad: unknown,
        color: number[]
      ) => {
        if (!line) return;
        const info = fontInfo(font, fontCache);
        const hex = toHex(color);
        const rounded = Math.round(size * 2) / 2;
        const key = `${info.name}|${rounded}|${info.bold}|${info.italic}|${hex}`;
        const prev = line.runs[line.runs.length - 1];
        if (prev && prev.key === key) {
          prev.text += c;
          return;
        }
        line.runs.push({
          key,
          text: c,
          size: rounded,
          bold: info.bold,
          italic: info.italic,
          font: info.name,
          color: hex,
        });
      },
      endLine: () => {
        if (line) lines.push(line);
        line = null;
      },
      endTextBlock: () => {
        const paragraph = linesToParagraph(lines, pageWidthPt);
        lines = [];
        if (paragraph) {
          hasText = true;
          blocks.push({ kind: 'text', paragraph });
        }
      },
      onImageBlock: (bbox: number[], _transform: unknown, image: any) => {
        if (!opts.includeImages) return;
        try {
          const pix = image.toPixmap();
          const png = pix.asPNG();
          pix.destroy?.();
          blocks.push({
            kind: 'image',
            image: {
              data: png,
              widthPt: Math.max(1, bbox[2] - bbox[0]),
              heightPt: Math.max(1, bbox[3] - bbox[1]),
            },
          });
        } catch {
          /* undecodable image — skip it rather than fail the conversion */
        }
      },
    });
  } finally {
    stext.destroy?.();
  }

  return { blocks, hasText };
}

/** Render a whole page to PNG — the fallback for pages with no text layer. */
function rasterizePage(m: Mupdf, page: any, dpi: number): DocxImage {
  const scale = dpi / 72;
  const pix = page.toPixmap(
    m.Matrix.scale(scale, scale),
    m.ColorSpace.DeviceRGB,
    false
  );
  const png = pix.asPNG();
  pix.destroy?.();
  const [x0, y0, x1, y1] = page.getBounds();
  return { data: png, widthPt: x1 - x0, heightPt: y1 - y0 };
}

// ---------------------------------------------------------------------------
// WordprocessingML writer
// ---------------------------------------------------------------------------

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WP_NS =
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

/** Points → twentieths of a point (Word's page/margin unit). */
const twips = (pt: number) => Math.round(pt * 20);
/** Points → half-points (Word's font size unit). */
const halfPoints = (pt: number) => Math.max(2, Math.round(pt * 2));
/** Points → English Metric Units (DrawingML's unit). */
const emu = (pt: number) => Math.round(pt * 12700);

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Drop the characters XML 1.0 forbids; PDFs routinely carry stray control
 * codes that would make Word refuse to open the document. Built via RegExp so
 * the escapes stay escapes and no raw control byte lands in this source file.
 */
const XML_FORBIDDEN = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]',
  'g'
);

function sanitizeText(s: string): string {
  return s.replace(XML_FORBIDDEN, '');
}

function runXml(run: DocxRun): string {
  const font = xmlEscape(run.font);
  const sz = halfPoints(run.size);
  const props =
    `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>` +
    (run.bold ? '<w:b/>' : '') +
    (run.italic ? '<w:i/>' : '') +
    `<w:color w:val="${run.color}"/>` +
    `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`;
  const text = xmlEscape(sanitizeText(run.text));
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
}

function paragraphXml(paragraph: DocxParagraph): string {
  const pPr = paragraph.align
    ? `<w:pPr><w:jc w:val="${paragraph.align}"/></w:pPr>`
    : '';
  return `<w:p>${pPr}${paragraph.runs.map(runXml).join('')}</w:p>`;
}

function imageParagraphXml(
  image: DocxImage,
  id: number,
  relId: string,
  maxWidthPt: number
): string {
  // Scale anything wider than the text column down so Word does not clip it.
  const scale = image.widthPt > maxWidthPt ? maxWidthPt / image.widthPt : 1;
  const cx = emu(image.widthPt * scale);
  const cy = emu(image.heightPt * scale);
  return (
    '<w:p><w:r><w:drawing>' +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${id}" name="Picture ${id}"/>` +
    `<a:graphic><a:graphicData uri="${PIC_NS}"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  );
}

const PAGE_BREAK_XML = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr>` +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="240" w:lineRule="auto"/>' +
  '</w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
  '<w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>';

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  `<Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/>` +
  '</Relationships>';

function contentTypesXml(hasImages: boolean): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    (hasImages ? '<Default Extension="png" ContentType="image/png"/>' : '') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>'
  );
}

/** Build a .docx package from already-extracted pages. Pure — no MuPDF needed. */
export async function buildDocx(pages: DocxPage[]): Promise<Blob> {
  const zip = new JSZip();
  const media: { name: string; data: Uint8Array }[] = [];
  const body: string[] = [];
  const marginPt = 36; // 0.5in — PDFs carry their own margins inside the layout
  const pageWidthPt = pages[0]?.widthPt || 595;
  const pageHeightPt = pages[0]?.heightPt || 842;

  let imageId = 1;
  pages.forEach((page, index) => {
    if (index > 0) body.push(PAGE_BREAK_XML);
    for (const block of page.blocks) {
      if (block.kind === 'text') {
        body.push(paragraphXml(block.paragraph));
        continue;
      }
      const name = `image${imageId}.png`;
      media.push({ name, data: block.image.data });
      body.push(
        imageParagraphXml(
          block.image,
          imageId,
          // rId1 is styles.xml, so image N takes rId(N+1).
          `rId${imageId + 1}`,
          Math.max(72, (page.widthPt || pageWidthPt) - marginPt * 2)
        )
      );
      imageId++;
    }
    if (page.blocks.length === 0) body.push('<w:p/>');
  });

  const sectPr =
    '<w:sectPr>' +
    `<w:pgSz w:w="${twips(pageWidthPt)}" w:h="${twips(pageHeightPt)}"/>` +
    `<w:pgMar w:top="${twips(marginPt)}" w:right="${twips(marginPt)}" ` +
    `w:bottom="${twips(marginPt)}" w:left="${twips(marginPt)}" ` +
    'w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" ` +
    `xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}">` +
    `<w:body>${body.join('')}${sectPr}</w:body></w:document>`;

  const rels =
    `<Relationship Id="rId1" Type="${R_NS}/styles" Target="styles.xml"/>` +
    media
      .map(
        (item, i) =>
          `<Relationship Id="rId${i + 2}" Type="${R_NS}/image" Target="media/${item.name}"/>`
      )
      .join('');

  zip.file('[Content_Types].xml', contentTypesXml(media.length > 0));
  zip.file('_rels/.rels', ROOT_RELS_XML);
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', STYLES_XML);
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels +
      '</Relationships>'
  );
  for (const item of media) zip.file(`word/media/${item.name}`, item.data);

  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

/** Read a PDF's text/images with MuPDF, one DocxPage per PDF page. */
export async function extractDocxPages(
  file: Blob | ArrayBuffer | Uint8Array,
  opts: PdfToDocxOptions = {}
): Promise<DocxPage[]> {
  const m = await import('mupdf');
  const bytes =
    file instanceof Uint8Array
      ? file
      : new Uint8Array(
          file instanceof ArrayBuffer ? file : await file.arrayBuffer()
        );
  const includeImages = opts.includeImages !== false;
  const rasterize = opts.rasterizeTextlessPages !== false;
  const dpi = opts.rasterDpi ?? 150;

  const doc = m.Document.openDocument(bytes, 'application/pdf');
  const fontCache = new Map<number, FontInfo>();
  const pages: DocxPage[] = [];
  const total = doc.countPages();

  try {
    for (let i = 0; i < total; i++) {
      opts.onProgress?.({ page: i + 1, totalPages: total });
      const page = doc.loadPage(i);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        const { blocks, hasText } = extractPage(
          page,
          { includeImages },
          fontCache
        );
        const docxPage: DocxPage = {
          widthPt: x1 - x0,
          heightPt: y1 - y0,
          blocks,
        };
        if (!hasText && rasterize) {
          docxPage.blocks = [
            { kind: 'image', image: rasterizePage(m, page, dpi) },
          ];
          docxPage.rasterized = true;
        }
        pages.push(docxPage);
      } finally {
        page.destroy?.();
      }
    }
  } finally {
    doc.destroy?.();
  }
  return pages;
}

/** Convert a PDF to a Word document entirely in the browser. */
export async function pdfToDocx(
  file: Blob,
  opts: PdfToDocxOptions = {}
): Promise<PdfToDocxResult> {
  const pages = await extractDocxPages(file, opts);
  if (pages.length === 0) throw new Error('The PDF has no pages to convert.');
  const blob = await buildDocx(pages);
  const rasterizedPages = pages.filter((p) => p.rasterized).length;
  return {
    blob,
    pages: pages.length,
    textPages: pages.length - rasterizedPages,
    rasterizedPages,
  };
}
