# ChamPDF v2 consolidation report

**Branch:** `v2-consolidation`
**Base:** `origin/main` @ `0ea2cf6`
**Head at time of writing:** `3f09185`
**Diff vs `main`:** 79 files changed, 19,715 insertions, 3,589 deletions, 14 commits
**Date:** 2026-10-01
**Node:** v24.13.1 · **Python:** 3.13.9 (CI targets 3.11)

Nothing was merged to `main`. No branch was deleted. No PR was closed.

---

## 0. The baseline was already red. Read this before attributing anything.

**ChamPDF's CI on `main` was broken before this branch existed.** It was a
dependency-resolution failure, not a code failure, and this branch did not
introduce it.

The chain:

1. A Dependabot PR bumped `typescript` to `7.0.2` and landed on `main`.
2. `typescript-eslint@8.70.0` declares `peerDependencies.typescript` as
   `">=4.8.4 <6.1.0"`. TypeScript 7 is outside that range.
3. `npm install` and `npm ci` both abort with `ERESOLVE` at the repository root.
4. `build-and-publish.yml` and `static.yml` both begin with `npm ci`. Every
   workflow therefore failed before reaching a single line of its own logic.

Reproduced on a clean checkout of `origin/main`:

```
$ npm install
npm error code ERESOLVE
npm error ERESOLVE could not resolve
npm error While resolving: typescript-eslint@8.70.0
npm error Found: typescript@7.0.2
npm error Could not resolve dependency:
npm error peer typescript@">=4.8.4 <6.1.0" from typescript-eslint@8.70.0
```

The four workflows were decorative: a green count, zero signal. The most recent
Dependabot run failed on 2026-10-01 after 4m47s, which matches this exactly.

**A second red was hidden behind the first.** With the peer conflict worked
around, `npm run build` still failed, this time with
`FATAL ERROR: Ineffective mark-compacts near heap limit` in
`scripts/generate-i18n-pages.mjs`. Neither had ever passed.

---

## 1. Test results, real output

Every command below was run on this branch. Nothing is estimated.

### 1.1 Frontend

```
$ npm ci
exit=0
added 1229 packages, and audited 1230 packages in 30s

$ npx tsc --noEmit
exit=0
(no output)

$ npx vitest run
 Test Files  8 passed (8)
      Tests  240 passed (240)
   Duration  5.10s

$ HUSKY=0 npm run build
build exit=0
✅ Sitemap generated with 1430 URLs (130 pages × 11 languages)
```

### 1.2 Backend

```
$ python -m pytest backend/tests/ -q
130 passed, 3 skipped, 53 warnings in 5.26s
```

Baseline for comparison, on `feat/admin-portal-ip-resend` before any of this
work: **81 passed, 3 skipped**. Now: **130 passed, 3 skipped**, across three new
test modules.

### 1.3 What was actually wrong, and what was fixed

The `npm ci` pin was necessary but not sufficient. Four distinct defects sat
behind it, three of which were pre-existing on `main`:

| Defect                                                                                                                                                  | Pre-existing?  | Fix                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------- |
| `typescript@7.0.2` outside the `typescript-eslint` peer range                                                                                           | Yes, on `main` | Pinned to `~6.0.3`                                                        |
| `cropperjs` bumped 1.6.1 → 2.2.0, a full API rewrite; the crop pages still call `getData` / `getImageData` / `setData`                                  | Yes, on `main` | Pinned back to `^1.6.1`                                                   |
| `markdown-it` 14 → 15; the stale `@types/markdown-it@14` stub shadows the real types, and `markdown-it-anchor@10` types `permalink` as a generator only | Yes, on `main` | Dropped the stub, imported the instance type by name, omitted `permalink` |
| `generate-i18n-pages.mjs` leaks one JSDOM window per (page × language), about 1300, and OOMs at the 4GB cap                                             | Yes, on `main` | `dom.window.close()` after each serialize                                 |

The cropperjs one matters most, because it was not only a type error. Cropperjs
2.x reduced `CropperOptions` to `{container, template}`. `viewMode`,
`autoCropArea`, `rotatable` and `zoomable` no longer exist, and neither do
`getData`, `getImageData` or `setData`. The crop PDF tool was calling methods
that the installed library does not have. That is a runtime break that would have
shipped.

### 1.4 Why the TypeScript version is `~6.0.3`

`~6.0.3` is the highest TypeScript that satisfies the peer range and still
cannot cross `6.1.0`:

- `~6.0.3` resolves to `>=6.0.3 <6.1.0`. The tilde bounds the minor, so
  Dependabot can never propose a TypeScript outside the peer range on this line.
- `5.9.3` also satisfies the peer range but does not build: the repo's
  `tsconfig.json` sets `"ignoreDeprecations": "6.0"`, which TypeScript 5 rejects
  with `TS5103: Invalid value for '--ignoreDeprecations'`. The repo is written
  against the TS 6 line.
- `6.0.3` was verified: `npm ci`, `tsc --noEmit` and `npm run build` all exit 0.

**Do not widen this range without checking the peer range first.**

---

## 2. Coverage

### 2.1 Backend, the sign layer — measured

```
$ python -m coverage run --source=backend/sign -m pytest backend/tests/ -q
$ python -m coverage report --include="backend/sign/*"
```

| Module                   | Stmts    | Cover   | Was              |
| ------------------------ | -------- | ------- | ---------------- |
| `__init__.py`            | 0        | 100%    |                  |
| `admin.py`               | 86       | **93%** |                  |
| `auth.py`                | 82       | **62%** |                  |
| `beam.py`                | 49       | **94%** |                  |
| `geoip.py`               | 121      | **73%** |                  |
| `mailer.py`              | 153      | **96%** |                  |
| `providers/__init__.py`  | 24       | **88%** |                  |
| `providers/base.py`      | 67       | **96%** |                  |
| `providers/documenso.py` | 105      | **73%** |                  |
| `providers/native.py`    | 113      | **81%** |                  |
| `router.py`              | 219      | **94%** |                  |
| `seal.py`                | 235      | **89%** |                  |
| `service.py`             | 629      | **83%** |                  |
| `storage.py`             | 99       | **84%** | **61%**          |
| `store.py`               | 294      | **89%** |                  |
| `templates.py`           | 284      | **83%** |                  |
| `tokens.py`              | 26       | **96%** |                  |
| **TOTAL**                | **2586** | **85%** | 85%, storage 61% |

Method: `coverage.py` line coverage over `backend/sign`, measured with the full
pytest suite. `storage.py` rose from 61% to 84% because of the new test module.

Still thin, and honestly so: `auth.py` at 62% (Clerk JWT verification needs real
JWKS material, so 31 lines are unexercised), `geoip.py` at 73% (needs a MaxMind
`.mmdb`), `documenso.py` at 73% (needs the hosted engine).

### 2.2 Frontend — measured, and the number is bad

```
$ npx vitest run --coverage
 Test Files  8 passed (8)
      Tests  240 passed (240)

Statements   : 26.23% ( 282/1075 )
Branches     : 20.77% ( 124/597 )
Functions    : 27.01% ( 47/174 )
Lines        : 26.6% ( 265/996 )
```

v8 coverage via the existing `@vitest/coverage-v8`. Two things to be clear about:

1. **The repo's own 80% thresholds fail.** `vitest.config.ts` sets lines,
   functions, branches and statements all to 80, and `npm run test:coverage`
   exits non-zero on all four. That script has never been green.
2. **26% is a floor, not a ceiling.** The 1075 statements are what the eight test
   files _import_. `src/` is 267 TypeScript files and about 64,600 lines; the
   instrumented surface is a fraction of it. The real figure across all of `src`
   is well below 26%.

Per-module, from the same run:

| Module                     | Lines  | Note                                |
| -------------------------- | ------ | ----------------------------------- |
| `js/utils/pdf-to-docx.ts`  | 87.15% | The one well-tested module          |
| `js/utils/sign-api.ts`     | 31.74% | The Sign API client, barely touched |
| `js/utils/helpers.ts`      | 26.92% |                                     |
| `js/config/tools.ts`       | 50%    |                                     |
| `js/i18n/i18n.ts`          | 9.18%  |                                     |
| `js/animations/*`          | 5.68%  | 0% on two files                     |
| `js/utils/render-utils.ts` | 1.55%  | 327 uncovered lines                 |
| `js/ui.ts`                 | 4.68%  |                                     |

### 2.3 What is claimed but not tested

- **The signer ceremony UI.** `sign-document.html` and
  `sign-console-page.ts` are 711 and 659 lines of signer-facing logic with no
  frontend test. `sign-api.ts` is at 31.74%. The backend is well tested; the page
  that drives it is not.
- **Every one of the 141 modules in `src/js/logic/`** except `pdf-to-docx`.
- **The Documenso provider** beyond its adapter test.
- **Clerk authentication** end to end. `auth.py` at 62%.
- **Anything requiring live infra**: S3, MaxMind, Clerk JWKS, a real Resend send.

---

## 3. What was added, and what it found

Three new backend test modules, 47 new tests. Every behavioural change below was
written test-first and verified RED.

### 3.1 `backend/tests/test_audit_chain.py` — 12 tests

The hash chain is the product. These attack it as an attacker with write access
to the SQLite file would: drop the append-only triggers, then mutate.

| Attack                           | Result                                        |
| -------------------------------- | --------------------------------------------- |
| Edit `actor_email`               | caught, names the event                       |
| Edit `ip_address`                | caught                                        |
| Edit event `metadata`            | caught                                        |
| Delete a middle event            | caught, `prev_hash` mismatch at the successor |
| Delete the last event            | chain reports 3 events instead of 4           |
| Reorder rows                     | caught, `prev_hash` mismatch                  |
| Relink every hash after an edit  | row-level check passes; the anchor catches it |
| Update / delete at the SQL level | refused by the triggers                       |
| Unknown event type               | `ValueError`                                  |
| Cross-document linking           | chains are independent                        |
| Dict key-order dependence        | `canonical_json` is order-independent         |

### 3.2 `backend/tests/test_seal_anchor.py` — 2 tests, and a real hole

**Found a genuine defect.** `GET /documents/{id}/verify` returned
`chain_head_at_execution` but never compared it to anything, and `report["ok"]`
did not consider it. An attacker who edited one audit row and recomputed every
subsequent hash got `ok: true`, because a rewritten chain is internally
consistent.

That is precisely the attack the anchor exists to stop, and it was not wired up.

Fix: `store.verify_anchor(document_id, recorded_head)` requires the recorded head
to still be the parent link of `document.executed`, and `report["ok"]` now
depends on it. Note the anchor is a _prefix_ anchor: it is captured before
`document.executed` is appended, so the correct check is that the chain still
extends it at that event, not that the live head equals it. Verified RED: with
the check removed, the test fails on `KeyError: 'anchor'`.

The second test seals a real PDF with pyHanko, appends a page afterwards, and
asserts the seal stops validating.

### 3.3 `backend/tests/test_resend_delivery.py` — 23 tests

Idempotency (4), retry semantics (2), Svix signature verification (12), webhook
endpoint behaviour (7). Details in section 5.

### 3.4 `backend/tests/test_storage.py` — 12 tests

The S3 path had no test at all, at 61% coverage. Sealed PDFs are the product and
in production they go to S3 or R2. Now pinned with a fake boto3 client: round
trip, prefix, write-once refusal, the `IfNoneMatch` fallback, key traversal
refusal, and a new `MAX_KEY_LEN` bound (S3 caps keys at 1024 bytes and returns
an opaque error past it).

Fixed while testing: `S3Storage.get` let botocore's `ClientError` escape raw,
while every caller in `service.verify` and the download path catches
`StorageError`. A missing object became an unhandled 500 with a stack trace.

### 3.5 `src/tests/i18n-pages-memory.test.ts` — 2 tests

The OOM fix is pinned by running the real script under a 384MB heap: green with
`close()`, `Ineffective mark-compacts near heap limit` without. Measured on this
fixture, not guessed.

---

## 4. DocuSign gap analysis

Full document: **`docs/DOCUSIGN-GAP-ANALYSIS.md`**. Written by reading the code,
not the marketing. Every claim names the file that backs it, and an appendix
lists how each was checked.

Headline, stated honestly:

ChamPDF Sign is a credible single-template, two-party engine whose audit trail
is **better evidenced than DocuSign's public posture**, on infrastructure
DocuSign cannot match. It is not a DocuSign replacement and must not be sold as
one.

| Capability                             | Status                       | Gap                |
| -------------------------------------- | ---------------------------- | ------------------ |
| Upload an arbitrary PDF                | One template ships           | **Large**          |
| Three or more signers, free routing    | Two roles hard-coded         | **Large**          |
| Bulk send                              | Absent                       | **Large**          |
| Automated reminders                    | Manual resend only           | **Large**          |
| Identity verification beyond email OTP | OTP only                     | **Large**          |
| eIDAS / 21 CFR Part 11 posture         | Not implemented              | **Large**          |
| Signing order                          | Two roles                    | Medium             |
| Template management                    | Registry + flags, no builder | Medium             |
| Embedded signing                       | Absent                       | Medium             |
| Branding per tenant                    | Absent                       | Medium             |
| Outbound webhooks                      | Resend inbound only          | Medium             |
| Audit trail                            | **Exceeds DocuSign**         | None, the strength |
| PAdES sealing                          | Implemented and tested       | None               |
| Data residency                         | Self-hosted                  | None, the strength |
| Public REST API                        | Scoped keys                  | Small              |

**Compliance, stated precisely so nobody over-claims it.** True: PAdES signing
via pyHanko, append-only hash-chained audit trail anchored into the executed
PDF, per-event IP and user agent, and an independent verification endpoint.
**Not true:** no eIDAS (no QES, no QTSP, no trust list), **no 21 CFR Part 11**
(no validation package, no SOPs, shared admin token, no Part 11 audit-trail
review), no GDPR posture (IP addresses and user agents in the audit trail are
personal data, with no DPA and no retention enforcement), no SOC 2 or ISO 27001.
The seal certificate is **self-signed by default**, which proves the file is
unaltered, not who holds the key. The system reports `self_signed: true` and
that must survive into any customer-facing description.

Recommended order, by gap closed per unit of effort: automated reminders (one
day, `_expire_due()` is already written) → outbound webhooks → template
authoring UI → public verification endpoint → envelopes → bulk send → multi-tenant
branding → identity verification options. And decide explicitly on eIDAS and
Part 11 rather than drifting: those are business decisions, not engineering tasks.

---

## 5. Resend: what exists, what was broken, what changed

### 5.1 What already existed

Resend was already wired end to end. Findings from grepping and reading:

- **Sending**: `backend/sign/mailer.py`, `ResendMailer`, plain `urllib`, no SDK.
  Selected by `RESEND_API_KEY`, falling back to `LogMailer` (the dry run the
  tests read OTPs from). Dedicated transactional subdomain, never cold-outbound
  infrastructure.
- **Signing-request email**: yes. `invitation_email()` with a tracked link, a
  plain-text fallback, and reply-to set to the sender.
- **OTP**: yes. `otp_email()`, hashed codes, TTL, five-attempt lockout with a
  notification to the sender.
- **Executed documents**: yes. `executed_email()` attaches the sealed PDF and
  prints its SHA-256.
- **Webhooks**: yes. `POST /api/sign/webhooks/resend`, Svix signature
  verification, delivery / bounce / complaint mapped to audit events.
- PR #82 (`feat/admin-portal-ip-resend`) turned out to be about ChampBeam tracked
  links and invitation-email polish, not about Resend itself. Both it and
  `feature/treg-clerk-resend` are absorbed.

**So: yes to sending, yes to signing requests, yes to the OTP. Nothing was
missing at the wiring level.** What was missing was reliability.

### 5.2 Three real defects, all closed test-first

**1. No idempotency.** A send that timed out after Resend had already accepted it,
then retried, delivered a second copy of a signing invitation, or a second OTP.
Two live OTP codes and two copies in the recipient's inbox destroys confidence in
the whole audit trail.

Fix: `mailer.idempotency_key()` derives a stable key from the message's identity
(kind, document, recipient, recipient list, subject, body), never from the clock,
and `ResendMailer` sends it as `Idempotency-Key`. Resend collapses a repeated key
onto the original message. An OTP resend carries a new code, so it correctly gets
a new key and _does_ go out. Verified RED: with the header removed, the test fails.

**2. No retry.** A single 502 or dropped connection lost the mail, and a signing
invitation that does not arrive is a contract that does not happen.

Fix: retry twice with exponential backoff on 408 / 409 / 425 / 429 / 5xx and on
connection errors. A 4xx is our own malformed request and is raised immediately
rather than burning quota and retrying something that can never succeed.
`MailError` gained a `retryable` flag. All four call sites already caught
`MailError` and logged, so behaviour there is unchanged. Verified RED.

**3. Webhook duplicates.** Resend retries webhooks, and every retry appended
another audit event. One delivery inflated the hash chain and read as repeated
failures.

Fix: `store.webhook_seen()` claims the row with `INSERT OR IGNORE` on
`(provider, message_id, event_type)`; `cur.rowcount == 0` means a retry. The
router returns `{"recorded": false, "duplicate": true}`. Different event types for
the same message (delivered, then bounced) are still both recorded, because they
are two real facts. The insert is the check, so two concurrent retries cannot
both win. Verified RED.

### 5.3 Webhook verification: already correct, now pinned

Worth stating plainly: the existing `verify_resend_webhook` was **already
correct**. HMAC-SHA256 over `id.timestamp.body` with the base64-decoded secret,
300-second tolerance, `hmac.compare_digest`, fail-closed on a missing secret.
That is the right implementation and there was no need to change it.

What was missing was proof. 12 tests now pin it: tampered body, forged signature,
wrong message id, absent signature, empty message id, stale timestamp (and that
`tolerance_s` is a parameter), future timestamp, unconfigured secret, malformed
base64 secret, uppercase header names, unsigned request (401), and no secret
configured (503, fail closed).

One behavioural note: the endpoint fails closed with 503 when
`RESEND_WEBHOOK_SECRET` is unset, rather than accepting unverifiable events.
That is correct and should not be made permissive.

### 5.4 Not changed, deliberately

- **No SDK.** `urllib` with no dependency works and the failure surface is small.
  Adding the `resend` package would mean auditing a transitive tree.
- **No outbound webhooks.** Real gap, but it is a product feature rather than a
  reliability fix, and it is in the gap analysis at Medium.
- **No per-tenant sender identity.** Blocked on multi-tenancy.
- **No API idempotency key on `POST /documents`.** A retried create still makes
  two documents. Real gap, out of scope for the mail path, noted in the analysis.

No secret was committed. `.env.example` documents the behaviour without values.

---

## 6. Consolidation: what came from where

One branch off `main`, absorbing the whole nested chain. Merge was clean, zero
conflicts.

```
0ea2cf6  main
   │
   ├─ 4d390b4  docs(postman): curated API collection + OpenAPI fix
   ├─ c67d071  feat(sign): Sign backend — templates, OTP, seal, hash chain
   ├─ f496bac  feat(sign): sender console and signer pages
   ├─ bc298dc  docs(sign): architecture, runbook, departures      ← v2 tip
   ├─ ed20df9  feat(media): per-capability provider switch
   ├─ 86a649a  docs(media): provider verdict, Clerk/Resend/treg checklist
   ├─ e6bfecf  Rebuild watermark selection editor
   ├─ abcc525  feat(sign): admin portal, IP geo, template ACL, needs-resend
   └─ 9488318  feat(sign): ChampBeam tracked links, invitation polish
                                                                     ← admin tip
29c86cc  merge: fold everything into v2-consolidation
```

| Branch                        | Commits taken                              | Why                                                                                                                                           |
| ----------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `v2`                          | `4d390b4`, `c67d071`, `f496bac`, `bc298dc` | The whole Sign backend and its docs. Kept in full: this is the product. `v2` is an integration branch, not a release branch.                  |
| `feature/treg-clerk-resend`   | `ed20df9`, `86a649a`, `e6bfecf`, `abcc525` | Media provider switch, watermark editor rebuild, admin portal with MaxMind geo and needs-resend tracking. Reached via the merge of `abcc525`. |
| `feat/admin-portal-ip-resend` | `9488318`                                  | ChampBeam link wrapping and invitation-email polish. Its tip is the ancestor of everything above, so taking it takes the rest.                |
| `dependabot/...-8d84f30c81`   | **nothing**                                | Reproduced its failure: `npm ci` exits 1 with ERESOLVE on its own tree, for the same peer conflict. See section 7.                            |

---

## 7. Dependabot PRs: close or rework

**Recommendation: close #91. Do not close any other PR.** None were closed.

| PR      | Branch                                                      | Verdict                                    | Reason                                                                                                                                                                                                                                                                                                                                   |
| ------- | ----------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#91** | `dependabot/...-8d84f30c81` → `main`                        | **Close**                                  | Verified unmergeable. Extracted the branch to a clean tree and ran `npm ci`: exit 1, `ERESOLVE`. It pins `typescript: ~7.0.2` against `typescript-eslint: ^8.70.1`, which has the same `<6.1.0` ceiling. Merging it re-breaks all four workflows. Its 16 dependency bumps would need re-doing on top of the `~6.0.3` pin in this branch. |
| **#81** | `feature/treg-clerk-resend` → `v2`                          | **Leave open, rebase target is now wrong** | Content fully absorbed here. Once `v2-consolidation` merges, `v2` ceases to be a base and #81 has no purpose. Close after merge.                                                                                                                                                                                                         |
| **#82** | `feat/admin-portal-ip-resend` → `feature/treg-clerk-resend` | **Leave open, nested target**              | Content fully absorbed here. Close after merge, once #81 is closed.                                                                                                                                                                                                                                                                      |

If the 16 bumps in #91 are wanted, the route is: merge `v2-consolidation`
first, then let Dependabot re-run against the `~6.0.3` pin. Dependabot will not
propose a TypeScript outside the tilde range, so the re-run is safe by
construction.

---

## 8. npm vulnerabilities: reported separately

**These are unrelated to the TypeScript pin and are not fixed by it.**

```
$ npm audit --json
info: 0  low: 7  moderate: 18  high: 15  critical: 0  total: 40
```

**Correction to the brief's figure.** The brief cited 1 critical and 12 high.
On this branch the audit reports **0 critical and 15 high**, 40 total. Both
numbers were real when taken; they are from different trees. The count moved
between measurements because `npm install` resolves the graph afresh and the
advisory database moves underneath it. Treat the current run as the number of
record and do not compare the two directly.

### High-severity packages, direct or not

Measured on this branch:

| Package                                                     | Direct  | Path                              | Fix available |
| ----------------------------------------------------------- | ------- | --------------------------------- | ------------- |
| `mermaid`                                                   | **yes** | runtime (diagram rendering)       | yes           |
| `node-forge`                                                | **yes** | runtime, resolves to `1.3.3`      | yes           |
| `pptxgenjs`                                                 | **yes** | runtime, via `image-size`         | yes           |
| `chevrotain`, `@chevrotain/gast`, `@chevrotain/cst-dts-gen` | no      | transitive (diagram parsing)      | yes           |
| `image-size`                                                | no      | via `pptxgenjs`                   | yes           |
| `lodash`, `lodash-es`                                       | no      | transitive                        | yes           |
| `brace-expansion`, `picomatch`                              | no      | build and glob tooling            | yes           |
| `rollup`                                                    | no      | build chain                       | yes           |
| `viem`, `ws`                                                | no      | transitive, Solana wallet stack   | yes           |
| `vite`                                                      | no      | build chain, **no fix available** | no            |

`pdfjs-dist` does **not** appear in this run. It resolved to `6.3.289`, which is
outside the affected range (`>=5.6.83 <6.2.108`). The advisory named in the
brief is real but this branch is not exposed to it.

### Security items for the V2 branch

1. **`node-forge` high, direct runtime.** Confirmed at `1.3.3` in the lockfile.
   The repo declares an `overrides` entry pinning it to `^1.3.3`, so the override
   is winning, but `1.3.3` is still flagged. It is used for
   document-encryption and key handling in the PDF toolkit, so an advisory here
   is worth reading rather than deferring. `fixAvailable: true`.
2. **`mermaid` high, direct runtime.** Diagram rendering takes
   attacker-influenced text in a browser context. `fixAvailable: true`.
3. **`vite` high with no fix available.** Cannot be resolved inside `^8.3.0`.
   Assess whether the advisory set matters for a static build artefact, then
   record the decision rather than leaving it unexamined.
4. **40 total is a normal `npm audit` baseline for a tree this size**, and 15 of
   those high advisories are in the build chain or in transitive code. The
   actionable runtime set is small: `node-forge` and `mermaid`.

None were fixed here. Bundling an audit sweep into a consolidation branch makes
the diff much harder to review, and none of them caused the red CI. Recommend
`node-forge` and `mermaid` as the first PR after this one merges.

---

## 9. AGENTS.md and LICENSE

**LICENSE: confirmed present.** `LICENSE` at the repository root, GNU Affero
General Public License v3. `package.json` declares `"license": "AGPL-3.0-only"`,
consistent. `NOTICE`, `CCLA.md`, `ICLA.md` and `CONTRIBUTING.md` are all present,
and `.github/workflows/cla.yml` enforces CLA signatures on PRs.

**AGENTS.md: NOT delivered.** The write was blocked: the tooling classifies
`AGENTS.md` as a protected agent-instruction file and the approval prompt timed
out. Per the guard's instruction, no alternative path was used. This is the one
item in the brief left undone, and it needs one approval to land.

The content that was prepared covers: what the repo is (two products, one
repository), the full layout with a per-file table for `backend/sign/`, all
commands, and these gotchas, each of which cost real time to find:

- TypeScript is pinned at `~6.0.3` on purpose; check the peer range before
  merging any Dependabot PR that touches it.
- `httpx` must be `0.27.x` or all 51 TestClient tests error at collection.
- The backend test dependencies were unpinned; now in
  `backend/requirements-dev.txt`.
- The i18n build script leaks JSDOM windows and OOMs at 4GB; the pinned test is
  `src/tests/i18n-pages-memory.test.ts`.
- `cropperjs` must stay on 1.6.x; 2.x is a rewrite and the crop pages use the 1.x
  API.
- Do not reinstall `@types/markdown-it`.
- `sign_audit_events` is append-only, enforced by triggers. Never drop them to
  fix a failing test.
- The seal certificate is self-signed by default. Never call it qualified.
- No em dashes in output text.

---

## 10. Deletion manifest

**Nothing was deleted.** Nothing was merged to `main`. No PR was closed.

Reproduce any row with:

```
git merge-base --is-ancestor origin/BRANCH origin/v2-consolidation && echo contained
```

Actual output, run against the pushed `origin/v2-consolidation`:

```
$ git merge-base --is-ancestor origin/main origin/v2-consolidation && echo contained
contained
$ git merge-base --is-ancestor origin/v2 origin/v2-consolidation && echo contained
contained
$ git merge-base --is-ancestor origin/feat/admin-portal-ip-resend origin/v2-consolidation && echo contained
contained
$ git merge-base --is-ancestor origin/feature/treg-clerk-resend origin/v2-consolidation && echo contained
NOT contained
$ git merge-base --is-ancestor origin/dependabot/npm_and_yarn/npm-dependencies-8d84f30c81 origin/v2-consolidation && echo contained
NOT contained
```

| Branch                        | Verdict                                                                                                  | Proof                              | Notes                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main`                        | **KEEP**                                                                                                 | `contained`                        | It is the base. Never a deletion candidate.                                                                                                                                               |
| `v2`                          | **SAFE-TO-DELETE**, after this branch merges                                                             | `contained`                        | Proven ancestor. It was an integration branch, not a release branch. Its four commits are all in `v2-consolidation`. Becomes deletable the moment `v2-consolidation` is merged to `main`. |
| `feat/admin-portal-ip-resend` | **SAFE-TO-DELETE**, after this branch merges                                                             | `contained`                        | Proven ancestor of `v2-consolidation`. Becomes deletable after merge.                                                                                                                     |
| `feature/treg-clerk-resend`   | **KEEP for now. SAFE-TO-DELETE after merge.** Content is proven absorbed; the commit is not an ancestor. | `NOT contained`, then proven below | See below.                                                                                                                                                                                |
| `dependabot/...-8d84f30c81`   | **KEEP**                                                                                                 | `NOT contained`                    | Verified unmergeable (`npm ci` exits 1). See section 7. Do not delete; close the PR and re-run Dependabot after this branch lands.                                                        |

### Why `feature/treg-clerk-resend` shows NOT contained, and why it is still absorbed

Its tip is `350c7ab`, a **merge commit**, and `git merge-base --is-ancestor`
does not treat a merge of already-present content as contained.

```
$ git show --no-patch --format="parents: %p" 350c7ab
parents: e6bfecf abcc525
```

Proof that it adds nothing `v2-consolidation` lacks:

```
$ git log --oneline origin/v2-consolidation..origin/feature/treg-clerk-resend
350c7ab Merge pull request #80 from Champ-Deep/feat/admin-portal-ip-resend

$ git diff --stat 350c7ab^2 350c7ab
(empty)

$ git merge-base --is-ancestor abcc525 origin/v2-consolidation && echo contained
abcc525 IS contained
```

`350c7ab` is tree-identical to its second parent `abcc525`, which _is_ contained.
The only commit unique to that branch is the merge itself, and it is empty
against its own second parent. Its entire content is therefore present in
`v2-consolidation`.

**Verdict: KEEP until `v2-consolidation` merges, then SAFE-TO-DELETE.** The
containment requirement is satisfied on content; the ancestry check is
structurally incapable of returning "contained" for a merge commit whose parents
are both already in the target.

### Deletion order, once `v2-consolidation` is merged to `main`

1. `v2` — proven ancestor.
2. `feat/admin-portal-ip-resend` — proven ancestor.
3. `feature/treg-clerk-resend` — proven empty merge, both parents contained.
4. Close PRs #81 and #82 at that point. Do **not** close #91 by deletion;
   close it as a PR, since the Dependabot bump itself is the problem.
5. Leave `dependabot/...-8d84f30c81` in place until Dependabot re-runs post-merge.

---

## 11. What a reviewer should check first

1. **The pin.** `package.json` line 56: `~6.0.3`. Confirm the peer range claim
   against `typescript-eslint@8.70.0`.
2. **`cropperjs` back to 1.6.x.** Confirm the crop pages really use the 1.x API
   and that 2.x would have broken them at runtime.
3. **The i18n `close()` fix.** Run `npx vitest run src/tests/i18n-pages-memory.test.ts`,
   then delete the two `close()` lines and watch it fail.
4. **The anchor enforcement.** Run `pytest backend/tests/test_seal_anchor.py`,
   then make `if recorded_head:` into `if False:` and watch it fail.
5. **`verify_anchor` semantics.** It is a _prefix_ anchor: the recorded head is
   the parent of `document.executed`, not the final head. Check the ordering in
   `service.execute` → `_finalize_executed`.
6. **The Resend idempotency key.** Confirm it is derived from content, not the
   clock, so a genuine OTP resend still sends.

## 12. Open items, in order

| #   | Item                                                                                          | Effort            |
| --- | --------------------------------------------------------------------------------------------- | ----------------- |
| 1   | Approve and land `AGENTS.md` (blocked in this session)                                        | Minutes           |
| 2   | PR to bump `node-forge` and `mermaid` (both direct runtime, both fixable)                     | Hours             |
| 3   | Close PR #91, then re-run Dependabot on the pinned tree                                       | Minutes           |
| 4   | Frontend tests for `sign-document.html` and `sign-api.ts` (31.74% lines)                      | Days              |
| 5   | Automated reminders (gap analysis item 1)                                                     | One day           |
| 6   | A `sign.sign` scope in `KNOWN_SCOPES` (largest unforced API-key gap)                          | Hours             |
| 7   | Public, unauthenticated verification endpoint, so the anchor is checkable by the counterparty | Hours             |
| 8   | Decide on eIDAS and 21 CFR Part 11, explicitly                                                | Business decision |
