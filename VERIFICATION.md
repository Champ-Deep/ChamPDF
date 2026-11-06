# Verification: signatures and text size

## Scope and ruling

Built on fresh `origin/main` at `0ea2cf6`, branch `fix/signatures-text-size-nov6`.
The main-lane ruling of 6 November approves browser-local signatures. This PR does not add account authentication or server persistence. The dialog states the device/browser limitation explicitly. Existing storage namespaces and saved images are preserved.

## Reproduced before editing

`baseline.json` records a real Chromium run:

- Clicking home Signatures leaves no signature-library modal in the DOM.
- Saving a signature closes the dialog instead of leaving the saved signature available for selection.
- Signature canvas width is 1200 pixels at 2x scale.
- The signer toolbar exposes zero number/select text-size controls.

The existing library could store a PNG already. The defect was its missing home mount and broken save/select lifecycle, not an absent database. The first inspection in the previous attempt was source-only; this attempt reproduced the UI before editing.

## Implemented

- Mount the shared library when absent and initialize it once. Home, mobile navigation and signer reuse the same implementation.
- One save/use handler. Saving keeps the dialog open on the saved view. Storage failures preserve the form and permit retry.
- Existing IndexedDB storage commits the image before publishing metadata. No schema migration or deletion of user data.
- Both signature creation paths export transparent 1800 x 600 PNGs. Fonts load before export. Long names fit the canvas. PDF embedding retains image aspect ratio.
- Text size, 6 to 72 PDF points, travels through selection, annotation data, zoom, page navigation and PDF export. Larger text grows its box enough for one line and stays within the page. Existing date behavior is retained.
- Native keyboard-operable signature selection and labeled text-size control. Device-local notice, visible focus, mobile sizing and reduced-motion rules are scoped to these controls.
- Narrow PDF viewports retain access to the page's left edge rather than centering it outside the scrollable region.

## Executed checks

Node: nvm default v24.13.1. Existing local dependencies were reused. No application dependencies were added and no clean-install claim is made.

- `npm run test:run`: 7 test files passed, 230 tests passed. Three new tests cover 3x canvas rendering, literal text/zoom/box rendering, and size-control bounds/selection.
- Changed-file ESLint: exit 0, zero errors and three pre-existing warnings (`BlobPart`, `any`, `NodeListOf`).
- `git diff --check`: exit 0.
- `npx vite build`: exit 0. The resulting compiled pages were exercised through Vite preview at `http://127.0.0.1:3396`, not just the development server.
- `CHAMPDF_URL=http://127.0.0.1:3396 /opt/anaconda3/bin/python scripts/verify-signature-fixes.py`: six grouped browser checks passed. This script generates its own synthetic PDF fixture and requires Playwright, Chromium and PyMuPDF.
- Browser checks include home opening, save without premature close, persisted reuse after reload, signature placement, both creation paths, keyboard selection, toolbar refresh, 24pt text, 125% zoom, page navigation, size bounds and blank input, PDF download, and controls at widths 375, 768 and 1440.
- Independent PDF parsing finds `Approved` at exactly 24 points and an embedded signature image. The PDF was rendered and inspected.
- The created PNG is 1800 x 600 with 23,121 nontransparent pixels and 1,056,879 transparent pixels. Its corner alpha is zero.
- Injected storage denial: visible error, retained name, enabled retry. Restoring storage produces one saved signature and clears the stale error.
- Production browser flow console: zero errors.
- Scoped live audits of saved, create and loaded-editor states at 375, 768 and 1440: zero element-level failures. The only scoped warning is the existing Add Fields h3 following the page h1. The audit's unsupported OKLCH parser was replaced locally with browser canvas color resolution, without changing app tokens.
- Geometry checks verify no horizontal document overflow, reachable PDF left edges, 44px dialog controls and preview content that can scroll clear of the footer.

## Visual review

Screenshots were opened, not only generated. The review caught a too-short box for 24pt text and a narrow-view PDF left edge outside the reachable viewport. Both were fixed and re-rendered. Final inspection reads 24 in the size input and Approved with space above the lower border. Signature and text are separate in the exported PDF.

The create-dialog preview and color choices extend below the initial internal scroll position on short screens. This is intentional scrolling, not hidden content: the browser check scrolls the preview into view and asserts it clears the footer. Selection borders and resize handles are intentional. Disabled Save on an empty name and disabled Use Selected without a selection are intentional.

Primary evidence files:

- `fix-home-signatures.png`
- `fix-saved-signatures.png`
- `fix-text-size.png`
- `library-{saved,create}-{375,768,1440}.png`
- `editor-{375,768,1440}.png`
- `signed-pdf-render.png`

These are supplied in the task evidence archive, together with logs, JSON results and the synthetic exported PDF.

## 21st.dev provenance

Origin UI Input, https://21st.dev/@originui/components/input, demo 162. Installed successfully using `npx shadcn@latest add @21st/originui/input --yes` on Node 24 with environment-based registry authentication. The install log and captured source are in the evidence archive.

The app is vanilla TypeScript. Its mounted text-size input is a vanilla port of the installed input's border, surface, focus and disabled-state treatment, with host colors and a 44px minimum height. No unused React runtime or registry demo dependencies were added. The Kokonut input catalog search was also checked; the Origin UI input was the smaller compatible source.

## Limits and integration risks

- `npm run build` and `npx tsc --noEmit` fail on four existing diagnostics in `view-metadata-page.ts` and `markdown-editor.ts`. A detached untouched-main worktree produces the identical four diagnostic lines. The production Vite bundle passes, but the complete build including typecheck and i18n is not green. No full-build or CI-green claim is made.
- Whole-page audit is not clean. The raw audit reports inherited shell contrast/label/target/motion findings and has OKLCH parsing limitations. Only affected controls received a corrected scoped pass. This PR does not claim to repair the entire home page, all themes, or shared navigation/footer accessibility.
- Added lines and newly written documents contain no em dashes or en dashes. The existing home copy still has two em dashes, outside this defect-fix scope.
- Open PR #99 and its consolidation #102 touch the same PDF signer files and already include a broader text-style feature. Main lane/reviewer must reconcile this overlap. Do not merge both implementations blindly.
- Vercel is connected and automatically creates previews. `vercel.json` disables automatic deployment for this exact branch only, using documented `git.deploymentEnabled`. Other branches and production settings remain unchanged.
- No deployment, merge, live user data deletion, account sync, certificate signing, physical-device testing, Safari testing or screen-reader testing is included. The existing Latin-font export limitations remain.
- Verification servers are stopped before handoff. No public preview is created, per the card's no-deploy rule.
