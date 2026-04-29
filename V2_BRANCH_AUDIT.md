# v2 — Branch Deletion Audit

This document confirms that every active source branch is safely
represented in `v2`'s history before deletion. Run before merging v2 → main
and pruning the source branches.

## Git-history check (mechanical)

```
git fetch --all --prune
git branch -r --merged v2 | grep -v 'origin/v2\|origin/main\|origin/HEAD'
git branch -r --no-merged v2 | grep -v 'origin/v2\|origin/main\|origin/HEAD'
```

Result on the run that produced this document:

| Branch | Tip in v2 history? |
| --- | --- |
| `claude/champdf-edit-banana-integration-0W5aV` | ✅ |
| `claude/check-champ-deep-deployment-cwXk9` | ✅ |
| `claude/simplify-navigation-vd0tp` | ✅ |
| `claude/smooth-pdf-watermark-removal-Gnu5r` | ✅ |
| `claude/video-to-mp3-converter-BOjE9` | ✅ |
| `dependabot/github_actions/actions/configure-pages-6` | ✅ |
| `dependabot/github_actions/actions/deploy-pages-5` | ✅ |
| `dependabot/github_actions/actions/upload-pages-artifact-5` | ✅ |
| `dependabot/github_actions/softprops/action-gh-release-3` | ✅ |
| `dependabot/npm_and_yarn/npm-dependencies-9b1cca0ff2` | ✅ |
| `feature/search-keywords-10054330705350503532` | ✅ |
| `fix-issues-video-rebrander-and-pdf-tools-16028787152051742561` | ✅ |

**No branch is missing from v2's history.** The "no-merged" list is empty.

## Conflict-resolution audit (substantive)

`git --merged` only confirms the tip commits exist; it doesn't say whether
specific changes survived conflict resolution. Below is what was kept,
what was substituted, and what was dropped — with rationale.

### `claude/champdf-edit-banana-integration-0W5aV` — backend OpenCV inpainting + UI search

**Kept verbatim:**
- `backend/video_processor.py` — the +360-line OpenCV inpainting rewrite (Telea + Navier-Stokes dual pass).
- `backend/propainter_wrapper.py` — optional GPU-accelerated path.
- `opencv-python-headless` and `libglib2.0-0` dependency adds.
- Backend `main.py` health-check additions.
- `video-rebrander-page.ts` UI text update (“AI-powered inpainting”).

**Substituted with equivalent or better:**
- The branch's `tags`-based search system — replaced by the `keywords`
  system from `feature/search-keywords` (already in main intent).
  v2 has the union of both branches' search terms attached as
  `keywords[]` on the relevant tools (commit `3c4bc5c`).
- The “edit-banana” search-keyword string — restored on the PDF Editor
  tool entry plus a real `Edit Banana` standalone tool (commit `071642a`)
  that actually does what the branch name implies (Gemini image editing).

**Dropped (with reason):**
- The branch's `tools.ts` overhaul — would have **deleted 76 of the 126
  tools** that exist on main (almost certainly accidental, not in the
  commit message). v2 keeps the full catalog.
- The branch's `remove-watermark-page.ts` rewrite — 1033 lines of two
  incompatible implementations concatenated (undefined `pageState` /
  `showLoader` references, duplicate `updateFileDisplay` definitions).
  Did not compile on its own branch. Reverted to main's working version,
  then upgraded with the new Gemini AI option (commit `a3b2c96`) and
  auto-detect (`87f040c`).

### `fix-issues-video-rebrander-and-pdf-tools-16028787152051742561`

**Commit message overstated the diff.** The actual file diff vs main
contains only Sign PDF fixes (annotation-layer + index + sample.pdf +
package-lock.json). The other claims in the commit message — nginx 413
fix, PowerPoint-to-PDF WASM repair, adjustable logo-scale slider — were
never committed to that branch.

What actually shipped on the branch (Sign PDF fixes) is in v2.

What the commit message *claimed* (and v2 also delivers, freshly
implemented):
- ✅ `client_max_body_size 100M` in nginx — implemented separately in
  commit `d9f891f` (came in via the video-to-mp3 branch's nginx work).
- ✅ Logo-scale slider on Video Rebrander, Remove Image Watermark, and
  Add Watermark — implemented fresh in commit `18c0561`.
- ✅ LibreOffice WASM ships in build (this addresses the underlying
  PowerPoint-to-PDF problem) — implemented fresh in commit `3c4bc5c`.

### `claude/simplify-navigation-vd0tp`

**Kept verbatim:**
- `Pillar` type + typed `Tool` / `Category` interfaces.
- `pillar` field on every one of the 121 tools (TypeScript-enforced).
- Helpers `toolsByPillar()`, `topToolsForPillar()`.
- 3 hub pages (`documents.html`, `images.html`, `video.html`).
- New `src/js/utils/render-tool-grid.ts` shared utility.
- Navbar mega-menu markup (`navbar.html`) + mobile accordion
  (`mobileMenu.ts`).
- All 11 i18n locale updates (`nav.documents/images/video/viewAll`).
- Search bug fixes (empty state, hide nav while searching, null-guard,
  3 missing category translation keys).

**Layered on top of nav's restructure:**
- The `keywords` field from `feature/search-keywords` — sprinkled into
  the new `Tool` interface as `keywords?: string[]`, and the matching
  `dataset.keywords` write + `toolKeywords` match in main.ts and
  render-tool-grid.ts so both improvements coexist.

**Dropped:** nothing — fully merged.

### `feature/search-keywords-10054330705350503532`

Fully merged (`keywords` field + dataset attribute + isMatch check).
The follow-up nav merge preserved this with the `keywords?: string[]`
field on the new `Tool` interface.

### `claude/video-to-mp3-converter-BOjE9`

Fully merged. Contributed:
- `Video Downloader` tool at `/video-downloader.html` (MP4 + MP3 via
  yt-dlp).
- `backend/media_downloader.py`.
- `yt-dlp` dependency.
- The `/api/` reverse-proxy block in `nginx.conf` — fixes the 405 issue
  the deployed Railway service had.
- `client_max_body_size 100M` (the real source of that fix, not the
  fix-issues branch).

### `dependabot/npm_and_yarn/npm-dependencies-9b1cca0ff2`

Fully merged with two scoped reverts:
- `cropperjs` reverted ^2.1.1 → ^1.6.1 — v2's API is fully incompatible
  with how `crop-pdf-page.ts` and `cropper.ts` instantiate it. A real v2
  upgrade is a separate refactor task.
- All 32 other package bumps stayed.

Build issues introduced by the bumps and fixed:
- Vite 8's rolldown-based bundler forbids mutating the `bundle` map in
  `generateBundle`. Both `flatten-pages` and `rewrite-html-paths`
  plugins migrated to `writeBundle` hooks. Fixed in commit `67ff4ab`.
  Without this, the previous build silently emitted only 2 root HTML
  files instead of 119.
- `tsconfig.json` gained `"ignoreDeprecations": "6.0"` to silence a
  TS5101 (`baseUrl` deprecated) error introduced by the TypeScript bump.

### `dependabot/github_actions/*`

Four GH Actions version bumps. All four merged cleanly (different lines
in the same workflow files merged automatically).

### `claude/check-champ-deep-deployment-cwXk9` and `claude/smooth-pdf-watermark-removal-Gnu5r`

Already on main before v2 was created (0 file diffs vs main). No-ops in
v2's merge sequence; included in the "merged into v2" list above purely
because their tips happen to be ancestors of main, which is the base of v2.

## What v2 adds beyond the source branches

These features are net-new in v2; not present on any source branch:

- **Edit Banana** standalone tool (`071642a`).
- **Public API v1**: auth + rate-limit + 7 tool endpoints + admin
  endpoints (`1ff5212`, `b9f245e`, `f328bb2`, `40fe098`).
- **MCP server** stdio + HTTP/SSE (`cee18a9`, `ddef208`).
- **Gemini AI inpainting** path in PDF Watermark Remover (`a3b2c96`).
- **Auto-detect watermarks** (`87f040c`).
- **Server-side PDF watermark remover** (`40fe098`).
- **`backend/scripts/verify_inpaint.py`** validation harness (`94200d3`).

## Recommendation

Safe to delete every branch listed in the table above after v2 is merged
into main. From a `git reflog` perspective, GitHub keeps deleted branch
tips for 30+ days regardless, and the entire history is reachable from
v2 (and post-merge, from main) in any case.

Suggested order:

1. Merge `v2` → `main` (creates the merge commit; main now contains all v2 history).
2. Delete the 12 source branches:

   ```
   for b in \
     claude/champdf-edit-banana-integration-0W5aV \
     claude/check-champ-deep-deployment-cwXk9 \
     claude/simplify-navigation-vd0tp \
     claude/smooth-pdf-watermark-removal-Gnu5r \
     claude/video-to-mp3-converter-BOjE9 \
     dependabot/github_actions/actions/configure-pages-6 \
     dependabot/github_actions/actions/deploy-pages-5 \
     dependabot/github_actions/actions/upload-pages-artifact-5 \
     dependabot/github_actions/softprops/action-gh-release-3 \
     dependabot/npm_and_yarn/npm-dependencies-9b1cca0ff2 \
     feature/search-keywords-10054330705350503532 \
     fix-issues-video-rebrander-and-pdf-tools-16028787152051742561; do
     git push origin --delete "$b"
   done
   ```

3. Optionally also delete `v2` once it's merged into main (it will have
   served its purpose). Keep it around for at least one deploy cycle if
   you want a rollback handle.
