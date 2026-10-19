# ChamPDF Sign vs DocuSign: gap analysis

Written 2026-10-01 against `v2-consolidation` (commit `afe40d0`), by reading the
code rather than the marketing. Every "we have it" claim below names the file
that implements it, so a reviewer can check it. Every "we do not" claim is a
statement of absence found by grepping, not an impression.

**Nothing in this document is a compliance claim.** Section 11 says exactly what
is and is not implemented, and Section 12 says what must not be said in sales
material until the missing work is done.

## How to read the gap sizes

| Size       | Meaning                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Large**  | A missing capability that a DocuSign customer uses daily, or a compliance regime we cannot enter without it. Weeks of work, not days. |
| **Medium** | Real gap, bounded work. A few days to a couple of weeks.                                                                              |
| **Small**  | Cosmetic or convenience. Hours.                                                                                                       |

## Summary

ChamPDF Sign is a credible single-template, two-party e-signature engine with an
audit trail that is _better evidenced_ than DocuSign's public posture, and a
deployment model DocuSign cannot match. It is not a DocuSign replacement and
should not be sold as one. It competes for a specific, narrow, valuable slice:
Indian commercial agreements between a known set of counterparties, on
infrastructure the client controls, where the audit trail and data residency
matter more than template variety.

Six capabilities are Large gaps. Four of them are the reason a DocuSign customer
cannot be migrated today.

| Capability                             | Status                                 | Gap                      |
| -------------------------------------- | -------------------------------------- | ------------------------ |
| Upload an arbitrary PDF, sign it       | Only one template ships                | **Large**                |
| Three or more signers, ordered         | Two roles hard-coded                   | **Large**                |
| Bulk send                              | Absent                                 | **Large**                |
| Automated reminders                    | Absent, manual resend only             | **Large**                |
| Identity verification beyond email OTP | Email OTP only                         | **Large**                |
| QES / eIDAS / 21 CFR Part 11 posture   | Not implemented                        | **Large**                |
| Signing order                          | Two roles only                         | Medium                   |
| Template management                    | Registry + flags, no builder           | Medium                   |
| Embedded signing                       | Not implemented                        | Medium                   |
| Branding per tenant                    | Not implemented                        | Medium                   |
| Webhooks                               | Resend only, no outbound               | Medium                   |
| Audit trail                            | **Exceeds DocuSign's public evidence** | None, it is the strength |
| PAdES sealing                          | Implemented and tested                 | None                     |
| Data residency / self-host             | Implemented                            | None, it is the strength |
| Public REST API                        | Implemented with scoped keys           | Small                    |

---

## 1. Envelope and multi-signer flows

**What exists.** One document concept (`sign_documents`), one signing order,
two roles. `mutual-nda-v1` declares exactly `signer` (counterparty) and
`countersigner` (Champions) in `backend/sign/templates/mutual-nda-v1.json`, and
`templates.py` requires a template to declare at least one `signer` role.
Execution fires when the last signer in the chain has signed
(`service.py:_finalize_executed`). Sequential countersigning is implemented and
tested: `test_countersigner_sequential_flow`.

**What is missing.** DocuSign envelopes are a container for N documents with M
recipients in arbitrary routing order. ChamPDF has no envelope object at all. A
document is the envelope. Consequences:

- No parallel routing. Every signer waits for the previous one. DocuSign's
  default for independent signers is simultaneous.
- No role routing conditions (sign here if amount > X, else skip).
- No carbon-copy distribution at completion; `cc` exists as a recipient role but
  is excluded from the certificate of completion.
- No "any one signer may sign" (quorum) mode.
- No group signing, where 3 of 5 directors must sign.

**Gap: Large.** Envelopes are the central abstraction of the category. Their
absence is the single biggest structural difference.

**Cost to close.** Two to four weeks. The `sign_documents` row becomes an
envelope id, `sign_recipients` gains `signing_order` (already present) and
`routing_rule`, and the execution trigger becomes "quorum satisfied" rather than
"last role signed". The sequential path already works, so this is extension
rather than rewrite.

## 2. Signing order

**What exists.** `signing_order` on recipients, enforced in
`service.py:_next_step`, which returns `otp`, `view`, `sign`, `wait` or `done`
based on each recipient's position.

**What is missing.** Fixed roles per template rather than free ordering. A
template declares `signer` and `countersigner`; it does not declare "A then B
then C". Adding a third party means editing the template's role list, which
means the signature anchors in the HTML body have to be laid out for it.

**Gap: Medium**, but it is coupled to Section 1: this becomes Large once
envelopes exist, because routing order is a property of the envelope.

## 3. Templates

**What exists.** A file-backed template registry
(`backend/sign/templates/`): a JSON spec (fields, roles, schedule defaults) plus
an HTML body and a CSS file. Merge fields are declared with types, required
flags, `max_length`, placeholders and help text, and are validated on send
(`templates.validate_merge_fields`). Templates have per-template versioning with
a recorded `template_sha256`, and admin-controlled availability flags
(`/admin/templates/{id}/activate|deactivate`) so a template can be withdrawn
without a deploy. Templates are rendered to PDF with PyMuPDF and each role's
signature anchor rectangle is computed at render time.

**This is genuinely good.** Version-pinned templates with a hash of the template
itself, plus legal-controlled activation, is better governance than DocuSign
offers out of the box, and it is what makes the executed PDF defensible years
later.

**What is missing.**

- **One template ships.** `mutual-nda-v1`. The Database NDA that the template's
  own description promises as "phase 2" does not exist.
- **No template builder.** Building a template means writing JSON and HTML and
  deploying. The admin portal can activate and deactivate, not author. DocuSign
  users create templates without engineering.
- **No drag-and-drop field placement.** Anchors are computed from the HTML
  layout (`_stamp_sync` reads `rect`, `name_pos`, `designation_pos`,
  `date_pos` from the renderer), which is why a role change requires a code
  change rather than a UI change.
- **No reusable template library or folder structure.**
- **No conditional fields, calculated fields, or field-level validation rules**
  beyond type and length.
- **No localisable template text.** Field labels and help text are English-only
  in the spec. The surrounding site is translated into 11 languages
  (`public/locales`); a counterparty in Germany or Vietnam gets an English
  document and an English console.

**Gap: Large** for competitive parity, **Medium** if the business only ever
sends NDAs from a fixed legal set. Recommendation: template authoring is the
highest-leverage Medium-to-Large item after envelopes, because it is what turns
the product from "we can do this one document" into "we can do yours".

## 4. Bulk send

**What is absent.** No CSV upload, no batch send, no bulk status roll-up, no
per-row error reporting. `POST /documents` handles one document.

**Gap: Large.** This is the standard DocuSign "send to 200 employees" workflow
and its absence disqualifies us for any internal or onboarding use case. A law
firm distributing an engagement letter to fifty clients, or a company pushing
policy acknowledgements to staff, cannot use this product at all today.

**Cost to close.** Two to three weeks on top of envelopes: a CSV endpoint,
per-row document creation reusing `create_and_send`, a job table, and a result
export. The heavy lifting (per-document state, audit chain, Resend delivery with
idempotency) already exists and is reusable.

## 5. Embedded signing

**What is absent.** No embedded signing, no signature widget, no iframe ceremony,
no REST-embedded flow. The only way to sign is a link emailed to the recipient,
which the recipient opens in a browser.

**What exists instead.** `/sign.html`, `/sign-document.html` and
`src/js/utils/sign-api.ts` are a clean, embeddable-by-hand JS client, but there
is no supported embedded ceremony or its lifecycle (create recipient view, wait
for completion, receive the signed document by webhook or redirect). The signer
page is deliberately excluded from the i18n build (`I18N_EXCLUDE` in
`scripts/generate-i18n-pages.mjs`) and served only at `/s/<token>`.

**Gap: Medium.** Important for anyone wanting signing inside their own product.
Not a blocker for the NDA use case.

## 6. Audit trail

**This is the strength, and it should be the headline.**

What exists, and is now tested by 12 dedicated tamper tests in
`backend/tests/test_audit_chain.py`:

- An append-only event table (`sign_audit_events`) protected at the database
  level by `BEFORE UPDATE` and `BEFORE DELETE` triggers that `RAISE(ABORT)`. Not
  an application convention: a direct `sqlite3` connection cannot edit or delete
  a row.
- Every event hash-chained: `event_hash = sha256(prev_hash || canonical_json(event))`
  over a fixed field list with sorted keys, so the hash does not depend on dict
  ordering.
- Tamper detection covering edited actor, edited IP, edited metadata, deleted
  middle event, deleted tail, reordered rows and a fully relinked chain.
- **An execution anchor.** `chain_head_at_execution` is written at execution onto
  the document row and printed into the certificate of completion inside the
  executed PDF. `store.verify_anchor()` requires that recorded head to still be
  the parent link of `document.executed`, and `GET /documents/{id}/verify` fails
  when it is not.

That last point matters and is worth stating precisely: row-level hash
verification alone cannot tell "untouched" from "rewritten and rehashed", because
both are internally consistent. The anchor closes that, because it also exists
in the PDF the counterparty holds. This is a stronger artefact than DocuSign's
public Certificate of Completion, which is a PDF report rather than a value
cryptographically bound into the signed file.

`GET /api/sign/documents/{id}/verify` returns chain status, anchor status, draft
hash, sealed hash and pyHanko signature validity in one call. Both parties can
run it without our cooperation.

**Gap: none. This is the differentiator.** The one thing to fix is that
verification currently requires sender or admin auth; a public, unauthenticated
verification endpoint keyed only on the document id and the anchor hash would let
a counterparty verify independently, which is the whole point of having an
anchor.

## 7. Identity verification

**What exists.** Recipients are verified by a six-digit code emailed to the exact
address on the record. Codes are hashed (`tokens.hash_otp`), expire
(`OTP_TTL_SECONDS`), are attempt-limited (five failures, then the link locks and
the sender is notified), and are request-rate-limited per hour. A signer session
token is issued after verification and required for the PDF, the signature and
the download. Links are per-recipient random tokens stored as hashes.

This is a reasonable email-based identity proof and it is well engineered. For
signing authority it is, however, weak: proving control of an inbox is not
proving the person is authorised to bind the entity.

**What is missing.**

- No ID document verification of any kind.
- No liveness or selfie check.
- No qualified electronic signature (QES) and no non-qualified certificate.
- No Aadhaar eSign, though `SigningProvider` is an interface and the design
  notes already flag Aadhaar as pluggable.
- No signatory-authority check. Nothing verifies that Jane Doe is a director of
  Acme, or that an authorised signatory list has been respected. There is no
  "authorised countersignatories" mechanism at all; the flow's own docs list
  this as an open question.
- No sanctions/PEP screening.

**Gap: Large.** Email OTP plus an OTP lockout is appropriate for a low-value
agreement. It is not sufficient for a bank-grade or regulated counterparty, and
it should not be described as identity verification.

## 8. Reminders and expiry

**What exists.** Per-document expiry (`expires_in_days`, default 14), enforced on
every access, with `_expire_due()` sweeping overdue documents and writing a
`document.expired` event. Manual resend: `POST /documents/{id}/resend` rotates
the link token, invalidates the old one, writes `token.rotated` and re-mails.
The admin portal has a **Needs resend** tab that lists every send-out still
awaiting a signature, with the recipient's IP and geo resolved via MaxMind
(`backend/sign/geoip.py`).

**What is missing.**

- **No automatic reminders.** Nothing is scheduled. A signer who ignores the
  first email stays ignored until a human opens the portal and clicks resend.
  The repo's own README concedes the "scheduler itself is still manual".
- No configurable reminder cadence, no reminder escalation to the sender, no
  reminder opt-out.
- No automatic extension request near expiry.
- No scheduled expiry sweep of its own: `_expire_due()` only runs when a request
  arrives, so a document nobody touches stays `sent` in the database until
  someone looks, even though every access correctly 410s.

**Gap: Large.** In the DocuSign comparison this is the most visible functional
difference to an end user: with DocuSign, chasing an unsigned contract is a
setting; with ChamPDF it is a human task.

**Cost to close.** One day for a periodic job (`_expire_due` is already written)
plus a reminder policy table and a new `reminder.sent` event. Cheap, high value.
Recommend this as the next feature after envelopes.

## 9. API and webhooks

**What exists.** A versioned REST API at `/api/sign/*` with Clerk-issued bearer
tokens, role checks (`member`, `legal`, `admin`), and ownership enforcement on
every document read. A separate v1 API at `/api/v1` with scoped API keys
(`KNOWN_SCOPES`, hierarchical, `*` for full access) covering PDF operations. A
curated Postman collection under `postman/`. OpenAPI fixed for client import.
Inbound Resend webhooks with full Svix signature verification, and, as of this
branch, deduplication on the provider message id so a Resend retry cannot append
a duplicate audit event.

**What is missing.**

- **No outbound webhooks.** There is no "notify this URL when X happens". A
  customer integrating ChamPDF has to poll. DocuSign Connect has had this for a
  decade and it is the backbone of most integrations.
- No event-stream or pagination contract on the document list endpoints.
- No SDKs. No official Python, Node or .NET client.
- No sandbox/self-serve developer onboarding: no way to get a test account and
  run a signing end to end without an admin provisioning you.
- No rate-limit headers, no idempotency keys on the API itself (Resend _sending_
  now has one; `POST /documents` does not, so a retried create makes two
  documents).
- No API versioning policy. `/api/sign` and `/api/v1` coexist with no stated
  deprecation discipline.

**Gap: Medium**, and the single most-requested item in practice. Outbound
webhooks are the highest-value API addition: the audit events are already rich
and correctly named, so publishing them is mostly plumbing.

## 10. Branding

**What exists.** Email and page styling is hard-coded to Champions brand
(`_BRAND = "#FF6B35"`, "Champions Superior Capital" as the signing entity,
`SIGN_EMAIL_FROM`). The certificate of completion is branded ChampPDF Sign and
cites s.3A / s.10A of the Indian IT Act 2000. Admin auth is a shared token or a
Clerk session; there is no tenant model.

**What is missing.**

- No per-tenant or per-brand theming of email, signer page or certificate.
- No customer logo on the signing page or the certificate.
- No white-label domain or custom domain for the signing experience.
- No tenant concept at all: one entity, one template registry, one admin.
- No custom certificate of completion text.

**Gap: Medium.** This is the gap that most directly blocks resale. Champions can
use this internally; a law firm cannot put its own name on it.

## 11. Compliance posture, stated precisely

This section exists to prevent a sales claim that cannot be defended.

**What is true.**

- The executed file carries a real PAdES signature applied by pyHanko
  (`seal.py:seal_pdf_sync`), verified independently by `verify_seal_sync`, and
  covered by a test that appends a page after sealing and asserts the seal stops
  validating.
- The audit trail is append-only at the database level, hash-chained, and
  anchored into the executed PDF, as Section 6 sets out.
- Every signing event records IP address, user agent, timestamp, actor email and
  the OTP verification, and the certificate of completion enumerates them.
- The audit trail records who signed, from where, when, and which exact bytes
  each party viewed (`draft_sha256`), with the hash of the final sealed file.
- There is an integrity verification endpoint a counterparty can run.

**What is NOT true, and must not be claimed.**

- **No eIDAS.** There is no Qualified Electronic Signature, no Qualified Trust
  Service Provider, no EU trust list, no conformance claim of any kind. An eIDAS
  QES requires a QTSP and a qualified certificate; neither exists here.
- **No 21 CFR Part 11.** Part 11 requires validated systems, electronic
  signatures per 11.100, audit trails per 11.10(e), and a documented
  validation package. This is a self-hosted application with no validation
  evidence, no SOPs, no access controls beyond a shared admin token, and no
  21 CFR Part 11 audit-trail review. **Not compliant. Do not say otherwise.**
- **No ESIGN Act "validity" position beyond the general one.** The IT Act 2000
  s.3A / s.10A reference in the certificate is the Indian equivalent of ESIGN
  s.5, and it supports admissibility of electronic records; it is not a
  certification that the signature is qualified or that the consent was
  unambiguous by every measure a court would apply.
- **No qualified trust service, no external timestamp by default.**
  `SIGN_SEAL_TIMESTAMP=true` is the default and depends on `PDF_TSA_URL` being
  reachable; when the TSA is unavailable the seal is applied without a timestamp
  and the degradation is recorded (`timestamp_unavailable` event and a note).
  A document sealed without a timestamp has a weaker long-term evidentiary
  position, and the system records that honestly rather than hiding it.
- **The seal certificate is self-signed by default.** `seal.py` generates a
  self-signed certificate when `SIGN_SEAL_P12_B64` / `SIGN_SEAL_P12_PATH` are
  unset, and reports `self_signed: true`. A self-signed certificate proves the
  document has not changed since sealing; it does not prove who holds the key.
  This is stated in the code and in the status endpoint, and it must stay that
  way in any customer-facing description.
- **No GDPR posture**: no data-processing agreement, no retention enforcement
  (the README notes "nothing is ever deleted by the application"), no data
  subject handling for the IP addresses and user agents recorded in the audit
  trail. Those are personal data.
- **No SOC 2, ISO 27001 or penetration test** on record.

**Gap: Large** and, for eIDAS and Part 11, not closeable by engineering alone.
eIDAS QES requires becoming or partnering with a QTSP. Part 11 requires a
validation programme. Both are business decisions before they are code.

## 12. What we can honestly say, and to whom

**Defensible today, in these words:**

> ChampPDF Sign executes mutual NDAs and similar commercial agreements on
> infrastructure you control. Every signature is sealed into the PDF with a
> PAdES signature, and every step is recorded in an append-only, hash-chained
> audit log whose head is printed into a certificate of completion inside the
> file itself. Either party can verify the chain, the document hash and the seal
> without contacting us.

**Target buyer, honestly scoped.** Indian SMEs and mid-market firms whose
counterparties are also Indian firms, signing low-to-medium-value commercial
agreements from a fixed legal template set, where data residency and auditability
matter more than template variety. That is a real market and we can win it.

**Not for, today:**

- Regulated industries needing 21 CFR Part 11 or eIDAS.
- Bulk distribution to many recipients.
- Anything needing more than two signers, or parallel routing.
- White-label resale.
- European public-sector or eIDAS-dependent procurement.

## 13. Recommended order of work

Sequenced by gap closed per unit of effort, not by size.

| #   | Item                                               | Why first                                                                                                  |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | **Automated reminders + a scheduled expiry sweep** | One day of work, closes a Large gap, `_expire_due()` already written                                       |
| 2   | **Outbound webhooks**                              | Turns the audit trail into an integration surface; events are already named and tested                     |
| 3   | **Template authoring UI**                          | Makes the product usable for documents we did not anticipate                                               |
| 4   | **Public verification endpoint**                   | Zero new surface, and it makes the anchor claim checkable by the counterparty, which is the whole argument |
| 5   | **Envelopes and free routing order**               | The structural gap; expensive, so do it once the above prove the workflow                                  |
| 6   | **Bulk send**                                      | Depends on 5                                                                                               |
| 7   | **Multi-tenant branding**                          | Required before any resale motion                                                                          |
| 8   | **Identity verification options**                  | Business decision: Aadhaar eSign, or a commercial ID vendor                                                |
| 9   | **Buy, partner or abandon eIDAS / Part 11**        | Not an engineering task. Decide explicitly rather than drifting                                            |

## Appendix: how each claim was checked

| Claim                    | How                                                                            |
| ------------------------ | ------------------------------------------------------------------------------ |
| Two roles only           | `backend/sign/templates/mutual-nda-v1.json` roles array                        |
| One template ships       | `ls backend/sign/templates/` returns `base.css`, one `.body.html`, one `.json` |
| Append-only triggers     | `backend/sign/store.py` `sign_audit_no_update` / `sign_audit_no_delete`        |
| Chain hashing            | `store.compute_event_hash`, `store.canonical_json`                             |
| Anchor enforced          | `store.verify_anchor`, `service.verify`, `test_seal_anchor.py`                 |
| PAdES seal               | `seal.seal_pdf_sync`, `seal.verify_seal_sync`, `test_seal_anchor.py`           |
| Self-signed default      | `seal.load_seal`, `seal_info()["self_signed"]`                                 |
| Reminders absent         | no scheduler, cron, or reminder code anywhere in `backend/sign/`               |
| Bulk send absent         | no CSV, batch or bulk endpoint in `backend/sign/router.py`                     |
| Outbound webhooks absent | the only `@router.post("/webhooks/...")` is the inbound Resend endpoint        |
| Embedded signing absent  | only `/s/{token}` routes exist for the signer                                  |
| Envelope absent          | no envelope entity in `store.py` schema; `sign_documents` is the container     |
| No 21 CFR / eIDAS code   | no references in the repository                                                |
