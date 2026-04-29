#!/usr/bin/env node
/**
 * ChamPDF MCP Server.
 *
 * Wraps the ChamPDF Public API v1 as MCP tools so Claude Code, Claude
 * Desktop, Cursor, and any other MCP-aware client can call ChamPDF's
 * image/video tools natively.
 *
 * Auth: reads CHAMPDF_API_KEY from env. Get one from your ChamPDF
 * backend with `POST /api/v1/admin/keys` (see backend/API_V1.md).
 *
 * API base URL: defaults to https://api.champdf.com — override via
 * CHAMPDF_API_BASE_URL env var (e.g. when self-hosting).
 *
 * File I/O: tools accept absolute file paths and write outputs to
 * absolute paths. This is the idiomatic way to plumb files through
 * MCP — agents ask the user where to save things, then pass the path.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const API_BASE_URL =
  process.env.CHAMPDF_API_BASE_URL?.replace(/\/$/, '') ??
  'https://api.champdf.com';
const API_KEY = process.env.CHAMPDF_API_KEY ?? '';

if (!API_KEY) {
  console.error(
    '[champdf-mcp] CHAMPDF_API_KEY is not set. Tool calls will fail with 401.'
  );
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: unknown
  ) {
    super(message);
  }
}

async function callApi(
  path: string,
  init: RequestInit & { multipart?: FormData; json?: unknown } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.multipart) {
    body = init.multipart;
  } else if (init.body) {
    body = init.body;
  }
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail: unknown = text;
    try {
      detail = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    throw new ApiError(
      `ChamPDF API ${path} failed (${res.status})`,
      res.status,
      detail
    );
  }
  return res;
}

async function downloadToPath(
  res: Response,
  outputPath: string
): Promise<{ bytes: number }> {
  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  await writeFile(outputPath, buf);
  return { bytes: buf.byteLength };
}

function summarizeError(err: unknown): string {
  if (err instanceof ApiError) {
    let body = '';
    if (err.detail && typeof err.detail === 'object') {
      const d = err.detail as Record<string, unknown>;
      body =
        typeof d.detail === 'string'
          ? d.detail
          : JSON.stringify(d.detail ?? d, null, 2);
    } else if (typeof err.detail === 'string') {
      body = err.detail;
    }
    return `${err.message}${body ? `\n${body}` : ''}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function fail(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: summarizeError(err) }],
    isError: true,
  };
}

// --------------------------------------------------------------------------
// Server
// --------------------------------------------------------------------------

const server = new McpServer({
  name: 'champdf',
  version: '0.1.0',
});

// --------------------------------------------------------------------------
// Tool: whoami — cheap auth check, useful for debugging setup
// --------------------------------------------------------------------------

server.registerTool(
  'champdf_whoami',
  {
    title: 'ChamPDF — Inspect API Key',
    description:
      'Returns metadata about the configured CHAMPDF_API_KEY (label, monthly quota, requests used this month). Useful as a smoke test when setting up the MCP server.',
    inputSchema: {},
  },
  async () => {
    try {
      const res = await callApi('/api/v1/whoami');
      const body = (await res.json()) as {
        id: number;
        label: string;
        monthly_quota: number;
        requests_used: number;
        month_bucket: string;
      };
      return ok(
        `ChamPDF key #${body.id} "${body.label}": ${body.requests_used} of ${body.monthly_quota} requests used this month (bucket ${body.month_bucket}).`
      );
    } catch (err) {
      return fail(err);
    }
  }
);

// --------------------------------------------------------------------------
// Tool: remove_background
// --------------------------------------------------------------------------

server.registerTool(
  'champdf_remove_background',
  {
    title: 'ChamPDF — Remove Image Background',
    description:
      'Remove the background from a PNG/JPEG/WebP image and return a transparent PNG. Backed by rembg / U²-Net. Use for product photos, portraits, isolating subjects, etc.',
    inputSchema: {
      input_path: z
        .string()
        .describe('Absolute path to the source image file.'),
      output_path: z
        .string()
        .describe(
          'Absolute path where the result PNG should be written. Will be overwritten if it exists.'
        ),
    },
  },
  async ({ input_path, output_path }) => {
    try {
      const data = await readFile(resolve(input_path));
      const form = new FormData();
      form.append(
        'image',
        new Blob([new Uint8Array(data)]),
        input_path.split('/').pop() ?? 'image'
      );
      const res = await callApi('/api/v1/image/remove-bg', {
        method: 'POST',
        multipart: form,
      });
      const { bytes } = await downloadToPath(res, resolve(output_path));
      return ok(
        `Removed background from ${input_path}. Wrote ${bytes.toLocaleString()} bytes to ${output_path}.`
      );
    } catch (err) {
      return fail(err);
    }
  }
);

// --------------------------------------------------------------------------
// Tool: edit_image — Edit Banana / Gemini prompt-based
// --------------------------------------------------------------------------

server.registerTool(
  'champdf_edit_image',
  {
    title: 'ChamPDF — Edit Image (Edit Banana / Gemini)',
    description:
      'Edit an image with a natural-language prompt using Gemini\'s image-editing model. Best for: removing/replacing objects, restyling photos, changing backgrounds, restoring faded images. The model follows specific prompts better than vague ones — say "remove the man in the red shirt", not "clean it up".',
    inputSchema: {
      input_path: z
        .string()
        .describe('Absolute path to the source image (PNG/JPEG/WebP).'),
      prompt: z
        .string()
        .min(3)
        .max(2000)
        .describe('What to change in the image. Be specific.'),
      output_path: z
        .string()
        .describe('Absolute path where the edited PNG should be written.'),
    },
  },
  async ({ input_path, prompt, output_path }) => {
    try {
      const data = await readFile(resolve(input_path));
      const form = new FormData();
      form.append(
        'image',
        new Blob([new Uint8Array(data)]),
        input_path.split('/').pop() ?? 'image'
      );
      form.append('prompt', prompt);
      const res = await callApi('/api/v1/image/edit', {
        method: 'POST',
        multipart: form,
      });
      const { bytes } = await downloadToPath(res, resolve(output_path));
      return ok(
        `Edited ${input_path} per prompt: "${prompt.slice(0, 80)}${
          prompt.length > 80 ? '…' : ''
        }". Wrote ${bytes.toLocaleString()} bytes to ${output_path}.`
      );
    } catch (err) {
      return fail(err);
    }
  }
);

// --------------------------------------------------------------------------
// Tool: inpaint_image — mask-based inpainting (Gemini, OpenCV fallback)
// --------------------------------------------------------------------------

server.registerTool(
  'champdf_inpaint_image',
  {
    title: 'ChamPDF — Inpaint Image (mask-based)',
    description:
      'Inpaint specific regions of an image. Provide an image and a binary mask (PNG; white pixels = inpaint, black = preserve). Used by the PDF Watermark Remover internally — agents can use it for any precise region-specific edit. Tries Gemini first, falls back to OpenCV Telea.',
    inputSchema: {
      input_path: z.string().describe('Absolute path to the source image.'),
      mask_path: z
        .string()
        .describe(
          'Absolute path to a binary PNG mask. White pixels are replaced; black pixels are preserved. Same dimensions as the source recommended.'
        ),
      output_path: z
        .string()
        .describe('Absolute path where the inpainted PNG should be written.'),
      prompt: z
        .string()
        .max(2000)
        .optional()
        .describe(
          'Optional hint for Gemini, e.g. "the masked area is a watermark — match the surrounding background".'
        ),
      radius: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(5)
        .describe('Inpaint radius in pixels (only used by the OpenCV fallback).'),
    },
  },
  async ({ input_path, mask_path, output_path, prompt, radius }) => {
    try {
      const [imgData, maskData] = await Promise.all([
        readFile(resolve(input_path)),
        readFile(resolve(mask_path)),
      ]);
      const form = new FormData();
      form.append(
        'image',
        new Blob([new Uint8Array(imgData)]),
        input_path.split('/').pop() ?? 'image'
      );
      form.append(
        'mask',
        new Blob([new Uint8Array(maskData)]),
        mask_path.split('/').pop() ?? 'mask.png'
      );
      if (prompt) form.append('prompt', prompt);
      form.append('radius', String(radius));
      const res = await callApi('/api/v1/image/inpaint', {
        method: 'POST',
        multipart: form,
      });
      const { bytes } = await downloadToPath(res, resolve(output_path));
      return ok(
        `Inpainted ${input_path} using mask ${mask_path}. Wrote ${bytes.toLocaleString()} bytes to ${output_path}.`
      );
    } catch (err) {
      return fail(err);
    }
  }
);

// --------------------------------------------------------------------------
// Tool: download_video
// --------------------------------------------------------------------------

server.registerTool(
  'champdf_download_video',
  {
    title: 'ChamPDF — Download Video (YouTube/Instagram)',
    description:
      'Download a YouTube or Instagram video as MP4, or extract its audio as 320 kbps MP3. Supports long-form videos and Shorts/Reels. 30-minute duration cap.',
    inputSchema: {
      url: z
        .string()
        .url()
        .describe('Public YouTube or Instagram URL.'),
      format: z
        .enum(['mp4', 'mp3'])
        .default('mp4')
        .describe('Output format: mp4 for full video, mp3 for audio only.'),
      output_path: z
        .string()
        .describe(
          'Absolute path where the downloaded file should be written. Use a .mp4 or .mp3 extension matching `format`.'
        ),
    },
  },
  async ({ url, format, output_path }) => {
    try {
      const res = await callApi('/api/v1/video/download', {
        method: 'POST',
        json: { url, format },
      });
      const { bytes } = await downloadToPath(res, resolve(output_path));
      return ok(
        `Downloaded ${url} as ${format.toUpperCase()}. Wrote ${bytes.toLocaleString()} bytes to ${output_path}.`
      );
    } catch (err) {
      return fail(err);
    }
  }
);

// --------------------------------------------------------------------------
// Tool: remove_video_logo
// --------------------------------------------------------------------------

server.registerTool(
  'champdf_remove_video_logo',
  {
    title: 'ChamPDF — Remove Video Watermark / Logo',
    description:
      'Remove an AI watermark (e.g. NotebookLM-style corner logos) from a video and optionally overlay a replacement logo. Output is MP4. Use for cleaning up generated videos before posting them.',
    inputSchema: {
      input_path: z
        .string()
        .describe('Absolute path to the source video (mp4, mov, webm, or avi).'),
      output_path: z
        .string()
        .describe('Absolute path where the cleaned MP4 should be written.'),
      watermark_position: z
        .enum(['bottom-right', 'bottom-left', 'top-right', 'top-left'])
        .default('bottom-right')
        .describe('Where the original watermark sits.'),
      logo_preset: z
        .enum(['lakeb2b', 'champions', 'ampliz', 'none'])
        .default('none')
        .describe(
          'Replacement logo preset. Use "none" to just remove the watermark without adding a new one.'
        ),
      logo_scale: z
        .number()
        .min(0.5)
        .max(2.0)
        .default(1.0)
        .describe('Size multiplier for the replacement logo (0.5–2.0; 1.0 ≈ 120px wide).'),
    },
  },
  async ({
    input_path,
    output_path,
    watermark_position,
    logo_preset,
    logo_scale,
  }) => {
    try {
      const data = await readFile(resolve(input_path));
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(data)]),
        input_path.split('/').pop() ?? 'video.mp4'
      );
      form.append('watermark_position', watermark_position);
      form.append('logo_preset', logo_preset);
      form.append('logo_scale', String(logo_scale));
      const res = await callApi('/api/v1/video/remove-logo', {
        method: 'POST',
        multipart: form,
      });
      const { bytes } = await downloadToPath(res, resolve(output_path));
      return ok(
        `Removed ${watermark_position} watermark from ${input_path}` +
          (logo_preset !== 'none'
            ? ` and overlaid ${logo_preset} logo at ${logo_scale}× size`
            : '') +
          `. Wrote ${bytes.toLocaleString()} bytes to ${output_path}.`
      );
    } catch (err) {
      return fail(err);
    }
  }
);

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

await server.connect(new StdioServerTransport());
