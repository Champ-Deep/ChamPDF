# Watermark Templates (auto-detection)

Drop reference PNG crops of watermarks you want ChamPDF to locate **automatically**
into this folder. The backend (`watermark_detector.py`) runs multi-scale OpenCV
template matching against every `*.png` here.

## How to add a template

1. Take a clean screenshot of a video/image that contains the watermark.
2. Crop tightly around just the watermark/logo (e.g. the **NotebookLM** mark).
3. Save it here as a descriptive name, e.g.:
   - `notebooklm.png`
   - `notebooklm_dark.png` (a second crop for the dark-background variant)
4. Restart the backend (templates are cached on first use).

## Tips

- Provide a few crops at different sizes/backgrounds for more robust matching.
- Matching is grayscale and scale-invariant (0.4x–1.6x), so exact resolution
  doesn't matter, but a tight, high-contrast crop works best.
- Tune sensitivity with `WATERMARK_MATCH_THRESHOLD` in `config.py` / env
  (default `0.62`; raise to reduce false positives, lower to catch faint marks).

## Behaviour with no templates

If this folder is empty, auto-detection is disabled and tools fall back to:

- **Video rebrander** → the user-selected `watermark_position` heuristic.
- **Image watermark remover** → the user's manual selection box.

So the app stays fully functional without templates; templates simply enable the
one-click "auto-detect" path.

> ⚠️ Only remove watermarks from content you own or are licensed to modify
> (e.g. rebranding your own AI-generated marketing videos). Respect the terms of
> service of the tools that produced the content.
