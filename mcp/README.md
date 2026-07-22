# @champ-deep/champdf-mcp

MCP server for [ChamPDF](https://champdf.com) — let Claude Code, Claude
Desktop, Cursor, and any other MCP-aware client call ChamPDF's tools
natively.

What you get — **document tools** (the enterprise surface):

- **`champdf_sign_pdf`** — compliance-grade digital signature (PAdES via pyHanko) with your .p12/.pfx cert, optional trusted timestamp. _"sign this contract with our company cert"_.
- **`champdf_verify_pdf_signature`** — integrity/signer/timestamp report for a signed PDF.
- **`champdf_merge_pdfs` / `champdf_split_pdf` / `champdf_delete_pdf_pages` / `champdf_rotate_pdf`** — assemble and reorganize documents.
- **`champdf_compress_pdf`** — shrink PDFs (never returns a bigger file).
- **`champdf_watermark_pdf`** — stamp CONFIDENTIAL / DRAFT / APPROVED across pages.
- **`champdf_convert_to_pdf`** — Word/Excel/PowerPoint/ODF/HTML → PDF (LibreOffice).
- **`champdf_pdf_to_docx`** — PDF → editable Word.
- **`champdf_ocr_pdf`** — scanned PDF → searchable PDF / PDF-A.
- **`champdf_pdf_to_text` / `champdf_extract_pdf_tables` / `champdf_pdf_info`** — pull text, tables (JSON + markdown), and metadata out of documents.
- **`champdf_pdf_to_images` / `champdf_images_to_pdf`** — rasterize pages / build PDFs from images.

Plus **media tools**:

- **`champdf_remove_background`** — strip the background from a photo (rembg / U²-Net).
- **`champdf_edit_image`** — natural-language image editing via Gemini ("Edit Banana"). _"remove the person on the left and inpaint the background"_.
- **`champdf_detect_watermarks`** — find bounding boxes of watermarks/logos in an image. Pair with `champdf_inpaint_image` for fully autonomous removal.
- **`champdf_inpaint_image`** — mask-based inpainting. Provide an image and a binary PNG mask; agent gets back a clean image.
- **`champdf_remove_pdf_watermark`** — region-based watermark removal inside PDFs.
- **`champdf_download_video`** — pull a YouTube/Instagram video (long-form, Shorts, Reels) as MP4 or 320 kbps MP3.
- **`champdf_remove_video_logo`** — strip the corner watermark from a video (NotebookLM-style logos) and optionally overlay your own.

And plumbing:

- **`champdf_whoami`** — sanity check: key label, quota, usage, RBAC scopes.
- **`champdf_capabilities`** — which optional backend features (signing, OCR, conversion) are enabled.

**RBAC**: keys can be scoped (`pdf.sign`, `pdf.read`, `pdf.write`, `convert`,
`image`, `video`, or `*`). A sign-only key lets an agent sign documents and
nothing else — out-of-scope calls return a structured `insufficient_scope`
error the agent can relay. Mint scoped keys via
`POST /api/v1/admin/keys {"label": "sign-bot", "scopes": ["pdf.sign"]}`.

## Setup

You need:

1. A ChamPDF API key — formatted `champdf_live_<32 hex>`. Sign in at
   champdf.com and open the account menu → **API** to generate one
   (self-serve), or mint one server-side via the admin endpoint
   (`POST /api/v1/admin/keys`).
2. A ChamPDF backend URL. Defaults to `https://api.champdf.com`; set
   `CHAMPDF_API_BASE_URL` to point at a self-hosted instance.

### Claude Code

```bash
claude mcp add champdf \
  -e CHAMPDF_API_KEY=champdf_live_... \
  -- npx -y @champ-deep/champdf-mcp
```

### Claude Desktop / generic MCP client

Add to your config (e.g. `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "champdf": {
      "command": "npx",
      "args": ["-y", "@champ-deep/champdf-mcp"],
      "env": {
        "CHAMPDF_API_KEY": "champdf_live_..."
      }
    }
  }
}
```

### Self-hosted backend

```json
{
  "mcpServers": {
    "champdf": {
      "command": "npx",
      "args": ["-y", "@champ-deep/champdf-mcp"],
      "env": {
        "CHAMPDF_API_KEY": "champdf_live_...",
        "CHAMPDF_API_BASE_URL": "https://champdf-backend.up.railway.app"
      }
    }
  }
}
```

## How tools handle files

All tools take **absolute file paths**. The server reads the input file,
uploads it, and writes the result to whatever `output_path` you specify.
This is the idiomatic pattern for MCP — agents ask the user where to
save things and pass the path through.

Example agent prompt: _"Remove the watermark from `/Users/alex/Downloads/notebooklm-export.png` and save it as `/Users/alex/Desktop/clean.png`"_ → the agent picks `champdf_inpaint_image` (or `champdf_edit_image` if there's no mask), passes the paths, and the MCP server does the rest.

## Environment variables

| Var                    | Required | Default                   | Purpose                                         |
| ---------------------- | -------- | ------------------------- | ----------------------------------------------- |
| `CHAMPDF_API_KEY`      | yes      | —                         | Your `champdf_live_...` key.                    |
| `CHAMPDF_API_BASE_URL` | no       | `https://api.champdf.com` | Override when self-hosting the ChamPDF backend. |

## Smoke test

Once configured, ask your agent: _"call champdf_whoami"_. If everything
is wired up you'll see something like:

> ChamPDF key #7 "alex-laptop": 3 of 1000 requests used this month
> (bucket 2026-04).

If it errors with 401, your key is wrong. If it errors with a network
timeout, your `CHAMPDF_API_BASE_URL` is wrong (or the backend is down).

## Development

```bash
git clone https://github.com/Champ-Deep/ChamPDF
cd ChamPDF/mcp
npm install
npm run build      # tsc -> dist/
node dist/index.js # speaks MCP over stdio
```

Set `CHAMPDF_API_KEY` and `CHAMPDF_API_BASE_URL` in your shell before
running, otherwise tool calls will return 401.

## Hosted (HTTP/SSE) variant

For users who can't run Node locally — Claude Desktop on a managed machine,
shared team accounts, etc. — there's an HTTP/SSE entry point you can host.
Deploy it once and point clients at the URL.

### Deploy on Railway

The repo's `railway.toml` defines a third service `champdf-mcp` that builds
from `mcp/Dockerfile.railway`. Set:

| Env var                  | Required | Notes                                                                 |
| ------------------------ | -------- | --------------------------------------------------------------------- |
| `CHAMPDF_API_KEY`        | yes      | A v1 API key the MCP server uses to call the backend.                 |
| `CHAMPDF_API_BASE_URL`   | yes      | Internal backend URL, e.g. `http://champdf-backend.railway.internal`. |
| `CHAMPDF_MCP_AUTH_TOKEN` | rec.     | Bearer token clients must pass. If unset, the URL is open to anyone.  |

Healthcheck path is `/healthz`. The MCP endpoint is `POST /mcp`.

### Connect from Claude Desktop / web clients

```json
{
  "mcpServers": {
    "champdf": {
      "type": "http",
      "url": "https://champdf-mcp.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_CHAMPDF_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

### Run locally for development

```bash
CHAMPDF_API_KEY=champdf_live_... \
CHAMPDF_API_BASE_URL=https://champdf-backend.up.railway.app \
npm run dev:http
# -> [champdf-mcp/http] listening on http://0.0.0.0:8081/mcp
```

The HTTP server is **stateless** — each request spawns a fresh MCP server
instance, runs the tool, and tears down. That keeps it cheap to scale and
avoids cross-request state leaks.

## License

MIT.
