# ChampPDF Sign

The document execution layer for Champions Group. Templates in, a legally
defensible electronic signature out, and an audit trail we own regardless of
which signing engine sits behind it.

This document is the engineering companion to the ChampPDF Sign DPRD v1.0
(2026-09-09). It records what was built on the `v2` branch, where the build
deliberately departs from the DPRD, what still needs infrastructure, and how
to run the dry run.

## One path, end to end

```
sender (Clerk)            counterparty (no account)                 both parties
  |                            |                                        |
  | POST /api/sign/documents   |                                        |
  |  template + counterparty   |                                        |
  |  -> render PDF, hash it    |                                        |
  |  -> 32-byte link token     |                                        |
  |  -> ChampBeam wrap         |                                        |
  |  -> Resend invitation ---->|                                        |
  |                            | GET /s/<token>       landing, no rights|
  |                            | POST .../otp         6 digits, 10 min  |
  |                            | POST .../otp/verify  -> signer session |
  |                            | GET  .../document.pdf (hash == stored) |
  |                            | POST .../events      scrolled_to_end   |
  |                            | POST .../sign        typed | drawn     |
  |                            |   stamp -> certificate of completion   |
  |                            |   -> PAdES seal -> SHA-256 -> storage  |
  |<---------------------------+-------- sealed PDF attached -----------+
```

Every arrow is an audit event. Each event stores the SHA-256 of the previous
one (`event_hash = sha256(prev_hash || canonical_json(event))`), the table
refuses `UPDATE` and `DELETE` at the database level, and the chain head at
execution is printed on the certificate of completion.

## What shipped (DPRD section 09, block by block)

| #   | Block                                                        | Status                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Documenso deployed, private, service token                   | **Infra, not code.** `docker-compose.sign.yml` brings up an unmodified Documenso on an internal network; the `documenso` adapter is written and unit-tested against mocked HTTP, not yet against a live instance. The default engine is `native` and needs no Documenso at all. |
| 2   | Clerk on the frontend, protect `/sign/*`                     | Done. The repo already had Clerk (`clerk-auth.ts`, `clerk_auth.py`). The console gates on a signed-in session; the backend verifies the JWT and restricts senders by email domain (default `championsmail.com`). Roles `member` / `legal` / `admin` come from verified claims.  |
| 3   | Our schema with the hash-chain trigger, INSERT-only app role | Done, in SQLite (see "Departures"). `sign_documents`, `sign_recipients`, `sign_audit_events`, `sign_rate_hits`.                                                                                                                                                                 |
| 4   | `SigningProvider` interface + Documenso adapter              | Done: `backend/sign/providers/base.py`, `native.py`, `documenso.py`.                                                                                                                                                                                                            |
| 5   | Mutual NDA Master Template v1 loaded                         | Structural body shipped (`mutual-nda-v1`), matching the NDA playbook's positions. **Drop the real Master `.docx` in as `backend/sign/templates/mutual-nda-v1.docx` with `{{placeholders}}` and it takes over automatically.**                                                   |
| 6   | Send flow                                                    | Done: form, preview, token, Beam wrap (graceful fallback), Resend invitation (log mailer when unconfigured).                                                                                                                                                                    |
| 7   | Sign flow                                                    | Done: branded landing, OTP request / verify, pdf.js viewer with scroll gate (enforced server-side too), typed or drawn signature, intent statement, submit.                                                                                                                     |
| 8   | Seal, hash, store, certificate, email both parties           | Done.                                                                                                                                                                                                                                                                           |
| 9   | Dry run + manual chain verification                          | Automated: `backend/tests/test_sign_flow.py` plays the whole path and verifies the chain, the file hash, the seal and the certificate text. A real external-inbox dry run still needs Resend DNS.                                                                               |

Also shipped beyond the list because they cost nothing extra: countersigning
(sequential, data model already carried it), void (links return 410), resend
(rotates the token), delivery / bounce webhooks, a verification endpoint, and
a sender-side audit view.

## Departures from the DPRD, and why

**ChamPDF is already AGPL-3.0.** `package.json` says `AGPL-3.0-only`,
`LICENSE` is the AGPL, and `docs/licensing.md` sells a commercial licence on
top (dual licensing, backed by the CLA). So "copying Documenso code in makes
ChamPDF AGPL" is not the risk. The real risk is narrower and still real:
Documenso's code is not ours to relicense, so pasting it in would break the
commercial-licence offer for whatever it touched. The architecture the DPRD
asks for (engine behind an interface, unmodified, in its own process) is
still the right one; the reason is the dual licence, not contamination.

**Not Next.js.** ChamPDF is a Vite + vanilla TypeScript multi-page app with a
FastAPI backend. Sign follows that: two pages (`sign.html`, the sender
console; `sign-document.html`, the signer page served at `/s/<token>`), one
router (`/api/sign/*`).

**SQLite, not Postgres.** The backend already runs SQLite on a persistent
volume for the API key store. Sign shares that file. The SQL is written to
lift to Postgres with type substitutions only, and the hash chain is computed
in Python, so nothing about the evidence depends on the engine. When the
volume of documents justifies Postgres, move the four tables; nothing else
changes.

**Documenso cannot be "a database, not a product surface".** Its public API
has no way to submit a signature on a recipient's behalf; the signing UI is
Documenso's. The adapter therefore reports `hosted_signing = True` and the
OTP-gated signer page embeds Documenso's per-recipient signing URL after
verification. Our landing, our OTP, our audit chain still wrap it, and the
sealed output is Documenso's. The native engine has none of this tension,
which is why it is the default and why the dry run runs on it.

**Sender allow-list defaults closed.** `champdf.com` sign-up is public, so an
unrestricted "any signed-in user may send" would let any visitor issue NDAs in
Champions' name. `SIGN_SENDER_EMAIL_DOMAINS` defaults to `championsmail.com`.

## Layout

```
backend/sign/
  store.py        schema, hash chain, append-only triggers, shared rate counters
  tokens.py       link tokens, OTPs, signer sessions (all hashed at rest)
  storage.py      write-once objects: local disk, or S3 / R2 when configured
  templates.py    registry, First Schedule block, HTML or .docx -> PDF, anchors
  templates/      mutual-nda-v1.json + .body.html + base.css (+ .docx when Legal drops it in)
  seal.py         seal certificate, PAdES seal via pyHanko, certificate of completion
  providers/      SigningProvider (base.py), native.py, documenso.py
  mailer.py       Resend + log mailer, message templates, webhook verification
  beam.py         ChampBeam wrapper (instrumentation only)
  auth.py         sender identity (Clerk JWT or admin token) and roles
  service.py      the lifecycle
  router.py       /api/sign/*
backend/tests/test_sign_flow.py, test_sign_documenso_adapter.py
src/pages/sign.html + src/js/logic/sign-console-page.ts
src/pages/sign-document.html + src/js/logic/sign-document-page.ts
src/js/utils/sign-api.ts (+ src/tests/sign-api.test.ts)
docker-compose.sign.yml
```

## API

Sender routes take `Authorization: Bearer <Clerk session JWT>` or
`X-Admin-Token: <CHAMPDF_ADMIN_TOKEN>`.

| Method | Path                                | What                                                                                                                                                         |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/sign/status`                  | Feature status (engine, mail, seal, storage, templates). Public.                                                                                             |
| GET    | `/api/sign/templates`               | Approved templates with their merge fields.                                                                                                                  |
| POST   | `/api/sign/documents/preview`       | Filled PDF, nothing created.                                                                                                                                 |
| POST   | `/api/sign/documents`               | Create and send. Body: `template_id`, `fields`, `signer{name,email,designation}`, optional `countersigner`, `cc[]`, `expires_in_days` (1 to 90, default 14). |
| GET    | `/api/sign/documents`               | Yours; all for `admin`.                                                                                                                                      |
| GET    | `/api/sign/documents/{id}`          | Detail, events, chain check.                                                                                                                                 |
| GET    | `/api/sign/documents/{id}/download` | Sealed PDF (or current draft).                                                                                                                               |
| GET    | `/api/sign/documents/{id}/verify`   | Recomputes the chain, rehashes the stored files, checks the PAdES seal.                                                                                      |
| POST   | `/api/sign/documents/{id}/void`     | Links return 410 from then on.                                                                                                                               |
| POST   | `/api/sign/documents/{id}/resend`   | Rotates the link token and resends.                                                                                                                          |
| POST   | `/api/sign/documents/{id}/sync`     | Hosted engines: pull status and the sealed file.                                                                                                             |

Signer routes are public; the 32-byte link token in the path is the
capability, the signer session (`Authorization: Bearer`) is issued by OTP
verification. All responses carry `X-Robots-Tag: noindex`,
`Referrer-Policy: no-referrer`, `Cache-Control: no-store`.

| Method | Path                               | What                                                                                             |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| GET    | `/api/sign/s/{token}`              | Landing: sender, title, expiry, masked address, next step.                                       |
| POST   | `/api/sign/s/{token}/otp`          | Email a six-digit code. 5 per hour per link.                                                     |
| POST   | `/api/sign/s/{token}/otp/verify`   | `{code}` -> 30-minute signer session. 5 attempts, then the link locks and the sender is emailed. |
| GET    | `/api/sign/s/{token}/document.pdf` | The exact bytes hashed at creation. Records `document.viewed`.                                   |
| POST   | `/api/sign/s/{token}/events`       | `{type:"scrolled_to_end"}`; signing is refused without it.                                       |
| POST   | `/api/sign/s/{token}/sign`         | `{kind:"typed"                                                                                   | "drawn", name, designation, intent:true, image_png_b64?}`. |
| GET    | `/api/sign/s/{token}/download`     | Executed PDF.                                                                                    |
| POST   | `/api/sign/webhooks/resend`        | Svix-verified delivery / bounce / complaint -> audit events.                                     |

Limits: 60 page loads per IP per hour, 5 OTP requests per link per hour, 5
attempts per code. Every rejection is an audit event.

## Environment

Everything is optional; with nothing set the spine works locally (log-only
mail, local write-once storage, generated self-signed seal, admin-token
sender). See `backend/.env.example` for the full annotated list.

| Variable                                                                                                                   | Purpose                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_SIGN`                                                                                                              | `false` switches the feature off.                                                                                                |
| `SIGN_PROVIDER`                                                                                                            | `native` (default) or `documenso`.                                                                                               |
| `SIGN_PUBLIC_BASE_URL`                                                                                                     | Origin used in links, e.g. `https://champdf.com`. Defaults to the request origin.                                                |
| `SIGN_ENTITY_NAME`, `SIGN_ENTITY_CIN`, `SIGN_ENTITY_ADDRESS`, `SIGN_ENTITY_SIGNATORY`, `SIGN_ENTITY_SIGNATORY_DESIGNATION` | Contracting entity block. Defaults carry `[CONFIRM: ...]` markers.                                                               |
| `SIGN_SENDER_EMAIL_DOMAINS`                                                                                                | Who may send (Clerk users). Default `championsmail.com`.                                                                         |
| `SIGN_ADMIN_EMAIL`, `SIGN_ADMIN_NAME`                                                                                      | Identity for `X-Admin-Token` senders.                                                                                            |
| `SIGN_SEAL_P12_B64` or `SIGN_SEAL_P12_PATH`, `SIGN_SEAL_P12_PASSWORD`                                                      | Organisation seal certificate. Unset: self-signed, generated once, reported as `seal_self_signed`.                               |
| `SIGN_SEAL_TIMESTAMP`, `PDF_TSA_URL`                                                                                       | RFC 3161 timestamp on the seal (falls back to no timestamp if the TSA is unreachable, and records `seal.timestamp_unavailable`). |
| `RESEND_API_KEY`, `SIGN_EMAIL_FROM`, `SIGN_EMAIL_REPLY_TO`, `RESEND_WEBHOOK_SECRET`                                        | Transactional mail.                                                                                                              |
| `CHAMPBEAM_API_URL`, `CHAMPBEAM_API_TOKEN`                                                                                 | Tracked links. Falls back to the raw link.                                                                                       |
| `SIGN_STORAGE_BUCKET`, `SIGN_STORAGE_PREFIX`, `SIGN_STORAGE_ENDPOINT`, `SIGN_STORAGE_REGION` + AWS credentials             | S3 / R2 storage. Unset: local disk under the data volume.                                                                        |
| `DOCUMENSO_BASE_URL`, `DOCUMENSO_API_TOKEN`                                                                                | Only with `SIGN_PROVIDER=documenso`.                                                                                             |
| `CHAMPDF_DB_PATH`, `CHAMPDF_SIGN_DATA_DIR`                                                                                 | Where the SQLite file and Sign's local artefacts live (`/app/data` volume by default).                                           |

Frontend: `VITE_CLERK_PUBLISHABLE_KEY` (already used by the site) gates the
console; without it the console offers developer mode with the admin token.

## Runbook for the build session

1. **Local spine, no infrastructure.**
   ```bash
   cd backend && pip install -r requirements.txt   # or the Docker image
   export CHAMPDF_ADMIN_TOKEN=dev CHAMPDF_DB_PATH=./data/champdf.db SIGN_SEAL_TIMESTAMP=false
   uvicorn main:app --port 8000
   # in another shell
   VITE_API_URL=http://localhost:8000 npm run dev
   ```
   Open `http://localhost:5173/sign`, paste the admin token, send the mutual
   NDA to yourself. Mail is log-only, so the console shows the signing link
   and the backend log prints the OTP. Open the link, verify, read, sign.
   Download the sealed PDF from the done screen and from the console.
2. **Run the automated dry run.** `pytest backend/tests/test_sign_flow.py -v`.
3. **Resend.** Create `sign.championsmail.com` in Resend, add its SPF, DKIM
   (2048) and DMARC (`p=quarantine`, then `p=reject` after two clean weeks).
   Set `RESEND_API_KEY`, `SIGN_EMAIL_FROM`, and a webhook to
   `/api/sign/webhooks/resend` with `RESEND_WEBHOOK_SECRET`.
4. **Clerk.** The backend needs `CLERK_ISSUER`; the frontend build needs
   `VITE_CLERK_PUBLISHABLE_KEY`. Add a JWT template claim `champdf_sign_role`
   from public metadata to grant `legal` / `admin` (org admins are `admin`
   automatically).
5. **Seal certificate.** Obtain an organisation certificate (or keep the
   self-signed one for internal use), base64 it into `SIGN_SEAL_P12_B64`.
   Until then the console shows a self-signed warning.
6. **Entity block.** `SIGN_ENTITY_CIN` and `SIGN_ENTITY_ADDRESS` (open
   question 1 in the DPRD). Until set, the rendered NDA carries
   `[CONFIRM: ...]` markers that are impossible to miss.
7. **Storage.** Decide R2 or S3 `ap-south-1` (open question 2), set the
   `SIGN_STORAGE_*` variables, enable bucket versioning, deny deletes on the
   `sign/` prefix.
8. **Secrets.** Move the five secrets found in `Other/.secrets/` to the
   platform store and rotate `champdf_sf_signing_key` before the first
   external send. Nothing in this build reads from that folder.
9. **Real external dry run.** Send to a personal non-Champions address, sign
   from a phone, then run `GET /api/sign/documents/{id}/verify` and compare
   the printed chain head and the emailed SHA-256 by hand:
   ```bash
   sha256sum executed.pdf
   sqlite3 /app/data/champdf.db "select content_sha256, chain_head_at_execution from sign_documents where id='...'"
   ```

## Templates

A template is `backend/sign/templates/<id>.json` (fields, roles, schedule
defaults, instrument class) plus `<id>.body.html` (the instrument, with
`{{placeholders}}`). If `<id>.docx` exists beside them, the body is ignored
and the `.docx` is filled with python-docx and converted with LibreOffice,
which is how the canonical Master Template v1 becomes the rendered NDA
without retyping it. Both paths end with the same drawn execution page, which
is where the signature anchors come from.

Placeholders available in a body or `.docx`: every field key (plus
`<key>_long` for dates), `champions_entity`, `champions_cin`,
`champions_address`, `champions_signatory`,
`champions_signatory_designation`, `schedule_<key>` for each schedule
default, `signer_name` / `signer_email` / `signer_designation`
(`countersigner_*` likewise), `template_id`, `template_version`,
`rendered_on`.

A template's SHA-256 (spec + body + css + docx) is recorded on every document.
Changing terms means a new file (`mutual-nda-v2`), never an edit.

Templates whose `instrument_class` is in the IT Act First Schedule
(`negotiable_instrument`, `power_of_attorney`, `trust_deed`, `will`,
`testamentary_disposition`, `immovable_property_conveyance`) are refused at
load time. They cannot be sent because they cannot exist.

## The evidence, and how to check it without us

For any executed document:

1. The certificate of completion (last pages of the sealed PDF) prints the
   SHA-256 of the document as viewed, the audit chain head, and per-signer
   timestamps, IP and user agent.
2. `content_sha256` in `sign_documents` is the hash of the sealed file. The
   file lives in write-once storage; the hash lives in the database. Anyone
   can rehash and compare.
3. `sign_audit_events` can be replayed: for each row in id order,
   `sha256(prev_hash + canonical_json(row))` must equal `event_hash`, and
   `prev_hash` must equal the previous row's `event_hash`
   (`sign.store.verify_chain` does exactly this; `/verify` exposes it).
4. The PAdES seal covers the whole file. pyHanko (`/api/v1/pdf/verify-signature`)
   or any PDF reader reports whether it is intact.

## Deferred (the contract), unchanged from the DPRD

Admin dashboard, Database NDA template, template builder UI, multi-signer
ordering beyond signer + countersigner, SMS OTP, bulk send, ChampMail API
endpoint, reminders. Aadhaar eSign stays a pluggable provider on the same
interface.

## Open questions carried forward

1. Which registered entity signs, and its CIN (`SIGN_ENTITY_*`).
2. R2 or S3 `ap-south-1`.
3. Does Legal want a review gate before the first external send.
4. Retention (seven years assumed; nothing is ever deleted by the application).
5. Authorised countersignatories (the flow supports one per document today).

Not legal advice. Legal should read the rendered NDA and this document before
the first external send.
