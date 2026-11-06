# ChampPDF signature fixes

## 1. Visual theme

Preserve the existing document utility layout. This is a defect fix, not a redesign.

## 2. Color roles

Existing slate dialog and toolbar surfaces remain. New inputs use #374151 and explicit white text. Focus uses Champions bright orange #FF8544. Small primary action labels use white on #9A3412 for contrast.

## 3. Typography

Keep the host typography. Text annotation previews use Helvetica to match the PDF default. Font size is in PDF points, not screen pixels.

## 4. Components

Reuse the signature library dialog. Text size uses a vanilla port of Origin UI Input from 21st.dev, installed through shadcn on Node 24. No React runtime is added to this vanilla TypeScript app. The port retains the bordered input, disabled state and visible focus treatment, with a 44px minimum height.

## 5. Layout

Retain the existing toolbar and PDF viewer. The library scrolls internally and wraps color controls on phones.

## 6. Elevation

Keep the existing modal backdrop and shadow. No new floating surface.

## 7. Guardrails

Never claim account sync. Explicitly identify browser/device storage. PNG backgrounds remain transparent. Preserve existing signatures and storage namespaces.

## 8. Responsive behavior

Device class: pointer and touch web. Verify 375, 768 and 1440 widths. No new motion, no expressive tier. Native focus and keyboard input remain available.

## 9. Implementation guide

Carry text size through selected annotation state, preview zoom, page navigation and PDF export. Reuse the shared 3x canvas renderer in both signature creation paths. Keep auth and server storage out of this PR per the approved device-local ruling.
