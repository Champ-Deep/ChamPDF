#!/usr/bin/env node
/**
 * End-to-end test for the ChamPDF MCP server.
 *
 * Spawns the built stdio server (dist/index.js) as a real MCP client would,
 * lists tools, and drives the document tools against a running ChamPDF
 * backend. Needs:
 *
 *   CHAMPDF_API_BASE_URL  backend to hit (e.g. http://localhost:8111)
 *   CHAMPDF_API_KEY       a valid champdf_live_... key on that backend
 *   FIXTURE_DIR           dir containing sample.pdf, sample.docx, signer.p12
 *                         (password "testpass"), page.png
 *   WORK_DIR              writable dir for outputs (default: os tmpdir)
 *
 * Run: node test/e2e.mjs   (after `npm run build`)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = process.env.FIXTURE_DIR;
const BASE_URL = process.env.CHAMPDF_API_BASE_URL;
const API_KEY = process.env.CHAMPDF_API_KEY;

if (!FIXTURES || !BASE_URL || !API_KEY) {
  console.error(
    'Set CHAMPDF_API_BASE_URL, CHAMPDF_API_KEY, FIXTURE_DIR. See header.'
  );
  process.exit(2);
}

const OUT =
  process.env.WORK_DIR ?? (await mkdtemp(join(tmpdir(), 'champdf-mcp-e2e-')));

let passed = 0;
let failed = 0;

function report(name, okFlag, detail = '') {
  if (okFlag) {
    passed += 1;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function callTool(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return { isError: Boolean(res.isError), text };
}

async function fileExists(path, minBytes = 1) {
  try {
    const s = await stat(path);
    return s.size >= minBytes;
  } catch {
    return false;
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(HERE, '..', 'dist', 'index.js')],
  env: {
    ...process.env,
    CHAMPDF_API_BASE_URL: BASE_URL,
    CHAMPDF_API_KEY: API_KEY,
  },
});
const client = new Client({ name: 'champdf-e2e', version: '0.0.0' });
await client.connect(transport);
console.log(`Connected. Backend: ${BASE_URL}. Outputs: ${OUT}`);

// ---- tool inventory -------------------------------------------------------
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(`\n${names.length} tools registered:\n  ${names.join('\n  ')}\n`);
const expected = [
  'champdf_whoami',
  'champdf_capabilities',
  'champdf_merge_pdfs',
  'champdf_split_pdf',
  'champdf_delete_pdf_pages',
  'champdf_rotate_pdf',
  'champdf_compress_pdf',
  'champdf_watermark_pdf',
  'champdf_pdf_info',
  'champdf_pdf_to_text',
  'champdf_pdf_to_images',
  'champdf_images_to_pdf',
  'champdf_extract_pdf_tables',
  'champdf_sign_pdf',
  'champdf_verify_pdf_signature',
  'champdf_ocr_pdf',
  'champdf_convert_to_pdf',
  'champdf_pdf_to_docx',
];
report(
  'tool inventory',
  expected.every((n) => names.includes(n)),
  `${expected.filter((n) => names.includes(n)).length}/${expected.length} expected tools present`
);

const pdf = join(FIXTURES, 'sample.pdf');
const docx = join(FIXTURES, 'sample.docx');
const p12 = join(FIXTURES, 'signer.p12');

// ---- whoami + capabilities ------------------------------------------------
{
  const r = await callTool(client, 'champdf_whoami', {});
  report(
    'whoami',
    !r.isError && r.text.includes('requests used'),
    r.text.split('\n')[0]
  );
}
let caps = {};
{
  const r = await callTool(client, 'champdf_capabilities', {});
  try {
    caps = JSON.parse(r.text);
  } catch {
    /* leave empty */
  }
  report(
    'capabilities',
    !r.isError && caps.pdf_core === true,
    r.text.replace(/\n\s*/g, ' ')
  );
}

// ---- merge → info → split → rotate → compress → watermark → text ---------
{
  const out = join(OUT, 'merged.pdf');
  const r = await callTool(client, 'champdf_merge_pdfs', {
    input_paths: [pdf, pdf],
    output_path: out,
  });
  report('merge_pdfs', !r.isError && (await fileExists(out, 500)), r.text);
}
{
  const r = await callTool(client, 'champdf_pdf_info', {
    input_path: join(OUT, 'merged.pdf'),
  });
  let info = {};
  try {
    info = JSON.parse(r.text);
  } catch {
    /* noop */
  }
  report(
    'pdf_info (merged has 6 pages)',
    !r.isError && info.page_count === 6,
    `page_count=${info.page_count}`
  );
}
{
  const out = join(OUT, 'split.pdf');
  const r = await callTool(client, 'champdf_split_pdf', {
    input_path: join(OUT, 'merged.pdf'),
    pages: '1-2,5',
    output_path: out,
  });
  report('split_pdf', !r.isError && (await fileExists(out, 300)), r.text);
}
{
  const out = join(OUT, 'rotated.pdf');
  const r = await callTool(client, 'champdf_rotate_pdf', {
    input_path: pdf,
    angle: 90,
    pages: 'all',
    output_path: out,
  });
  report('rotate_pdf', !r.isError && (await fileExists(out, 300)), r.text);
}
{
  const out = join(OUT, 'compressed.pdf');
  const r = await callTool(client, 'champdf_compress_pdf', {
    input_path: join(OUT, 'merged.pdf'),
    output_path: out,
  });
  report('compress_pdf', !r.isError && (await fileExists(out, 300)), r.text);
}
{
  const out = join(OUT, 'watermarked.pdf');
  const r = await callTool(client, 'champdf_watermark_pdf', {
    input_path: pdf,
    text: 'MCP-E2E',
    output_path: out,
  });
  report('watermark_pdf', !r.isError && (await fileExists(out, 300)), r.text);
}
{
  const r = await callTool(client, 'champdf_pdf_to_text', {
    input_path: join(OUT, 'watermarked.pdf'),
    pages: '1',
  });
  report(
    'pdf_to_text sees watermark',
    !r.isError && r.text.includes('MCP-E2E')
  );
}

// ---- rasterize + rebuild --------------------------------------------------
{
  const out = join(OUT, 'pages.zip');
  const r = await callTool(client, 'champdf_pdf_to_images', {
    input_path: pdf,
    output_path: out,
    dpi: 72,
  });
  const zipOk = await fileExists(out, 100);
  let magicOk = false;
  if (zipOk) {
    const head = (await readFile(out)).subarray(0, 2).toString('latin1');
    magicOk = head === 'PK';
  }
  report('pdf_to_images (ZIP)', !r.isError && zipOk && magicOk, r.text);
}
{
  const out = join(OUT, 'from-images.pdf');
  const r = await callTool(client, 'champdf_images_to_pdf', {
    input_paths: [join(FIXTURES, 'page.png')],
    output_path: out,
  });
  report('images_to_pdf', !r.isError && (await fileExists(out, 300)), r.text);
}

// ---- sign + verify --------------------------------------------------------
{
  const out = join(OUT, 'signed.pdf');
  const r = await callTool(client, 'champdf_sign_pdf', {
    input_path: pdf,
    cert_path: p12,
    passphrase: 'testpass',
    output_path: out,
    reason: 'MCP e2e',
    timestamp: false,
  });
  report('sign_pdf', !r.isError && (await fileExists(out, 500)), r.text);

  const v = await callTool(client, 'champdf_verify_pdf_signature', {
    input_path: out,
  });
  report('verify_pdf_signature', !v.isError && /signature/i.test(v.text));
}

// ---- conversion (skips cleanly when backend lacks the engine) -------------
{
  const out = join(OUT, 'converted.pdf');
  const r = await callTool(client, 'champdf_convert_to_pdf', {
    input_path: docx,
    output_path: out,
  });
  if (caps.office_to_pdf) {
    report(
      'convert_to_pdf',
      !r.isError && (await fileExists(out, 500)),
      r.text
    );
  } else {
    report(
      'convert_to_pdf 503s when disabled',
      r.isError && r.text.includes('503')
    );
  }
}
{
  const out = join(OUT, 'converted.docx');
  const r = await callTool(client, 'champdf_pdf_to_docx', {
    input_path: pdf,
    output_path: out,
  });
  if (caps.pdf_to_docx) {
    report('pdf_to_docx', !r.isError && (await fileExists(out, 500)), r.text);
  } else {
    report(
      'pdf_to_docx 503s when disabled',
      r.isError && r.text.includes('503')
    );
  }
}
{
  const out = join(OUT, 'ocr.pdf');
  const r = await callTool(client, 'champdf_ocr_pdf', {
    input_path: pdf,
    output_path: out,
  });
  if (caps.pdf_ocr) {
    report('ocr_pdf', !r.isError && (await fileExists(out, 500)), r.text);
  } else {
    report('ocr_pdf 503s when disabled', r.isError && r.text.includes('503'));
  }
}

// ---- error surface: bad page spec ----------------------------------------
{
  const r = await callTool(client, 'champdf_split_pdf', {
    input_path: pdf,
    pages: '99',
    output_path: join(OUT, 'never.pdf'),
  });
  report(
    'bad page spec surfaces API error',
    r.isError && /out of range/i.test(r.text)
  );
}

await client.close();
console.log(`\n${passed} passed, ${failed} failed. Outputs in ${OUT}`);
process.exit(failed === 0 ? 0 : 1);
