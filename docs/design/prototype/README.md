# ChamPDF V2 — Clickable UI Prototype

A **standalone, no-build** prototype of the proposed V2 UI. It's your interactive
wireframe — open it and click through the journeys before committing to the
high-fidelity design.

## Open it

Just open `index.html` in any browser (double-click, or):

```bash
# optional local server (nicer for fonts/CDN)
npx serve docs/design/prototype      # then visit the printed URL
# or
python3 -m http.server -d docs/design/prototype 4321   # http://localhost:4321
```

> Needs internet on first load (Tailwind, Lucide, Google Fonts via CDN).
> It is **not** connected to the real backend — it demonstrates UI/flow only.

## What to try

- **Search / ⌘K** (or click the search bar) — command palette across tools.
- **Featured · Media & Rebrand** cards and the **pillar filter** (All / Documents
  / Images / Video / Security / Convert).
- Open **PDF Watermark Remover** → walk the 4-step journey → on "Add logo",
  **drag the LOGO box** and move the **size slider** (this is issue #41).
- Toggle **light / dark** (top-right).

## Where this came from / where it goes

- Visual direction + rationale: `../CLAUDE_DESIGN_BRIEF.md`
- Full UX spec, tokens, journeys, component list, and Figma/Claude Design
  prompts: `../V2_UX_BLUEPRINT.md`
