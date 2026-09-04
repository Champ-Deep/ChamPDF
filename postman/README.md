# ChamPDF API — Postman collection

The curated Postman collection for the ChamPDF public API, plus environments for
production and local development.

| File | What it is |
| --- | --- |
| `ChamPDF-API.postman_collection.json` | 31 requests across 8 folders, with docs, tests and saved response examples |
| `ChamPDF-Production.postman_environment.json` | Points at the live API. Secrets ship empty |
| `ChamPDF-Local.postman_environment.json` | Points at `localhost:8000` for a local backend |

## Import

**Postman → Import → Files**, select all three, then pick
**ChamPDF · Production** in the environment selector (top right) and paste your
API key into `apiKey`.

Smoke-test with `0 · Start here → Who am I`. A `200` means the base URL and key
are both correct.

## Why this is hand-curated, not generated from `openapi.json`

Importing the raw spec produces a worse result, for three reasons:

1. The spec describes **all 52 paths**, including 17 unversioned `/api/*`
   endpoints that back the web app. Those carry no compatibility guarantee and
   include destructive operations such as `DELETE /api/cleanup`. Integrators
   should only see the `/api/v1` surface.
2. A generated collection has no folder structure, no saved examples, no tests,
   and no request documentation beyond one-line summaries.
3. Until the backend change that ships alongside this collection is deployed, the
   spec declares neither a `servers` block nor a security scheme — so imported
   requests arrive with no base URL and no `Authorization` header, and every call
   returns `401`.

Point three is now fixed at the source (`backend/main.py` sets the title,
description, server URL and both auth schemes), so the spec is usable as a
fallback. This collection remains the better starting point.

## Keeping it current

The collection is the source of truth for the Postman workspace, and this repo is
the source of truth for the collection. When endpoints change:

1. Edit in Postman.
2. **Export → Collection v2.1** and overwrite
   `ChamPDF-API.postman_collection.json`.
3. Commit, so the diff is reviewable alongside the API change that caused it.

Before exporting, check that no `formdata` entry carries a `src` value — Postman
does not export local file paths, but a hand-edited collection can. `src` must be
`null` on every file field.

**Never commit a filled-in secret.** `apiKey`, `certPassphrase` and `adminToken`
are typed `secret` in both environments, which keeps them out of exports. If a
value ever appears in a diff, treat the key as compromised and rotate it via
`POST /api/v1/admin/keys`.

## Publishing documentation

Postman renders every `description` field as documentation, which is why they are
written as prose rather than notes to self. To publish:

1. Put the collection in a **Team workspace**, not a personal one — personal
   workspaces cannot be shared and die with the account.
2. **View complete documentation → Publish.**
3. Set visibility. Internal-only is right while the API is behind a single
   deployment; public documentation implies a public commitment to availability.
4. Add the published URL to the repo when it exists.

Integrators should be given the published documentation URL or a **view-only**
collection link, never an edit link.

## Suggested workspace setup

- **Team workspace** with the collection, both environments, and one folder per
  consumer if more integrations follow.
- **Fork and pull request** for changes from other teams, rather than direct edit
  rights, so API changes are reviewed like code.
- **Mock server** off the saved examples, so an integrating team can build against
  realistic responses without spending quota or handling real certificates. This
  is genuinely useful for Salesforce work, where an org's sandbox may not reach
  the API early on.
- **Monitor** on `0 · Start here`, run hourly, as an independent check alongside
  the existing uptime monitor.

## Running the Salesforce flow

Folder `1 · Salesforce signing flow` is the reference implementation in call
order. Each step consumes the PDF the previous step returned, and Postman cannot
pipe a binary response into the next request's file field — so after each step use
**Save Response → Save to a file** and select that file in the next request.

For the Collection Runner, set **Settings → General → Working directory**, put the
test files there, and Postman resolves them by name.

## Scopes

Requests are annotated with the scope they require. An out-of-scope call returns
`403` with `{"code":"insufficient_scope","required_scope":"..."}`.

| Scope | Grants |
| --- | --- |
| `pdf.read` | info, to-text, to-images, extract-tables, verify-signature, form-fields |
| `pdf.write` | merge, split, delete-pages, rotate, compress, watermark, from-images, ocr, fill-form |
| `pdf.sign` | sign |
| `pdf` | all of the above |
| `convert` | to-pdf, pdf-to-docx |
| `image`, `video` | the media endpoints |
| `*` | everything (default) |

Issue the narrowest scope that works — see `backend/API_V1.md` for the full
reference.
