# ChamPDF Public API v1

A versioned, API-key-authenticated surface that exposes ChamPDF's tools to
external clients (other web apps, scripts, AI agents). Distinct from the
unversioned `/api/*` endpoints the ChamPDF frontend uses.

## Endpoints

All under `/api/v1`. Auth: `Authorization: Bearer <api_key>`.

| Method | Path                       | What                                                                            |
| ------ | -------------------------- | ------------------------------------------------------------------------------- |
| GET    | `/whoami`                  | Returns the authenticated key's id, label, quota, usage. Cheap.                 |
| POST   | `/image/remove-bg`         | multipart `image` → PNG with transparent background.                            |
| POST   | `/image/edit`              | multipart `image` + `prompt` → PNG (Gemini "Edit Banana").                      |
| POST   | `/image/detect-watermarks` | multipart `image` → JSON `{watermarks: [{x,y,w,h,label,confidence}]}`.          |
| POST   | `/image/inpaint`           | multipart `image` + `mask` (+ optional `prompt`, `radius`) → PNG.               |
| POST   | `/video/download`          | JSON `{url, format: "mp3" \| "mp4"}` → binary stream of the file.               |
| POST   | `/video/remove-logo`       | multipart `file` + `logo_preset` + `watermark_position` + `logo_scale` → MP4.   |
| POST   | `/pdf/remove-watermark`    | multipart `file` + `regions` (JSON) + `method` (telea/ns/gemini) → cleaned PDF. |

### Document endpoints (enterprise / Salesforce surface)

All API-key authenticated, same as above. PDFs up to 50MB.

| Method | Path                    | What                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/capabilities`         | Which optional features are enabled on this server (sign, OCR, conversion, ...).                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/pdf/merge`            | multipart `files` (2+) → single merged PDF, in upload order.                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/pdf/split`            | `file` + `pages` spec (`"1-3,7,9-"`, 1-based) → PDF of just those pages (also reorders).                                                                                                                                                                                                                                                                                                                         |
| POST   | `/pdf/delete-pages`     | `file` + `pages` → PDF without those pages.                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/pdf/rotate`           | `file` + `angle` (90/180/270) + optional `pages` → rotated PDF.                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/pdf/compress`         | `file` + optional `image_dpi`/`image_quality` → smaller PDF (never larger than input).                                                                                                                                                                                                                                                                                                                           |
| POST   | `/pdf/watermark`        | `file` + `text` (+ `opacity`, `font_size`, `color`, `angle`, `pages`) → stamped PDF.                                                                                                                                                                                                                                                                                                                             |
| POST   | `/pdf/info`             | `file` → JSON: page count, metadata, encryption, page size.                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/pdf/to-text`          | `file` (+ `pages`) → JSON `{pages: [{page, text}]}`.                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/pdf/to-images`        | `file` (+ `pages`, `dpi`, `format` png/jpeg) → ZIP of page images.                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/pdf/from-images`      | multipart `files` (PNG/JPEG) → one PDF, one page per image.                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/pdf/sign`             | `file` + `cert` (.p12/.pfx) + `passphrase` (+ `reason`, `location`, `field_name`, `timestamp`) → PAdES-signed PDF (pyHanko). Visible signatures: `visible=true` + `page` (1-based, -1=last) + `x`/`y`/`width`/`height` (PDF points, origin bottom-left) renders a DocuSign-style box; `signature_name` additionally renders that name in a handwritten script face (visual only — identity comes from the cert). |
| POST   | `/pdf/verify-signature` | `file` → JSON signature report (integrity, signer, timestamps).                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/pdf/form-fields`      | `file` → JSON list of AcroForm fields (name, type, value, page, options). Discovery step for fill-form.                                                                                                                                                                                                                                                                                                          |
| POST   | `/pdf/fill-form`        | `file` + `fields` (JSON `{name: value}`) + optional `flatten` → filled PDF (`X-Fields-Filled` header). Unknown names ⇒ 422 listing them. Flatten BEFORE signing, never after.                                                                                                                                                                                                                                    |
| POST   | `/pdf/ocr`              | `file` (+ `language`, `pdfa`) → searchable PDF / PDF-A (OCRmyPDF). 503 if not installed.                                                                                                                                                                                                                                                                                                                         |
| POST   | `/pdf/extract-tables`   | `file` → JSON tables (rows + markdown).                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/convert/to-pdf`       | Office doc (doc/docx/odt/rtf/txt/xls/xlsx/ods/csv/ppt/pptx/odp/html) → PDF (LibreOffice).                                                                                                                                                                                                                                                                                                                        |
| POST   | `/convert/pdf-to-docx`  | `file` (PDF) → editable Word .docx (pdf2docx).                                                                                                                                                                                                                                                                                                                                                                   |

Optional features degrade cleanly: if the backing engine isn't installed
(LibreOffice, OCRmyPDF, pyHanko, pdf2docx), the endpoint returns **503** and
`/api/v1/capabilities` reports it as `false` — clients can feature-detect.

Auto-generated docs at `GET /docs` (Swagger UI) and `GET /openapi.json`.
v1 endpoints show under the **v1** tag.

## Salesforce integration

Salesforce calls the API server-to-server from Apex — no CORS involved.

1. **Named Credential** (Setup → Named Credentials → External Credential,
   Custom auth): base URL `https://<your-backend-domain>`, and add an
   `Authorization` header of `Bearer champdf_live_...` via a custom header on
   the Named Credential. Add the domain to **Remote Site Settings** if you use
   plain endpoints instead.
2. **Apex callout** (multipart example — sign a Quote PDF):

```apex
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:ChamPDF/api/v1/pdf/watermark');
req.setMethod('POST');
req.setTimeout(120000);

String boundary = '----champdf' + String.valueOf(Crypto.getRandomInteger());
req.setHeader('Content-Type', 'multipart/form-data; boundary=' + boundary);

// contentDoc.VersionData is the PDF blob from a Quote / ContentVersion
String head = '--' + boundary + '\r\n'
  + 'Content-Disposition: form-data; name="file"; filename="quote.pdf"\r\n'
  + 'Content-Type: application/pdf\r\n\r\n';
String fields = '\r\n--' + boundary + '\r\n'
  + 'Content-Disposition: form-data; name="text"\r\n\r\nAPPROVED'
  + '\r\n--' + boundary + '--\r\n';
Blob body = EncodingUtil.base64Decode(
  EncodingUtil.base64Encode(Blob.valueOf(head))
  + EncodingUtil.base64Encode(contentDoc.VersionData).replaceAll('=', '')
  + EncodingUtil.base64Encode(Blob.valueOf(fields)));
req.setBodyAsBlob(body);

HttpResponse res = new Http().send(req);
// res.getBodyAsBlob() is the stamped PDF — save as a new ContentVersion
```

(For production use, the community `HttpFormBuilder` pattern handles
base64 padding across part boundaries robustly.)

3. **Typical flows**: `convert/to-pdf` for turning generated .docx quotes
   into PDFs, `pdf/merge` to assemble contract packets, `pdf/sign` for
   compliance signatures with your org's .p12, `pdf/to-text` /
   `pdf/extract-tables` to index incoming documents into Salesforce fields.
4. **Quotas**: issue one key per team via `/api/v1/admin/keys` with an
   appropriate `monthly_quota`; usage is visible via `/whoami` and the admin
   key list.

## Admin endpoints

Gated by `X-Admin-Token: <CHAMPDF_ADMIN_TOKEN env var>`.

| Method | Path                          | What                                |
| ------ | ----------------------------- | ----------------------------------- |
| POST   | `/api/v1/admin/keys`          | Issue a new key.                    |
| GET    | `/api/v1/admin/keys`          | List all keys (without raw values). |
| DELETE | `/api/v1/admin/keys/{key_id}` | Revoke a key.                       |

If `CHAMPDF_ADMIN_TOKEN` is not set, all admin endpoints return 503.

## Self-serve keys (Clerk sign-in)

So a signed-in user can mint their own key from the website (account menu →
**API**) and hand it to their AI assistant — no admin involvement. These are
authenticated by the user's **Clerk session token**, not the admin token:
`Authorization: Bearer <clerk_session_jwt>`.

| Method | Path                     | What                                                           |
| ------ | ------------------------ | -------------------------------------------------------------- |
| GET    | `/api/v1/keys/me`        | Status of the caller's key (metadata only, never the raw key). |
| POST   | `/api/v1/keys/me`        | Mint the caller's key. 409 if one already exists.              |
| POST   | `/api/v1/keys/me/rotate` | Revoke the old key and issue a fresh one.                      |
| DELETE | `/api/v1/keys/me`        | Revoke the caller's key.                                       |

Each key is bound to the Clerk user id (`sub`); a user has at most one active
key. The raw value is returned only by the POST endpoints (create/rotate),
once.

**Enablement.** Dormant until `CLERK_ISSUER` is set (the Clerk Frontend API
URL). When unset these endpoints return 503. The frontend advertises
availability via `GET /api/capabilities` → `"api_self_serve_keys": true`.

**Who may mint.** Default: any signed-in Clerk user. To lock issuance to your
team, set `CHAMPDF_API_KEY_EMAIL_DOMAINS` (comma-separated, e.g.
`championsmail.com`). When set, the user's email must match; if the Clerk
session token carries no `email` claim, set `CLERK_SECRET_KEY` so the backend
can look it up (otherwise issuance fails closed). Non-permitted accounts get 403.

| Var                             | Purpose                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `CLERK_ISSUER`                  | Clerk Frontend API URL. Enables the `/keys/me` endpoints. Unset => 503.     |
| `CLERK_JWKS_URL`                | Optional override; defaults to `<CLERK_ISSUER>/.well-known/jwks.json`.      |
| `CLERK_SECRET_KEY`              | Optional; only for email-domain gating when the JWT lacks an `email` claim. |
| `CHAMPDF_API_KEY_EMAIL_DOMAINS` | Optional allowlist of email domains. Empty => any signed-in user.           |

## Auth

API keys look like `champdf_live_<32 hex chars>`. The raw value is shown
**only at creation**; the server stores SHA-256 hashes and cannot recover
the original.

## RBAC scopes (role-based access)

Every key carries a scope list. Default is `*` (full access); pass `scopes`
when issuing to restrict it — e.g. a key a signing bot can use for nothing
but signatures:

```bash
curl -X POST $BACKEND/api/v1/admin/keys \
  -H "X-Admin-Token: $CHAMPDF_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"label": "sign-bot", "scopes": ["pdf.sign"], "monthly_quota": 5000}'
```

| Scope       | Grants                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `pdf.read`  | info, to-text, to-images, extract-tables, verify-signature, form-fields                                |
| `pdf.write` | merge, split, delete-pages, rotate, compress, watermark, from-images, ocr, remove-watermark, fill-form |
| `pdf.sign`  | sign                                                                                                   |
| `pdf`       | all of the above (parent scope grants dotted children)                                                 |
| `convert`   | to-pdf, pdf-to-docx                                                                                    |
| `image`     | remove-bg, edit, inpaint, detect-watermarks                                                            |
| `video`     | download, remove-logo                                                                                  |
| `*`         | everything (default)                                                                                   |

Out-of-scope calls return **403** with
`{"code": "insufficient_scope", "required_scope": "..."}`. `/whoami` and
`/capabilities` work with any valid key. Existing keys issued before this
feature keep full access (`*`).

Typical team setup: one scoped key per team/integration (e.g. Salesforce
signing flow gets `pdf.sign` + `pdf.read`; the document pipeline gets `pdf` +
`convert`), each with its own quota — usage per key is visible via the admin
key list.

## Rate limits

Two layers, both per-key:

- **Burst**: 30 requests / minute (in-memory sliding window). Returns 429
  with `{"code": "rate_limited"}`.
- **Monthly quota**: configurable per key (default 1000). Returns 429
  with `{"code": "quota_exceeded"}`. Quotas reset at the start of each
  UTC month.

## Storage

API keys live in SQLite at `/app/data/champdf.db` by default. Override
with `CHAMPDF_DB_PATH` env var. On Railway, mount a Volume at
`/app/data` so keys persist across deploys; otherwise the DB is
ephemeral and you'll need to re-issue keys after every redeploy.

## Required env vars

| Var                   | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `CHAMPDF_ADMIN_TOKEN` | Enables `/api/v1/admin/*`. Without it, admin endpoints return 503.  |
| `GEMINI_API_KEY`      | Enables `/api/v1/image/edit`. Without it, the endpoint returns 503. |
| `CHAMPDF_DB_PATH`     | SQLite path. Defaults to `/app/data/champdf.db`. Optional.          |

## Quickstart

```bash
# 1. Issue a key (server-side, with admin token)
curl -X POST https://champdf-backend.up.railway.app/api/v1/admin/keys \
  -H "X-Admin-Token: $CHAMPDF_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "marketing-team", "monthly_quota": 10000}'
# -> {"id": 1, "key": "champdf_live_...", ...}

# 2. Use it
curl -X POST https://champdf-backend.up.railway.app/api/v1/image/remove-bg \
  -H "Authorization: Bearer champdf_live_..." \
  -F "image=@photo.jpg" \
  -o photo-no-bg.png

# 3. Check usage
curl https://champdf-backend.up.railway.app/api/v1/whoami \
  -H "Authorization: Bearer champdf_live_..."
# -> {"id": 1, "label": "marketing-team", "monthly_quota": 10000,
#     "requests_used": 1, "month_bucket": "2026-04"}
```

## Test the AI-assistant chain right now

You don't need Clerk wired up to exercise the full
key → API → AI-assistant path. Hand-mint a key with the admin token, then
point the MCP server at it:

```bash
# Issue a key (needs CHAMPDF_ADMIN_TOKEN set on the backend)
curl -X POST https://champdf-backend.up.railway.app/api/v1/admin/keys \
  -H "X-Admin-Token: $CHAMPDF_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "test", "monthly_quota": 1000}'
# -> {"key": "champdf_live_...", ...}

# Register it with Claude Code and smoke-test
claude mcp add champdf \
  -e CHAMPDF_API_KEY=champdf_live_... \
  -e CHAMPDF_API_BASE_URL=https://champdf-backend.up.railway.app \
  -- npx -y @champ-deep/champdf-mcp
# then in Claude Code: "call champdf_whoami"
```

Once `CLERK_ISSUER` is set, users do the same thing self-serve from the
account menu (**API** pill) — no admin token needed.

## What's NOT in v1

The interactive client-side PDF Editor, Crop, and Compare remain
browser-only. Everything else the browser tools cover — Office→PDF
conversion, OCR, rotate, merge/split, signing — now has a server-side v1
equivalent (see the document endpoints table above).

## MCP server (shipped)

The MCP server lives in [`mcp/`](../mcp/) (`@champ-deep/champdf-mcp`) and
wraps this API — all 17 document tools plus the media tools — so Claude
Code, Claude Desktop, Cursor, and any MCP-aware agent can sign, merge,
convert, and OCR documents natively. Two transports: stdio
(`npx -y @champ-deep/champdf-mcp`) and a hosted HTTP endpoint for teams.
Setup, tool list, and deployment: [`mcp/README.md`](../mcp/README.md).
