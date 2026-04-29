# @champ-deep/champdf-mcp

MCP server for [ChamPDF](https://champdf.com) — let Claude Code, Claude
Desktop, Cursor, and any other MCP-aware client call ChamPDF's tools
natively.

What you get:

- **`champdf_remove_background`** — strip the background from a photo (rembg / U²-Net).
- **`champdf_edit_image`** — natural-language image editing via Gemini ("Edit Banana"). _"remove the person on the left and inpaint the background"_.
- **`champdf_inpaint_image`** — mask-based inpainting. Provide an image and a binary PNG mask; agent gets back a clean image.
- **`champdf_download_video`** — pull a YouTube/Instagram video (long-form, Shorts, Reels) as MP4 or 320 kbps MP3.
- **`champdf_whoami`** — cheap sanity check that returns your key's quota and usage.

## Setup

You need:

1. A ChamPDF API key — formatted `champdf_live_<32 hex>`. Get one from
   the ChamPDF backend admin endpoint (`POST /api/v1/admin/keys`).
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

| Var                     | Required | Default                       | Purpose                                              |
| ----------------------- | -------- | ----------------------------- | ---------------------------------------------------- |
| `CHAMPDF_API_KEY`       | yes      | —                             | Your `champdf_live_...` key.                         |
| `CHAMPDF_API_BASE_URL`  | no       | `https://api.champdf.com`     | Override when self-hosting the ChamPDF backend.      |

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

## License

MIT.
