# ChamPDF — Design Direction Brief for "Claude Design"

> **Purpose:** This is a written design brief, not an implemented redesign. It gives "Claude Design" (an AI design tool) three concrete directions to choose from and execute later. Hand it the recommended direction plus the copy-paste prompts in Section 4.
>
> **Scope rule for whoever executes this:** Do not refactor logic. ChamPDF is a Tailwind v4 + Vite app with ~117 tool entries defined in `src/js/config/tools.ts`, partials in `src/partials/`, and one HTML page per tool in `src/pages/`. Any redesign must keep the existing IDs/hooks (`#tool-grid`, `#search-bar`, `#category-nav`, `#drop-zone`, `#options-section`, `#processing-status`, `#download-section`, etc.) so the existing JS keeps working.

---

## 1. Context & Goals

### What ChamPDF is

ChamPDF is a **privacy-first, client-side PDF + media toolkit** (a fork of BentoPDF). Per `README.md`, the core promise is: _"All processing happens in your browser. Your files are never uploaded to a server."_ It is self-hostable, free/open-source, and ships **~117 tools across 9 categories** (`src/js/config/tools.ts`):

- **PDF Essentials** (Multi Tool, Merge, Split, Compress, PDF Editor, OCR, Compare, Flatten, Prepare PDF for AI)
- **Image & Media Tools** (Remove Background, **Video Logo Remover**, **Image Watermark Remover**, **PDF Watermark Remover**, Replace Logo, PDF↔image conversions)
- **Document Converters** (Word/Excel/PowerPoint/Markdown/CSV/JSON/EPUB ↔ PDF, PDF/A)
- **Image to PDF Converters** (JPG/PNG/SVG/WebP/BMP/TIFF/HEIC/PSD/CBZ → PDF)
- **Office to PDF Converters** (ODT/ODS/ODP/RTF/Pages/Publisher/Visio/WordPerfect/MOBI/XPS → PDF)
- **Organize & Manage** (Organize, Crop, Rotate, Page Numbers, Add Watermark, Bookmarks, TOC, Posterize, etc.)
- **Security & Privacy** (Sign, Digital Signature, Encrypt, Decrypt, Redact, Sanitize, Remove Metadata, Permissions)
- **Forms & Data** (Form Filler, Form Creator, Extract Tables, Attachments, Metadata, Stamps)
- **Optimize & Repair** (Repair, Linearize, Deskew, Font to Outline, Booklet, N-Up, Rasterize)

### Who uses it

- **Privacy-conscious individuals** who refuse to upload sensitive docs (legal, medical, financial) to a server.
- **Knowledge / ops / marketing workers** doing day-to-day conversions, merges, redactions, and signatures.
- **The new media/rebrand audience** — people cleaning up AI-generated content. The `video-rebrander.html` page targets _"Remove AI watermarks from videos and rebrand with your company logo… Supports NotebookLM"_ and even ships brand presets (LakeB2B, Champions, Ampliz). This is a distinct, higher-intent persona and currently feels bolted on.

### Brand & current visual system (observed, not assumed)

- **Theme:** dark-only. `styles.css` hard-codes `body { background-color: #111827; color: #d1d5db; }` (gray-900 / gray-300). Cards are gray-800 (`#1f2937`) with gray-700 (`#374151`) borders.
- **Accent palette:** a "Champions" red/orange family — primary red `#c8232c`, dark red `#a01d24`, orange `#e88b2d` / `#d65a36`, plus a red→orange gradient (`.btn-gradient`). Confusingly, buttons mix `red-600`, `orange-600`, and the gradient inconsistently; links are `orange-400`.
- **Typography:** `DM Sans` for UI (400–700), plus a large bundle of signature/serif faces (Dancing Script, Great Vibes, Kalam, Lato, Merriweather, Cedarville) imported globally in `styles.css` — used by signature tools but loaded everywhere.
- **Icons:** **Phosphor** (`ph-*`) for the tool catalog cards + **Lucide** (`data-lucide`) for UI chrome. Two icon systems = visual inconsistency.
- **Layout:** homepage (`index.html`) = centered search bar (max-w-lg) → horizontally-scrolling sticky category nav → a flat responsive grid (`grid-cols-2 … lg:grid-cols-5`) of identical centered cards. Tool pages = a single centered `max-w-2xl` card (`#tool-uploader`) with a dashed `#drop-zone`, an `#options-section`, and discrete `#processing-status` / `#download-section` / `#error-section` blocks (see `video-rebrander.html`).
- **Motion:** `styles.css` contains a very large library of animations (shimmer, glow, wobble, floating, flip, bounce, ripple, parallax) — far more than the UI actually uses. Cards do a `translateY(-5px)` lift with a red border on hover.

### Strengths (keep these)

- Search-first instinct is already there (`#search-bar` with a `⌘K`-style `kbd` hint).
- Genuinely useful sticky category nav and a clean, fast grid.
- Strong privacy story that is under-told visually.
- Clear per-tool state machine (upload → options → processing → download/error) that's consistent across tool pages — a great base for a polished component set.

### Pain points (observed, specific)

1. **Inconsistent accent usage.** Red, orange, and a gradient all fight for "primary." `index.html` uses `red-600`/`red-500` CTAs and `red-500` focus rings, while `video-rebrander.html` uses `orange-600`/`orange-500` CTAs and orange selection states. No single primary.
2. **119-ish tools, flat presentation.** 5-up grid of visually identical cards means scanning is slow; the long horizontal category strip hides categories off-screen.
3. **Title/brand mismatch.** Homepage `<title>` is literally "PDF Tools" and the H1 says "PDF Tools," but the product is ChamPDF and now does video/image/media. The brand and the chameleon/adaptive concept are invisible.
4. **Media/watermark tools feel second-class.** Video Logo Remover, Image/PDF Watermark Remover, Remove Background, and Replace Logo are buried mid-list in "Image & Media Tools" despite being the differentiated, high-intent features. The video tool's "Server-Side Processing" reality also clashes with the "100% in-browser" promise and needs honest, well-designed messaging.
5. **Two icon families** (Phosphor + Lucide) and **6+ display fonts loaded globally** add inconsistency and weight.
6. **Dark-only** with no light mode; some contrast (gray-500 text on gray-900) is borderline for AA.
7. **Animation sprawl** in CSS without a coherent motion language.

### Goals for the redesign

- Establish **one** coherent visual identity tied to the **chameleon / adaptive** name.
- **Tame ~117 tools** so users find the right one in seconds.
- Make **media/watermark/video** tools feel first-class and clearly labeled (in-browser vs. server-side).
- Foreground the **privacy** promise.
- Introduce **light + dark** with a single token system, AA contrast, and a restrained motion language.

---

## 2. Three Design Directions

All three reuse the existing structural hooks and the upload → options → processing → download/error flow. They differ in identity, IA, and feel.

---

### Direction A — "Editorial Calm" (Warm, Claude-inspired)

**Concept:** A warm, paper-and-ink editorial workspace that makes a 119-tool utility feel calm, trustworthy, and human — the opposite of a cluttered freeware PDF site.

| Aspect               | Direction A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Color (light)**    | Warm paper `#FAF9F5` bg, ink text `#1A1A18`, surface `#FFFFFF`/`#F3F1EA`, borders `#E5E1D8`. Primary clay/terracotta `#C8552C` (an evolution of the existing `#d65a36`), with a softened ChamPDF red `#C8232C` reserved for destructive actions only.                                                                                                                                                                                                                                           |
| **Color (dark)**     | Warm-charcoal `#1F1E1B` bg, surface `#2A2824`, text `#EDE9E0`, same clay accent (slightly brighter `#E08A5B`). Note: warmer than today's cold blue-gray `#111827`.                                                                                                                                                                                                                                                                                                                              |
| **Typography**       | Display/headings: a humanist serif (e.g. **Tiempos / Lora / Source Serif**) for H1/H2 and category titles → editorial credibility. UI/body: keep **DM Sans**. Mono for file sizes/metadata.                                                                                                                                                                                                                                                                                                     |
| **Layout / IA**      | **Search-first + curated dashboard.** Big centered search hero with privacy line beneath. Below: a small "Popular / Recently used" row, then a **"Featured: Media & Rebrand"** band (Video Logo Remover, Watermark Removers, Remove Background) as large editorial cards. Remaining categories become collapsible _sections stacked vertically_ (replace the horizontal scroll strip with a left/sticky in-page category index) so all 9 categories are reachable without horizontal scrolling. |
| **Components**       | Cards: generous padding, left-aligned text, small monochrome icon in a tinted clay chip, hairline border, subtle shadow on hover (no big lift). Buttons: solid clay primary, ghost secondary, outline destructive-red. Upload zone: large rounded dashed area with a friendly illustration and explicit "Files never leave your device" microcopy. Processing: a calm linear progress bar + status text (reuse `#progress-bar`).                                                                |
| **Light/Dark**       | Both first-class; default to system. Single CSS-variable token set.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Motion**           | Quiet. 150–200ms ease-out fades/translates only. Retire the wobble/flip/glow library.                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Accessibility**    | AA+ contrast on warm neutrals; visible focus rings (2px clay on offset bg); respect `prefers-reduced-motion`; ensure clay vs. white passes AA for text.                                                                                                                                                                                                                                                                                                                                         |
| **Chameleon tie-in** | Subtle: the accent "warms/cools" slightly between light and dark — the brand quietly _adapts_ to environment.                                                                                                                                                                                                                                                                                                                                                                                   |

---

### Direction B — "Pro Console" (Dense, productivity dashboard)

**Concept:** A keyboard-driven power tool for people who run conversions all day — think Linear/Raycast density applied to a 119-tool catalog.

| Aspect                    | Direction B                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Color (dark, primary)** | True neutral slate: bg `#0E1116`, panels `#161A21`, borders `#262C36`, text `#C9D1D9`. Single electric accent — keep ChamPDF red but cooled to a confident `#E5484D`; success `#30A46C`, warning `#F5A623`, info `#3B82F6`. **One** accent, used sparingly.                                                                                                                                                  |
| **Color (light)**         | `#FFFFFF`/`#F6F7F9` panels, `#0E1116` text, same red accent.                                                                                                                                                                                                                                                                                                                                                 |
| **Typography**            | **Inter** (or keep DM Sans) at tighter sizes; tabular numerals for sizes/counts; **JetBrains Mono** for shortcuts/metadata.                                                                                                                                                                                                                                                                                  |
| **Layout / IA**           | **Command-palette-first.** Persistent left sidebar lists the 9 categories with counts; main area is a dense, _table-or-compact-grid_ of tools with type-ahead filtering. `⌘K` (the existing `kbd` hint becomes real) opens a command palette that searches all 117 tools + actions. "Pinned" tools row at top. Media tools get a dedicated sidebar section "Media & Rebrand" with a small "BETA/Server" tag. |
| **Components**            | Cards: compact, 1–2 lines, icon-left, hover = border highlight only. Buttons: small, high-contrast, with visible keyboard hints. Upload zone: compact dashed bar + a queue/list view that supports multiple files and per-file status chips. Processing: inline row-level progress + a global activity indicator; download appears as a status chip, not a separate hero block.                              |
| **Light/Dark**            | Dark default (matches today), light available.                                                                                                                                                                                                                                                                                                                                                               |
| **Motion**                | Minimal, fast (100–150ms). Snappy, not playful.                                                                                                                                                                                                                                                                                                                                                              |
| **Accessibility**         | Strong focus management for keyboard nav; ARIA for the palette/listbox; AA contrast; all mouse affordances have keyboard equivalents.                                                                                                                                                                                                                                                                        |
| **Chameleon tie-in**      | Functional: the UI _adapts to the task_ — the workspace reconfigures per tool, and a per-tool accent tint hints at category.                                                                                                                                                                                                                                                                                 |

---

### Direction C — "Cham" (Playful chameleon brand)

**Concept:** Lean fully into the chameleon: a friendly, colorful, adaptive brand where **color itself shifts per tool category** — memorable and clearly not generic freeware.

| Aspect               | Direction C                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Color**            | A **chameleon spectrum** mapped to the 9 categories, each a hue used for that category's icons, chips, and hover states: Essentials = ChamPDF red `#C8232C`; Image & Media = magenta `#D6409F`; Doc Converters = violet `#8E4EC6`; Image→PDF = blue `#3B82F6`; Office→PDF = teal `#12A594`; Organize = green `#30A46C`; Security = amber `#F5A623`; Forms = orange `#E5601C`; Optimize = cyan `#0BA5EC`. Neutrals: bg `#0F1419` (dark) / `#FBFCFD` (light), surfaces and borders accordingly. |
| **Typography**       | Rounded, friendly geometric for display (e.g. **Plus Jakarta Sans / Poppins** for H1 + category headers); **DM Sans** for body.                                                                                                                                                                                                                                                                                                                                                               |
| **Layout / IA**      | **Grouped, color-coded dashboard.** Hero with mascot/logo + search. Tools grouped under big category headers, each header carrying its hue and a count. Sticky chip nav stays but chips are colored per category (replaces the monochrome scroll strip). A **"Spotlight" hero tile** rotates the media/rebrand stars. Optional "surprise me"/random-tool flourish.                                                                                                                            |
| **Components**       | Cards: rounded-2xl, white/dark surface, a category-colored icon chip top-left, colored hover glow matching the category. Buttons: category-tinted primary on tool pages (e.g., Video tool = magenta), neutral elsewhere. Upload zone: playful dashed zone with a chameleon-tongue "grab your file" micro-illustration; subtle color-shift animation on drag-over. Processing: progress bar adopts the active tool's hue.                                                                      |
| **Light/Dark**       | Both; the mascot/accent literally "changes color" by theme — on-brand.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Motion**           | More expressive but disciplined: a tasteful color-blend transition on hover, gentle card scale, a chameleon color-shift on theme toggle. Cap durations ≤300ms; honor reduced-motion.                                                                                                                                                                                                                                                                                                          |
| **Accessibility**    | Critical: never use category color as the _only_ signifier (pair with icon + label); verify every hue passes AA on its surface; provide a "reduce color" / high-contrast option.                                                                                                                                                                                                                                                                                                              |
| **Chameleon tie-in** | The whole concept — adaptive, color-shifting identity that lives up to the name.                                                                                                                                                                                                                                                                                                                                                                                                              |

---

## 3. Recommendation

**Pick Direction A ("Editorial Calm") as the foundation, and borrow one feature from each of B and C:**

- From **B**: make the `⌘K` **command palette real** (the homepage already advertises the shortcut) so power users can reach any of 117 tools instantly.
- From **C**: use a **subtle per-category accent hue** for icon chips and category headers only — enough to aid scanning and nod to the chameleon name, without going full rainbow.

**Why A:**

- It directly fixes the top pain points: it resolves the red-vs-orange-vs-gradient conflict into one warm primary, it foregrounds **privacy** and **trust**, and its vertical, search-first IA tames 117 tools far better than today's horizontal scroll strip.
- The warm, calm tone differentiates ChamPDF from the sea of cluttered free PDF sites and reads as premium/trustworthy — exactly what a privacy tool handling sensitive files needs.
- It's the most achievable on the current stack: it maps cleanly onto existing tokens (replace `#111827`/`#1f2937` with a warm-neutral scale) and existing component hooks.
- Direction B risks alienating the casual/marketing persona with density; Direction C risks looking gimmicky and has real accessibility cost if color carries meaning. Folding their best ideas into A is the safer, higher-ceiling play.

**Also decide early (applies to any direction):**

- **Unify icons** on **Phosphor** (it already powers the catalog) and drop Lucide, or vice-versa — pick one.
- **Trim global fonts:** load the signature/serif faces only on signature/markdown tools, not site-wide.
- **Add light mode** + a single design-token layer (CSS variables) so theme is one switch.
- **Honest processing labels:** clearly mark which tools are 100% in-browser vs. server-side (the video tool).

### Phased rollout

1. **Phase 1 — Homepage (`index.html`) + tokens + navbar/footer.** Establish the token system (colors, type, spacing, radius), light/dark, the new search-first IA, the curated "Featured: Media & Rebrand" band, and the real command palette. Highest visibility, lowest risk. Validate AA contrast here first.
2. **Phase 2 — Generic tool page shell (`#tool-uploader` template).** Restyle the shared upload → options → processing → download/error components once; it propagates to ~110 tool pages (Compress, Merge, Split, etc.). Keep all IDs.
3. **Phase 3 — Media/rebrand flagships.** Give `video-rebrander.html`, `remove-watermark.html`, `remove-image-watermark.html`, `remove-bg.html`, and `replace-logo.html` first-class layouts: clear logo/preset pickers, position selectors, honest "server-side, auto-deleted" trust panel, richer processing/preview/download states.
4. **Phase 4 — Cleanup.** Retire unused animations, dedupe `.pill` rules, consolidate fonts/icons, audit remaining pages (legal, FAQ, about) for token compliance.

---

## 4. Ready-to-Use Prompts for Claude Design

> Paste these directly into the design tool. They encode the **recommended direction (A + palette + command palette + subtle per-category hue)**. Replace bracketed notes as needed.

### Prompt 1 — Homepage / tool dashboard

```
Design the homepage for ChamPDF, a privacy-first browser-based PDF + media toolkit
with ~117 tools across 9 categories. Direction: "Editorial Calm" — warm, trustworthy,
premium, the opposite of cluttered freeware.

Palette (light): paper bg #FAF9F5, surfaces #FFFFFF/#F3F1EA, ink text #1A1A18,
hairline borders #E5E1D8, primary clay #C8552C (CTAs/links), destructive red #C8232C.
Provide a dark variant: bg #1F1E1B, surface #2A2824, text #EDE9E0, accent #E08A5B.
Type: humanist serif for H1/H2 and category headers; DM Sans for UI/body.

Layout: a centered hero with the ChamPDF wordmark, an H1, and a prominent search bar
with a ⌘K hint and the line "All processing happens in your browser — your files never
leave your device." Below the search: a "Popular tools" row, then a FEATURED band titled
"Media & Rebrand" with large cards for Video Logo Remover, PDF Watermark Remover, Image
Watermark Remover, and Remove Background. Below that, the full catalog as vertically
stacked, collapsible category sections (PDF Essentials, Image & Media Tools, Document
Converters, Image→PDF, Office→PDF, Organize & Manage, Security & Privacy, Forms & Data,
Optimize & Repair), each with a sticky in-page index on the left. Give each category a
SUBTLE accent hue used only for its icon chips and header underline (red, magenta, violet,
blue, teal, green, amber, orange, cyan).

Tool cards: left-aligned, generous padding, a monochrome Phosphor icon inside a tinted
chip, tool name, one-line subtitle, hairline border, soft shadow on hover (no big lift).
Include the ⌘K command-palette overlay searching all 117 tools. Keep motion quiet
(150–200ms fades). Meet WCAG AA. Show light and dark.
```

### Prompt 2 — Generic tool page (use Compress PDF as the example)

```
Design the shared ChamPDF tool-page template, using "Compress PDF" as the example.
Same "Editorial Calm" system as the homepage (warm neutrals, clay primary #C8552C,
serif headings + DM Sans body, light + dark).

Structure (a single centered max-w-2xl card on a warm-neutral page):
- A subtle "← Back to tools" link in clay.
- H1 tool name + one-line subtitle.
- A reassurance chip: "Runs 100% in your browser — files never uploaded."
- A large rounded dashed UPLOAD zone with icon, "Click to select or drag & drop",
  and accepted formats; supports multiple files with a tidy file list + remove buttons.
- An OPTIONS panel (for Compress: compression level radio cards Low/Recommended/High
  with expected size-reduction hints).
- A primary clay "Compress PDF" button (full width).
- A PROCESSING state: calm linear progress bar + status text + cancel.
- A SUCCESS state: result summary (old size → new size, % saved) + clay "Download" button
  + ghost "Compress another".
- An ERROR state: inline, non-alarming, with a "Try again" action.
Design all four states (idle, processing, success, error). Meet WCAG AA; visible focus
rings; reduced-motion friendly. Show light and dark.
```

### Prompt 3 — Video Logo Remover & Rebrander (flagship media tool)

```
Design the "Video Logo Remover & Rebrander" page for ChamPDF — a flagship feature that
removes AI-tool watermarks (e.g. NotebookLM) from videos and optionally rebrands them
with a company logo. Use the "Editorial Calm" system but make this page feel premium and
first-class. This tool is SERVER-SIDE (unlike most ChamPDF tools), so trust messaging
must be honest and prominent.

Include:
- Hero: H1 "Video Logo Remover & Rebrander", subtitle about removing AI watermarks and
  rebranding, and a clearly-styled trust panel: "Processed on our secure server with
  FFmpeg; files auto-deleted after processing" (visually distinct from the in-browser
  badge used elsewhere — be transparent, not hidden).
- Upload zone for video (MP4, MOV, WebM, AVI, max 100MB) with a thumbnail/preview of the
  selected file.
- LOGO PICKER: a grid of brand presets (LakeB2B, Champions, Ampliz, "None / remove only")
  as selectable cards with checked/selected styling in clay, plus an "Upload custom logo"
  option.
- WATERMARK POSITION picker: a 2x2 of corner options (top-left, top-right, bottom-left,
  bottom-right) shown on a small video-frame diagram.
- Primary action "Clean & Rebrand Video".
- PROCESSING state with progress bar + "this can take a few minutes" and live status.
- SUCCESS state with video preview, "Download rebranded video", and "Process another".
- A "How it works" 3-step section and an FAQ accordion.
Design idle, processing, and success states. Light + dark. WCAG AA.
```

### Prompt 4 — Watermark Remover (PDF + Image)

```
Design a unified "Watermark Remover" tool page for ChamPDF covering both PDF and image
watermark removal (AI-powered inpainting), in the "Editorial Calm" system. Emphasize that
this runs in-browser/privately. Include: an upload zone (PDF/JPG/PNG), a before/after
preview slider, optional "detect automatically" vs "select watermark region" modes, a
clay primary "Remove watermark" button, and processing/success/error states with a
download CTA. Light + dark, WCAG AA, quiet motion.
```

### Prompt 5 — Command palette + global components

```
Design the ChamPDF ⌘K command palette and shared component set in the "Editorial Calm"
system (warm neutrals, clay #C8552C, serif headings, DM Sans). The palette is a centered
overlay with a search field and a results list grouped by category, each result showing a
tinted category icon chip, tool name, and subtitle, with full keyboard navigation and a
recent/pinned section. Also provide: navbar (wordmark + chameleon logo, theme toggle,
Sign In/avatar, Signatures), footer, buttons (primary clay / ghost / destructive-red),
input + search field, radio "option cards", file-drop zone, progress bar, toast/alert,
and modal. Deliver as a small design-token sheet (color, type scale, spacing, radius,
shadow) plus the components in light and dark. WCAG AA.
```

---

## 5. Current → Proposed Component Map

| Current (in repo)                                                           | Proposed (Direction A)                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `body` hard-coded `#111827` / `#d1d5db`, dark-only                          | Tokenized warm-neutral scale (paper/ink), **light + dark** via CSS variables                |
| Mixed accents: `red-600`, `orange-600`, `.btn-gradient`, `orange-400` links | **One** primary (clay `#C8552C`); red reserved for destructive only; gradient retired       |
| `.tool-card` (centered, gray-800, red hover-lift) in 2–5-up flat grid       | Left-aligned editorial card, tinted category icon chip, soft hover (no big lift)            |
| Horizontal sticky `#category-nav` scroll strip                              | Vertical collapsible category sections + sticky in-page index (chips optional, color-coded) |
| `#search-bar` with decorative `kbd` ⌘K hint                                 | Same field, **plus a real ⌘K command palette** over all 117 tools                           |
| Homepage H1 "PDF Tools" / `<title>` "PDF Tools"                             | ChamPDF-branded hero + privacy tagline; media/rebrand "Featured" band                       |
| `#tool-uploader` centered `max-w-2xl` card                                  | Same shell, restyled tokens; explicit in-browser vs. server-side trust chip                 |
| `#drop-zone` dashed gray box                                                | Friendlier rounded drop zone + multi-file list + "files never leave your device" microcopy  |
| `#options-section` radio rows / `.peer` cards                               | Consistent "option cards" component (selected = clay border + tint)                         |
| `#processing-status` + `.solid-spinner` + `#progress-bar`                   | Calm linear progress + status text + cancel; spinner only for quick ops                     |
| Separate `#download-section` / `#error-section` blocks                      | Unified success/error states sharing one styled component                                   |
| Phosphor (`ph-*`) **and** Lucide (`data-lucide`)                            | **Single** icon family (recommend Phosphor)                                                 |
| 6+ display fonts imported globally in `styles.css`                          | DM Sans (UI) + one serif (display); signature fonts lazy-loaded on relevant tools only      |
| Large unused animation library (wobble/flip/glow/floating/parallax)         | Small motion set: fade/slide ≤200ms, reduced-motion aware                                   |
| `.solid-spinner`, scrollbar, `#scroll-to-top-btn` in Champions red          | Re-themed to clay primary token                                                             |

---

_Brief prepared from a read-only review of `index.html`, `src/partials/{navbar,footer}.html`, `src/css/styles.css`, `src/js/config/tools.ts`, `src/pages/video-rebrander.html`, `src/pages/compress-pdf.html`, and `README.md`. No application code was modified._
