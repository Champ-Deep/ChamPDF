/**
 * ChamPDF MCP — document workflow tools.
 *
 * Wraps the /api/v1 document surface (merge, split, rotate, compress,
 * watermark, sign, verify, OCR, tables, Office <-> PDF conversion) as MCP
 * tools. Registered by registerAllTools() in tools.ts so both the stdio
 * and HTTP entries expose them.
 *
 * All file parameters are absolute paths on the machine running the MCP
 * server. RBAC note: the backend enforces per-key scopes (pdf.read /
 * pdf.write / pdf.sign / convert) — a scoped key returns a 403 with
 * code "insufficient_scope", which surfaces in the tool error text.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

import { callApi, downloadToPath, ok, fail } from './tools.js';

async function appendFileField(
  form: FormData,
  field: string,
  path: string,
  fallbackName: string
): Promise<void> {
  const data = await readFile(resolve(path));
  form.append(
    field,
    new Blob([new Uint8Array(data)]),
    basename(path) || fallbackName
  );
}

const pagesSpec = z
  .string()
  .default('all')
  .describe(
    "1-based page spec: 'all', '2', '1-3,7', '5-' (to end), '-3' (from start). Order is preserved."
  );

export function registerDocumentTools(server: McpServer): void {
  // ---- capabilities ------------------------------------------------------

  server.registerTool(
    'champdf_capabilities',
    {
      title: 'ChamPDF — Server Capabilities',
      description:
        'Report which optional features are enabled on the connected ChamPDF backend (signing, OCR, Office conversion, PDF-to-DOCX, table extraction, Gemini image tools). Call this before relying on an optional tool.',
      inputSchema: {},
    },
    async () => {
      try {
        const res = await callApi('/api/v1/capabilities');
        return ok(JSON.stringify(await res.json(), null, 2));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- merge / split / organize -----------------------------------------

  server.registerTool(
    'champdf_merge_pdfs',
    {
      title: 'ChamPDF — Merge PDFs',
      description:
        'Merge two or more PDFs into one, in the order given. Use for assembling contract packets, combining reports, etc.',
      inputSchema: {
        input_paths: z
          .array(z.string())
          .min(2)
          .describe('Absolute paths of the PDFs to merge, in order.'),
        output_path: z.string().describe('Absolute path for the merged PDF.'),
      },
    },
    async ({ input_paths, output_path }) => {
      try {
        const form = new FormData();
        for (const p of input_paths) {
          await appendFileField(form, 'files', p, 'input.pdf');
        }
        const res = await callApi('/api/v1/pdf/merge', {
          method: 'POST',
          multipart: form,
        });
        const { bytes } = await downloadToPath(res, resolve(output_path));
        return ok(
          `Merged ${input_paths.length} PDFs into ${output_path} (${bytes.toLocaleString()} bytes).`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'champdf_split_pdf',
    {
      title: 'ChamPDF — Split / Extract PDF Pages',
      description:
        "Extract a page range into a new PDF. Keeps only the pages in `pages` — since order is preserved, this also reorders (e.g. '3,1,2'). Use champdf_delete_pdf_pages for the inverse.",
      inputSchema: {
        input_path: z.string().describe('Absolute path to the source PDF.'),
        pages: z.string().describe("Pages to keep, e.g. '1-3,7' or '2-'."),
        output_path: z.string().describe('Absolute path for the result PDF.'),
      },
    },
    async ({ input_path, pages, output_path }) => {
      try {
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'input.pdf');
        form.append('pages', pages);
        const res = await callApi('/api/v1/pdf/split', {
          method: 'POST',
          multipart: form,
        });
        const { bytes } = await downloadToPath(res, resolve(output_path));
        return ok(
          `Extracted pages ${pages} from ${input_path} into ${output_path} (${bytes.toLocaleString()} bytes).`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'champdf_delete_pdf_pages',
    {
      title: 'ChamPDF — Delete PDF Pages',
      description: 'Remove specific pages from a PDF.',
      inputSchema: {
        input_path: z.string().describe('Absolute path to the source PDF.'),
        pages: z.string().describe("Pages to remove, e.g. '2,5-6'."),
        output_path: z.string().describe('Absolute path for the result PDF.'),
      },
    },
    async ({ input_path, pages, output_path }) => {
      try {
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'input.pdf');
        form.append('pages', pages);
        const res = await callApi('/api/v1/pdf/delete-pages', {
          method: 'POST',
          multipart: form,
        });
        const { bytes } = await downloadToPath(res, resolve(output_path));
        return ok(
          `Deleted pages ${pages} from ${input_path}; wrote ${output_path} (${bytes.toLocaleString()} bytes).`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'champdf_rotate_pdf',
    {
      title: 'ChamPDF — Rotate PDF Pages',
      description: 'Rotate pages clockwise by 90, 180, or 270 degrees.',
      inputSchema: {
        input_path: z.string().describe('Absolute path to the source PDF.'),
        angle: z
          .number()
          .int()
          .refine(
            (a) => [90, 180, 270].includes(a),
            'angle must be 90, 180, or 270'
          )
          .describe('Clockwise rotation in degrees: 90, 180, or 270.'),
        pages: pagesSpec,
        output_path: z.string().describe('Absolute path for the result PDF.'),
      },
    },
    async ({ input_path, angle, pages, output_path }) => {
      try {
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'input.pdf');
        form.append('angle', String(angle));
        form.append('pages', pages);
        const res = await callApi('/api/v1/pdf/rotate', {
          method: 'POST',
          multipart: form,
        });
        const { bytes } = await downloadToPath(res, resolve(output_path));
        return ok(
          `Rotated pages ${pages} of ${input_path} by ${angle}°; wrote ${output_path} (${bytes.toLocaleString()} bytes).`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'champdf_compress_pdf',
    {
      title: 'ChamPDF — Compress PDF',
      description:
        'Shrink a PDF: structural clean-up plus embedded-image downsampling. The result is never larger than the input.',
      inputSchema: {
        input_path: z.string().describe('Absolute path to the source PDF.'),
        output_path: z
          .string()
          .describe('Absolute path for the compressed PDF.'),
        image_dpi: z
          .number()
          .int()
          .min(50)
          .max(300)
          .default(150)
          .describe('Target DPI for embedded images (lower = smaller file).'),
        image_quality: z
          .number()
          .int()
          .min(10)
          .max(95)
          .default(70)
          .describe('JPEG quality for recompressed images.'),
      },
    },
    async ({ input_path, output_path, image_dpi, image_quality }) => {
      try {
        const inputSize = (await readFile(resolve(input_path))).byteLength;
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'input.pdf');
        form.append('image_dpi', String(image_dpi));
        form.append('image_quality', String(image_quality));
        const res = await callApi('/api/v1/pdf/compress', {
          method: 'POST',
          multipart: form,
        });
        const { bytes } = await downloadToPath(res, resolve(output_path));
        const saved =
          inputSize > 0 ? Math.round((1 - bytes / inputSize) * 100) : 0;
        return ok(
          `Compressed ${input_path}: ${inputSize.toLocaleString()} → ${bytes.toLocaleString()} bytes (${saved}% smaller). Wrote ${output_path}.`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'champdf_watermark_pdf',
    {
      title: 'ChamPDF — Watermark PDF',
      description:
        "Stamp a diagonal text watermark (e.g. 'CONFIDENTIAL', 'DRAFT', 'APPROVED') across PDF pages.",
      inputSchema: {
        input_path: z.string().describe('Absolute path to the source PDF.'),
        text: z.string().min(1).max(200).describe('Watermark text.'),
        output_path: z.string().describe('Absolute path for the result PDF.'),
        opacity: z.number().min(0.02).max(1).default(0.15),
        font_size: z.number().int().min(8).max(144).default(48),
        color: z
          .string()
          .regex(/^[0-9a-fA-F]{6}$/)
          .default('888888')
          .describe("6-digit hex color without '#'."),
        angle: z.number().int().min(-90).max(90).default(45),
        pages: pagesSpec,
      },
    },
    async ({
      input_path,
      text,
      output_path,
      opacity,
      font_size,
      color,
      angle,
      pages,
    }) => {
      try {
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'input.pdf');
        form.append('text', text);
        form.append('opacity', String(opacity));
        form.append('font_size', String(font_size));
        form.append('color', color);
        form.append('angle', String(angle));
        form.append('pages', pages);
        const res = await callApi('/api/v1/pdf/watermark', {
          method: 'POST',
          multipart: form,
        });
        const { bytes } = await downloadToPath(res, resolve(output_path));
        return ok(
          `Stamped "${text}" on pages ${pages} of ${input_path}; wrote ${output_path} (${bytes.toLocaleString()} bytes).`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- inspect / extract -------------------------------------------------

  server.registerTool(
    'champdf_pdf_info',
    {
      title: 'ChamPDF — Inspect PDF',
      description:
        'Get PDF metadata as JSON: page count, encryption status, document metadata, first-page size, outline entries.',
      inputSchema: {
        input_path: z.string().describe('Absolute path to the PDF.'),
      },
    },
    async ({ input_path }) => {
      try {
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'input.pdf');
        const res = await callApi('/api/v1/pdf/info', {
          method: 'POST',
          multipart: form,
        });
        return ok(JSON.stringify(await res.json(), null, 2));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'champdf_pdf_to_text',
    {
      title: 'ChamPDF — Extract PDF Text',
      description:
        'Extract the text of a PDF, per page. Returns the text inline — no output file. For scanned PDFs with no text layer, run champdf_ocr_pdf first.',
      inputSchema: {
        input_path: z.string().describe('Absolute path to the PDF.'),
        pages: pagesSpec,
      },
    },
    async ({ input_path, pages }) => {
      try {
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'input.pdf');
        form.append('pages', pages);
        const res = await callApi('/api/v1/pdf/to-text', {
          method: 'POST',
          multipart: form,
        });
        const body = (await res.json()) as {
          pages: Array<{ page: number; text: string }>;
        };
        const text = body.pages
          .map((p) => `--- page ${p.page} ---\n${p.text.trim()}`)
          .join('\n\n');
        return ok(text || '(no text found)');
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'champdf_pdf_to_images',
    {
      title: 'ChamPDF — Rasterize PDF to Images',
      description:
        'Render PDF pages as PNG or JPEG images. The result is a ZIP file (one image per page) written to output_path.',
      inputSchema: {
        input_path: z.string().describe('Absolute path to the PDF.'),
        output_path: z
          .string()
          .describe(
            'Absolute path for the resulting ZIP of page images (use a .zip extension).'
          ),
        pages: pagesSpec,
        dpi: z.number().int().min(30).max(600).default(150),
        format: z.enum(['png', 'jpeg']).default('png'),
      },
    },
    async ({ input_path, output_path, pages, dpi, format }) => {
      try {
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'input.pdf');
        form.append('pages', pages);
        form.append('dpi', String(dpi));
        form.append('format', format);
        const res = await callApi('/api/v1/pdf/to-images', {
          method: 'POST',
          multipart: form,
        });
        const pageCount = res.headers.get('x-page-count') ?? '?';
        const { bytes } = await downloadToPath(res, resolve(output_path));
        return ok(
          `Rendered ${pageCount} page(s) of ${input_path} at ${dpi} DPI as ${format.toUpperCase()}. Wrote ZIP to ${output_path} (${bytes.toLocaleString()} bytes).`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'champdf_images_to_pdf',
    {
      title: 'ChamPDF — Combine Images into a PDF',
      description:
        'Build a PDF from PNG/JPEG images, one page per image, in order.',
      inputSchema: {
        input_paths: z
          .array(z.string())
          .min(1)
          .describe('Absolute paths of the images, in page order.'),
        output_path: z
          .string()
          .describe('Absolute path for the resulting PDF.'),
      },
    },
    async ({ input_paths, output_path }) => {
      try {
        const form = new FormData();
        for (const p of input_paths) {
          await appendFileField(form, 'files', p, 'image');
        }
        const res = await callApi('/api/v1/pdf/from-images', {
          method: 'POST',
          multipart: form,
        });
        const { bytes } = await downloadToPath(res, resolve(output_path));
        return ok(
          `Combined ${input_paths.length} image(s) into ${output_path} (${bytes.toLocaleString()} bytes).`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'champdf_extract_pdf_tables',
    {
      title: 'ChamPDF — Extract Tables from PDF',
      description:
        'Detect and extract tables from a PDF. Returns JSON with rows plus a markdown rendering of each table — ideal for pushing tabular data into CRMs or spreadsheets.',
      inputSchema: {
        input_path: z.string().describe('Absolute path to the PDF.'),
      },
    },
    async ({ input_path }) => {
      try {
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'input.pdf');
        const res = await callApi('/api/v1/pdf/extract-tables', {
          method: 'POST',
          multipart: form,
        });
        const body = (await res.json()) as {
          tables: Array<Record<string, unknown>>;
        };
        if (body.tables.length === 0) return ok('No tables found.');
        return ok(JSON.stringify(body, null, 2));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- signing -----------------------------------------------------------

  server.registerTool(
    'champdf_sign_pdf',
    {
      title: 'ChamPDF — Digitally Sign PDF (PAdES)',
      description:
        'Apply a compliance-grade digital signature to a PDF using a .p12/.pfx certificate (pyHanko, PAdES). With timestamp=true a trusted timestamp is added (PAdES B-T). This is cryptographic signing for legal/enterprise workflows — not a drawn signature image.',
      inputSchema: {
        input_path: z.string().describe('Absolute path to the PDF to sign.'),
        cert_path: z
          .string()
          .describe(
            "Absolute path to the signer's .p12/.pfx certificate file."
          ),
        passphrase: z.string().default('').describe('Certificate password.'),
        output_path: z.string().describe('Absolute path for the signed PDF.'),
        reason: z
          .string()
          .max(200)
          .optional()
          .describe("Signing reason, e.g. 'Approved by Finance'."),
        location: z
          .string()
          .max(200)
          .optional()
          .describe("Signing location, e.g. 'Bangalore, IN'."),
        field_name: z.string().max(100).default('Signature1'),
        timestamp: z
          .boolean()
          .default(true)
          .describe(
            'Add a trusted timestamp from the configured TSA (needs outbound network).'
          ),
      },
    },
    async ({
      input_path,
      cert_path,
      passphrase,
      output_path,
      reason,
      location,
      field_name,
      timestamp,
    }) => {
      try {
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'input.pdf');
        await appendFileField(form, 'cert', cert_path, 'signer.p12');
        form.append('passphrase', passphrase);
        if (reason) form.append('reason', reason);
        if (location) form.append('location', location);
        form.append('field_name', field_name);
        form.append('timestamp', String(timestamp));
        const res = await callApi('/api/v1/pdf/sign', {
          method: 'POST',
          multipart: form,
        });
        const { bytes } = await downloadToPath(res, resolve(output_path));
        return ok(
          `Signed ${input_path} (field "${field_name}"${reason ? `, reason: ${reason}` : ''}${
            timestamp ? ', with trusted timestamp' : ''
          }). Wrote ${output_path} (${bytes.toLocaleString()} bytes).`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'champdf_verify_pdf_signature',
    {
      title: 'ChamPDF — Verify PDF Signatures',
      description:
        'Verify the digital signatures in a PDF. Returns a JSON report: integrity, signer identity, signing time, timestamp validity.',
      inputSchema: {
        input_path: z.string().describe('Absolute path to the signed PDF.'),
      },
    },
    async ({ input_path }) => {
      try {
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'input.pdf');
        const res = await callApi('/api/v1/pdf/verify-signature', {
          method: 'POST',
          multipart: form,
        });
        return ok(JSON.stringify(await res.json(), null, 2));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- OCR + conversion --------------------------------------------------

  server.registerTool(
    'champdf_ocr_pdf',
    {
      title: 'ChamPDF — OCR PDF (make searchable)',
      description:
        'Run OCR on a scanned PDF, producing a searchable PDF (optionally archival PDF/A). Requires the backend to have OCR enabled — check champdf_capabilities.',
      inputSchema: {
        input_path: z.string().describe('Absolute path to the scanned PDF.'),
        output_path: z
          .string()
          .describe('Absolute path for the searchable PDF.'),
        language: z
          .string()
          .max(20)
          .default('eng')
          .describe(
            "Tesseract language code(s), e.g. 'eng', 'deu', 'eng+fra'."
          ),
        pdfa: z
          .boolean()
          .default(true)
          .describe('Also convert to archival PDF/A.'),
      },
    },
    async ({ input_path, output_path, language, pdfa }) => {
      try {
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'input.pdf');
        form.append('language', language);
        form.append('pdfa', String(pdfa));
        const res = await callApi('/api/v1/pdf/ocr', {
          method: 'POST',
          multipart: form,
        });
        const { bytes } = await downloadToPath(res, resolve(output_path));
        return ok(
          `OCR'd ${input_path} (${language}${pdfa ? ', PDF/A' : ''}). Wrote ${output_path} (${bytes.toLocaleString()} bytes).`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'champdf_convert_to_pdf',
    {
      title: 'ChamPDF — Convert Office Document to PDF',
      description:
        'Convert an Office/text document to PDF via LibreOffice. Supports doc/docx/odt/rtf/txt, xls/xlsx/ods/csv, ppt/pptx/odp, html. Requires the backend to have conversion enabled — check champdf_capabilities.',
      inputSchema: {
        input_path: z
          .string()
          .describe(
            'Absolute path to the source document (extension determines the input type).'
          ),
        output_path: z
          .string()
          .describe('Absolute path for the resulting PDF.'),
      },
    },
    async ({ input_path, output_path }) => {
      try {
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'document');
        const res = await callApi('/api/v1/convert/to-pdf', {
          method: 'POST',
          multipart: form,
        });
        const { bytes } = await downloadToPath(res, resolve(output_path));
        return ok(
          `Converted ${input_path} to PDF. Wrote ${output_path} (${bytes.toLocaleString()} bytes).`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'champdf_pdf_to_docx',
    {
      title: 'ChamPDF — Convert PDF to Word (DOCX)',
      description:
        'Convert a text-based PDF into an editable Word document (pdf2docx). Works best on digitally-created PDFs; for scans, OCR first. Requires the backend to have conversion enabled — check champdf_capabilities.',
      inputSchema: {
        input_path: z.string().describe('Absolute path to the source PDF.'),
        output_path: z
          .string()
          .describe('Absolute path for the resulting .docx.'),
      },
    },
    async ({ input_path, output_path }) => {
      try {
        const form = new FormData();
        await appendFileField(form, 'file', input_path, 'input.pdf');
        const res = await callApi('/api/v1/convert/pdf-to-docx', {
          method: 'POST',
          multipart: form,
        });
        const { bytes } = await downloadToPath(res, resolve(output_path));
        return ok(
          `Converted ${input_path} to DOCX. Wrote ${output_path} (${bytes.toLocaleString()} bytes).`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );
}
