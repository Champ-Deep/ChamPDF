# ChamPDF V2 — Design Handoff (for the frontend designer)

> **What this is:** the design brief for the V2 surfaces that the backend now
> makes possible. It **extends** — does not replace — the existing artifacts:
> read those first, then use this for the new/changed screens.
>
> - `docs/design/CLAUDE_DESIGN_BRIEF.md` — brand directions (recommend **A "Editorial Calm"**)
> - `docs/design/V2_UX_BLUEPRINT.md` — personas, journeys, IA, design system, ⌘K
> - `docs/design/prototype/index.html` — current hi-fi prototype + tokens
> - `docs/handoff/V2_ENGINEERING_HANDOFF.md` — the API/engine these screens sit on
>
> **Hand off to "Claude Design"** using the ready-to-paste prompts under each
> surface (§4). Deliverables checklist is in §7.

---

## 1. Brand locks (decided — design within these)

- **Trust / calm, professional.** This is an internal Champions-team tool for
  rebranding AI-generated media. Confident and quiet, not playful.
- **No mascot.** No chameleon character. Brand expressed through type, spacing,
  motion, and an honest privacy story — not a character.
- **Privacy is the headline.** The heavy lifting runs on **our own servers**; only
  a few features opt into an external model, and we **say so at the point of use**
  (see the privacy-chip system, §5). This is a differentiator — surface it.
- **Search + task + browse.** Three ways into 40+ tools: a ⌘K command palette
  (already specced), task-oriented entry ("remove a watermark"), and a calm
  browse grid by pillar (documents / images / video).
- **Motion with intent.** Subtle per-tool hover micro-animations on the grid;
  reserve richer motion for the Rebrand Studio hero. Never decorative-only.

---

## 2. The one big IA change: Rebrand Studio becomes the hero

Today the watermark/logo capabilities are scattered across separate tools (Video
Logo Remover, PDF Watermark Remover, Image Watermark Remover, AI Image Editor).
The backend can now drive **one guided flow** that picks the right engine by file
type. Design **Rebrand Studio** as the homepage hero; keep the 40+ utilities as
the calm browse grid beneath it.

**Rebrand Studio = the product.** The grid = the toolbox.

---

## 3. The mental model the design must communicate

Every "remove" action has a **speed / quality / privacy** trade-off, because the
backend has three engines. The design's job is to make that legible and
trustworthy at the moment of choice — not bury it.

| Engine                          | Used for                                | Where it runs | How to show it                |
| ------------------------------- | --------------------------------------- | ------------- | ----------------------------- |
| **LaMa** (self-hosted)          | image/PDF brush + box removal           | our servers   | `On our servers` chip (green) |
| **OpenCV/FFmpeg** (self-hosted) | "Fast (CPU)" video                      | our servers   | `On our servers` chip (green) |
| **ProPainter (Replicate)**      | "Best (GPU)" video                      | external GPU  | `External GPU` chip (amber)   |
| **Gemini / OpenRouter**         | prompt-edit, YouTube analyze, summaries | external AI   | `External AI` chip (amber)    |

---

## 4. Surfaces to design (purpose · layout · states · copy · prompt)

### 4.1 Rebrand Studio — the hero flow

**Purpose:** input → remove watermark → choose / place / size a logo → result, for
**any** media. One entry; the studio detects file type and routes:

- **PDF** → per-page render, mark the watermark, apply removal + logo to **all pages** (issue #41).
- **Image** → brush/box remove → logo.
- **Video** → Fast/Best remove → logo (audio preserved).

**Layout:** a 3–4 step guided flow with a persistent live preview and a right-side
controls rail. Steps: **1 Drop** → **2 Mark & remove** (§6 component) → **3 Brand
it** (choose logo · drag to place · slider to size) → **4 Result** (before/after,
download, "do more").

**States:** empty/drop · detecting-type · marking · processing (§4.5) · result ·
error/needs-setup (§4.6).

**Microcopy:** "Drop a PDF, image, or video — we'll detect it." · "Brand it:
choose a logo, drag it where you want, size it." · result: "Watermark removed,
[Champions] logo applied to all 12 pages."

**Claude Design prompt:**

> Design "Rebrand Studio" for ChamPDF — the hero flow that removes AI watermarks
> and rebrands media with a company logo. One guided 4-step flow (Drop → Mark &
> remove → Brand it → Result) with a large live preview and a right controls rail.
> It accepts PDF, image, or video and adapts: PDF shows page thumbnails and applies
> to all pages; video shows a Fast/Best quality choice. Step 3 "Brand it" lets the
> user pick a logo (Champions / LakeB2B / Ampliz / upload), drag it on the preview,
> and resize with a slider. Calm, trustworthy, no mascot; dark UI per the existing
> tokens. Show every state: drop, marking, processing (staged progress), result
> (before/after + download + "do more"), and a quiet "needs setup" state. Include
> a privacy chip on each engine choice.

### 4.2 AI Image Editor — two modes

**Purpose:** the renamed Edit Banana. Two modes over one image:

- **Prompt edit** (external AI, Gemini): describe a change.
- **Remove (brush)** (our servers, LaMa): paint over a watermark/object → erased.

**Layout:** a segmented **mode toggle** at top; below it either the prompt panel
(source + textarea + suggestion chips) or the brush panel (canvas + brush-size +
auto-detect + clear). Shared action row + result (before/after). Result can be
**piped back** as the new source (chaining).

**States:** pick-image · prompt-ready / mask-painted · processing · result · error.
Prompt mode shows a "needs setup" state when no Gemini key.

**Microcopy:** mode labels "Prompt edit" / "Remove (brush)"; brush hint "Paint over
what you want gone — we rebuild it from the surrounding pixels (on our servers)."

**Claude Design prompt:**

> Design the ChamPDF "AI Image Editor" with a segmented toggle between two modes:
> "Prompt edit" (describe a change) and "Remove (brush)" (paint a mask to erase an
> object). Brush mode: image on a canvas with an orange semi-transparent brush,
> a brush-size slider, "Auto-detect" and "Clear mask" buttons. Show before/after
> results with "Download" and "Edit result further". Add privacy chips: brush =
> "On our servers", prompt = "External AI". Dark theme, calm, no mascot.

### 4.3 Fast (CPU) / Best (GPU) quality toggle — reusable pattern

**Purpose:** on the video remover (and anywhere with an engine choice), let the
user trade speed for quality, **with the privacy cost visible**.

**Layout:** two cards. Each: title, one-line trade-off, and a **privacy chip**.
"Best" shows a small note that it runs on an external GPU and can take longer.

**Microcopy:** Fast — "Instant, good for flat backgrounds · On our servers."
Best — "Cleaner on detailed scenes · External GPU · can take a few minutes."

**Claude Design prompt:**

> Design a two-card quality selector: "Fast (CPU)" and "Best (GPU)". Each card has
> an icon, a one-line trade-off, and a privacy chip ("On our servers" green /
> "External GPU" amber). Selecting "Best" reveals a calm note that it runs on an
> external GPU service and can take a few minutes. Match the existing dark tokens.

### 4.4 Analyze video (AI) — results panel

**Purpose:** in the Video Downloader, a YouTube link → AI \*\*summary + key learnings

- chapters\*\* (Gemini), alongside the existing transcript/transcript+summary.

**Layout:** an output-type selector that now includes "Analyze video (AI)". Results
panel: **Summary** card → **Key learnings** (bulleted) → **Chapters** (timestamp ·
title list, click to copy) → existing transcript block (collapsible) + Download .txt.

**States:** idle · analyzing (§4.5) · results · "needs setup" (no Gemini → falls
back to transcript, tell the user it did).

**Claude Design prompt:**

> Design a "video insights" results panel for a YouTube URL: a Summary card, a
> "Key learnings" bulleted list, a "Chapters" list (timestamp + title, copyable),
> and a collapsible full transcript with a Download .txt button. Above it, an
> output-type selector: Transcript / Transcript + Summary / Analyze video (AI).
> Privacy chip "External AI". Dark, scannable, calm.

### 4.5 Long-running / async states (critical for trust)

**Purpose:** GPU video + transcription run for **minutes**, sometimes externally.
Replace the held spinner with **honest staged progress**.

**Layout:** a stepper/standby card with named stages and an active indicator:
`Uploading → Cleaning on GPU → Re-adding audio & logo → Done`. Include an
"external GPU, this can take a few minutes" reassurance and (future) the ability
to leave and be notified (the backend will move to a submit→poll job model).

**Claude Design prompt:**

> Design an honest long-running progress card for a multi-minute video job with
> named stages (Uploading → Cleaning on GPU → Re-adding audio & logo → Done), an
> active-stage indicator, elapsed time, and a calm "runs on an external GPU, can
> take a few minutes" line. Also design a "still working, you can leave this open"
> variant. Dark theme.

### 4.6 Capability-aware states (no dead ends)

**Purpose:** the backend exposes `/api/capabilities`; a feature whose key isn't set
must render a **quiet "needs setup"** state, never a raw error.

**Three states per AI action:** **available** (normal) · **needs setup** (muted,
"This feature isn't enabled on this server" + who to ask) · **running**.

**Claude Design prompt:**

> Design three states for an AI action button/card: available (normal), "needs
> setup" (muted/disabled with a short "not enabled on this server" explainer and a
> subtle info icon), and running. Calm, non-alarming; this is expected config, not
> a failure. Dark tokens.

---

## 5. The privacy-chip system (the trust expression)

A tiny, consistent chip shown wherever data is processed. Three values only:

- 🟢 **On our servers** — LaMa, OpenCV/FFmpeg, Whisper, Real-ESRGAN, rembg.
- 🟠 **External GPU** — ProPainter via Replicate (Best video).
- 🟠 **External AI** — Gemini / OpenRouter (prompt edit, analyze, summaries).

Spec one component, three variants, with a tooltip ("Processed on Champions'
own servers — files deleted after processing" / "Sent to an external GPU service
to do the heavy inpainting; deleted after"). Place at the point of choice, not
buried in a footer. This is the brand differentiator made literal.

---

## 6. The reusable "Mark & Place" component (build once, use everywhere)

Brush-mask (editor), rectangle-select (image/PDF watermark), and draggable +
resizable **logo overlay** (issue #41) are the same interaction family. Spec **one**
component with modes:

- **Paint** — brush a mask (size slider, semi-transparent orange, clear).
- **Box** — drag a rectangle selection.
- **Place** — drag + resize a logo overlay (corner handles, % size, snap to corners).
- Shared: touch + mouse, crosshair cursor, an **Auto-detect** action (pre-fills the
  watermark box/mask from the server), undo/clear, works over image **and** PDF page.

Reuse it in: Rebrand Studio (all media), AI Image Editor (paint), Image Watermark
Remover (box + place), PDF Watermark Remover (box + place, per page). It already
exists piecemeal in the codebase — unify the visual + interaction language.

**Claude Design prompt:**

> Design a reusable "Mark & Place" canvas component with three modes — Paint (brush
> a mask, size slider, clear), Box (drag a rectangle), and Place (drag + resize a
> logo overlay with corner handles and a % size readout, snapping to corners). It
> overlays an image or a PDF page, supports touch and mouse, has a crosshair cursor
> and an "Auto-detect watermark" action. Show all interaction states and the mobile
> layout. Dark tokens.

---

## 7. Deliverables checklist

- [ ] **Rebrand Studio** hero flow (4 steps, all states) — §4.1
- [ ] **AI Image Editor** two-mode layout — §4.2
- [ ] **Fast/Best quality** selector pattern — §4.3
- [ ] **Analyze video** results panel — §4.4
- [ ] **Long-running / async** progress + standby — §4.5
- [ ] **Capability-aware** available / needs-setup / running states — §4.6
- [ ] **Privacy chip** component (3 variants + tooltip) — §5
- [ ] **"Mark & Place"** canvas component (Paint / Box / Place, responsive) — §6
- [ ] Tokens/components consistent with `docs/design/prototype/index.html`
- [ ] Mobile layouts for the studio, editor, and Mark & Place

## 8. Notes for the build (so design and code stay aligned)

- The frontend reads `/api/capabilities` to know what's on — design the
  needs-setup state assuming that data exists.
- Results screens should offer **next actions** (re-edit, add logo, upscale,
  download), because the engine supports chaining — avoid a dead-end "Download".
- Logo identity (Champions / LakeB2B / Ampliz / upload) is a first-class branded
  step, not a dropdown.
- Keep the utility grid quiet; spend the richness budget on Rebrand Studio.
