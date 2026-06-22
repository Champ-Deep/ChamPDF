# ChamPDF V2 — UX Blueprint (wireframe + prototype kit)

Everything you need to design the V2 wireframes and high-fidelity prototype:
personas, user journeys, information architecture, screen specs, a component +
token system, state matrices, and ready-to-paste prompts for Figma / Claude
Design.

**Companion artifacts**

- `docs/design/prototype/index.html` — **clickable prototype** (open in a
  browser). Demonstrates the home IA, search/command palette, a tool page, and
  the headline _remove watermark → place logo → all pages_ journey with a
  working draggable logo + size slider. Not wired to a backend.
- `docs/design/CLAUDE_DESIGN_BRIEF.md` — the three visual directions + rationale.
  This blueprint assumes **Direction A "Editorial Calm"** (+ B's command palette,
  - C's per-category accent hue), the recommended pick.

---

## 0. Locked decisions (latest review) — read first

These override anything below if they conflict. They're the product calls made
after walking the prototype:

- **Hero = "Rebrand Studio", not a PDF toolkit.** The 119 PDF tools are the long
  tail / SEO. The star is: _drop any asset → get a Champion-branded asset._ Design
  should make the Studio the centerpiece of the home screen.
- **Rebrand Studio = one door** that walks: **Clean** (remove watermark) → **Brand**
  (drop logo, drag + size) → **Edit** (free AI image edit) → **Export**. It unifies
  these existing tools: Video Logo Remover, PDF Watermark Remover, Image Watermark
  Remover, and the **AI Image Editor** (the tool formerly shown as "Edit Banana" —
  renamed; never surface "Edit Banana"/"nano-banana" in the UI). The **Upscaler is
  NOT** part of the Studio — keep it a standalone tool.
- **Brand personality = trust / calm baseline.** No mascot, no full "chameleon"
  gimmick. Premium and gets out of the way. (Per-category hue is fine as a subtle
  accent, not a theme.)
- **Privacy story = internal team tool.** This deployment is for our own team and
  **everything is processed on our own servers → privacy-safe.** Do **not** use the
  public "100% in your browser" framing or per-tool in-browser/server badges from
  §3/§6 — that tension no longer applies. One simple "Processed on our private
  infrastructure" line is enough.
- **Discovery = search-first + task-first + browse**, and **each tool card should
  have a small hover micro-animation** that shows what the tool does (e.g., a 1–2s
  loop: watermark fading out, logo dropping in, pages converting). This is a key
  ask for the new design — make tool purpose legible on hover.
- **Header:** no version chip, no Docs/Self-host links (internal tool).
- **Converters are being de-duplicated** into bidirectional tools (Word⇄PDF,
  PowerPoint⇄PDF, Images⇄PDF) — design one card per pair with a direction that's
  auto-detected from the uploaded file.
- **Video Downloader is now "Video Downloader & Transcriber":** MP4/MP3 **plus**
  a full transcript (Whisper) and an optional AI summary (OpenRouter, model picker).
  Design needs a text-results panel (summary block + scrollable transcript + copy /
  download .txt), not just a file-download success state.

---

## 1. Personas

| Persona                       | Goal                                                                                       | Pain today                                                        | Success                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| **Marketer "Deep"** (primary) | Repurpose NotebookLM/AI media: strip the watermark, drop the company logo, ship to clients | Logo not movable/resizable; video failed on Railway; tools buried | Rebrands a PDF/video in < 2 min, logo exactly where they want |
| **Ops/Analyst**               | Convert & merge docs quickly (Word/PPT→PDF, merge, compress)                               | Has to hunt across 119 tools; some converters error               | Finds the tool in 1 search, converts first try                |
| **Privacy-conscious user**    | Edit a sensitive PDF without uploading                                                     | Unclear which tools are local vs server                           | Clear "in-browser" vs "server" labels; trusts it              |
| **Self-hoster/Dev**           | Deploy + point at own compute                                                              | Backend wiring opaque                                             | One `BACKEND_URL` knob, clear docs                            |

---

## 2. Primary user journeys

Numbers map to the prototype screens.

### J1 — Discover a tool (the 80% path)

```
Land on Home
  → (a) Search / ⌘K  →  type "watermark"  →  pick from results        ┐
  → (b) Scan "Featured · Media & Rebrand" band                        ├─→ Tool page
  → (c) Filter by pillar (Documents / Images / Video / Security)      ┘
```

Design implications: **search-first** top bar that opens a command palette;
a curated **Featured** band so the money tools aren't buried; pillar chips to
tame 119 tools. (Today everything is a flat grid — this is the biggest IA win.)

### J2 — Remove NotebookLM watermark from a PDF → rebrand (headline)

```
Upload PDF
  → Mark watermark (drag a box) OR ✨ Auto-detect
  → Remove (AI inpaint / OpenCV)               [Step rail: 2/4]
  → Add logo (optional):
        choose logo (LakeB2B / Champions / Ampliz / Upload / none)
        DRAG to position on the page preview
        SIZE with a slider (% of page width)
  → Apply to ALL pages → Download              [Step rail: 4/4]
  ↳ alt: "Download without logo"
```

This is the flow we shipped; the prototype shows it end-to-end. Key UX rules:
a persistent **4-step rail** so users know where they are; the logo step only
appears **after** removal; the page preview is the single source of truth for
"where will it land."

### J3 — Video logo remover / rebrand

```
Upload video → Auto-detect watermark (toggle) + pick logo + (toggle) burn captions
  → Process (server-side; show honest "processing on server, ~Ns" state)
  → Preview + Download
```

Implication: **honest async/long-running state** (video can take minutes) — a
progress + "this runs on our server" note, not a spinner that looks frozen.

### J4 — Image upscale / image watermark

```
Upload image → choose 2x/4x (or removal method) → Process → before/after → Download
```

Implication: a **before/after compare** affordance for upscaler & watermark
results (slider or toggle) builds trust in AI output.

---

## 3. Information architecture

- **Top-level pillars** (replace the long category strip with 3 + utility):
  - **Documents** · **Images** · **Video** · **Security** (+ "All", + Convert as a facet)
- **Surfacing model**: Search/⌘K (global) ▸ Featured band ▸ Pillar filter ▸ Grid.
- **Tool page** is a consistent shell (`#tool-uploader` today → propagate to ~110 pages):
  - Back · Icon+Title+Subtitle · **Step rail** · Body (state-driven) · Footer.
- **Labels**: every tool tagged **In-browser** vs **Server** (resolves the
  "100% private" vs server-side video tension flagged in the brief).

Sitemap: `Home` → `Tool` (one template, N instances) → `Result`. Secondary:
`Docs`, `Self-host`, `Pricing/Commercial` (footer).

---

## 4. Screen specs (wireframe annotations)

### 4.1 Home

- **Top bar (sticky):** logo+V2 chip · search field (opens palette, shows ⌘K) ·
  Docs/Self-host · theme toggle. Height 64.
- **Hero:** privacy chip · serif H1 · muted sub. Centered, generous whitespace.
- **Featured · Media & Rebrand:** 4 cards (Video Logo Remover, PDF Watermark
  Remover, Image Watermark Remover, AI Image Upscaler) with a "Server-powered AI" tag.
- **Pillar filter + grid:** chips (All/Documents/Images/Video/Security/Convert)
  → responsive 2–3-up cards. Card = hued icon chip + name + one-line subtitle.

### 4.2 Tool page

- Back link (accent) · icon chip (category hue) + title + subtitle.
- **Step rail** (1..n) reflecting the tool's journey.
- **Body** swaps by state: Upload → Configure → Process → Result (see §6).

### 4.3 Watermark→logo (J2) — the differentiator

- Step 2: page preview + drawn selection box + ✨ Auto-detect.
- Step 3: cleaned page preview + **draggable logo** + logo chips + **size slider**;
  primary "Apply to all pages & download", secondary "Download without logo".
- Step 4: success state + filename + Download / Start over.

### 4.4 Command palette (⌘K)

- Centered modal, search input, up to 8 results with hued icon + pillar label,
  keyboard nav, `esc` to close. The fastest path across 119 tools.

---

## 5. Design system

### Tokens (CSS variables — see prototype `:root` / `.dark`)

| Token              | Light     | Dark      | Use                              |
| ------------------ | --------- | --------- | -------------------------------- |
| `--bg`             | `#FAF7F2` | `#17140F` | page                             |
| `--surface`        | `#FFFFFF` | `#221D17` | cards                            |
| `--surface-2`      | `#F3EDE4` | `#2B251D` | wells, chips bg                  |
| `--border`         | `#E7E0D6` | `#3A3128` | hairlines                        |
| `--text`           | `#1A1A18` | `#EDE6DB` | body                             |
| `--text-muted`     | `#6B6457` | `#A89E8D` | secondary                        |
| `--primary` (clay) | `#C8552C` | `#E07A4F` | CTAs, active                     |
| **Category hues**  |           |           | icon chips, hover, active filter |
| `--c-documents`    | `#C8552C` | `#E07A4F` |                                  |
| `--c-images`       | `#0E8C8B` | `#3FB8B6` |                                  |
| `--c-video`        | `#7C5CE0` | `#A48BFF` |                                  |
| `--c-security`     | `#3F8F5B` | `#69C08A` |                                  |
| `--c-convert`      | `#2F6FEB` | `#6F9BFF` |                                  |

- **Type:** Display/headings **Fraunces** (serif); UI/body **DM Sans**. Trim the
  6+ display fonts currently loaded to these two.
- **Radii:** sm 8 · md 12 · xl 16 · 2xl 20. **Spacing** 4-pt scale.
- **Elevation:** mostly flat + 1px border; hover lifts cards `translateY(-2px)`.
- **Motion:** 200–250ms ease fades on state change; no flashy transitions.

### Component inventory (current → proposed)

| Current                                   | Proposed V2                                    |
| ----------------------------------------- | ---------------------------------------------- |
| Flat 119-card grid                        | Search + Featured + pillar-filtered grid       |
| Dual icon systems (Phosphor + Lucide)     | **One** family (Lucide)                        |
| Red/orange/gradient mix (`.btn-gradient`) | Single clay primary + category hues            |
| `#tool-uploader` shell, ad-hoc per page   | Shared shell with **Step rail** + state slots  |
| Spinner-only processing                   | Progress + honest "server / in-browser" copy   |
| Logo auto-anchored                        | **Draggable + sizable** logo overlay (shipped) |
| Dark-only                                 | Light + dark via one token layer               |

### Accessibility

- Don't rely on hue alone (category) — always pair with the icon + label.
- Contrast ≥ 4.5:1 for text on `--surface` in both themes.
- Full keyboard path: ⌘K palette, focus rings (`.ring-accent`), `esc` to close.
- Logo drag must have a keyboard/number alternative (X/Y/size inputs) for a11y.

---

## 6. State matrix (every tool body)

| State            | Shows                                                      | Notes                             |
| ---------------- | ---------------------------------------------------------- | --------------------------------- |
| Empty            | Dropzone + accepted formats + privacy line                 | default                           |
| File ready       | File chip (name/size) + options + primary CTA              |                                   |
| Processing       | Progress bar + status text + ("runs on server" if backend) | video may be minutes              |
| Result           | Preview / before-after + Download + "do another"           |                                   |
| Error            | Cause + recovery action (e.g., "backend unreachable")      | map server codes to plain English |
| Disabled feature | "This needs the server / a Gemini key" with how-to         | from `/api/capabilities`          |

---

## 7. Build the high-fi prototype

1. **Open the clickable prototype** (`docs/design/prototype/index.html`) to feel
   the flows; it's the low/mid-fi reference.
2. **Recreate in Figma** as: a token/style page → components (Card, IconChip,
   StepRail, Dropzone, Slider, LogoOverlay, Palette) → 4 frames (Home, Tool,
   Watermark-Logo, Palette) → wire prototype links (card→tool, CTA→next step).
3. Hand the prompts below to **Claude Design / Figma AI** to generate each frame,
   then refine.

### Copy-paste prompts

**Home**

> Design a calm, editorial home screen for "ChamPDF", a privacy-first PDF & media
> toolkit. Warm paper background #FAF7F2 (dark variant #17140F), clay primary
> #C8552C, serif display font (Fraunces) + DM Sans body. Sticky top bar with logo,
> a search field that reads "Search 119 tools…" with a ⌘K chip, and a light/dark
> toggle. Centered hero with a privacy pill and a serif H1 "Every PDF & media
> tool, in one calm place." A "Featured · Media & Rebrand" row of 4 cards (Video
> Logo Remover, PDF Watermark Remover, Image Watermark Remover, AI Image Upscaler).
> Below, pillar filter chips (All, Documents, Images, Video, Security, Convert) and
> a 3-up grid of tool cards; each card has a category-colored icon chip, name, and
> one-line subtitle. Category hues: Documents clay, Images teal #0E8C8B, Video
> violet #7C5CE0, Security green #3F8F5B, Convert blue #2F6FEB.

**Tool page + step rail**

> Design a tool page shell for ChamPDF using the same tokens. Top: back link in
> clay, a category-colored icon chip + serif title + muted subtitle. A horizontal
> 4-step progress rail (Upload → Configure → Process → Download) with the active
> step in clay. Below, a card containing a dashed dropzone empty-state ("Drop a
> file here", accepted formats, "your files stay private") and a clay primary CTA.

**Watermark → logo journey (the differentiator)**

> Design step 3 of the PDF Watermark Remover: "Add your logo (optional)". Left: a
> page preview (cleaned document) with a draggable logo box sitting bottom-right,
> selected state with a focus ring. Right: a logo picker (LakeB2B, Champions,
> Ampliz, Upload…, None) and a size slider "Size: 22% of page width". Footer
> buttons: clay primary "Apply to all pages & download" and a secondary "Download
> without logo". Include the success state: a green check, filename
> "watermark-removed-rebranded.pdf", Download + Start over.

**Command palette**

> Design a ⌘K command palette modal for ChamPDF: centered, rounded-2xl card, search
> input with an "esc" chip, and a list of up to 8 tool results — each a category-
> colored icon chip, tool name, and pillar label. Warm tokens, subtle fade-in.

---

## 8. Suggested first implementation slice (when design is approved)

Phased so it's shippable, matching the brief's rollout:

1. **Tokens + theme layer** (light/dark CSS vars) + unify on Lucide icons.
2. **Home**: search/palette + Featured band + pillar filter.
3. **Shared tool shell** (`#tool-uploader`) with the Step rail + state slots
   (propagates to ~110 pages).
4. **Media/rebrand flagships** polish (they're the showcase).
5. Cleanup: trim fonts, retire `.btn-gradient`, add in-browser/server labels.
