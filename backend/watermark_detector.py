"""
Watermark Detector - locate NotebookLM (and similar) watermarks automatically.

Uses multi-scale OpenCV template matching against reference logo PNGs placed in
`assets/watermark_templates/`. Returns pixel bounding boxes so the caller can
inpaint or `delogo` the exact region instead of relying on hardcoded coordinates.

Drop one or more reference crops of the watermark (transparent or solid PNG) into
the templates directory, e.g. `notebooklm.png`. If no template matches (or none
are installed) detection returns an empty list and the caller falls back to a
position-based heuristic.
"""

import logging
from pathlib import Path
from typing import List, Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)


class WatermarkDetector:
    def __init__(self, template_dir: Path, threshold: float = 0.62):
        self.template_dir = Path(template_dir)
        self.threshold = threshold
        self._templates: Optional[List[tuple[str, np.ndarray]]] = None

    def _load_templates(self) -> List[tuple[str, np.ndarray]]:
        """Load grayscale templates once. Empty list if directory is missing/empty."""
        if self._templates is not None:
            return self._templates
        templates: List[tuple[str, np.ndarray]] = []
        if self.template_dir.exists():
            for path in sorted(self.template_dir.glob("*.png")):
                img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
                if img is not None and img.size > 0:
                    templates.append((path.stem, img))
        if not templates:
            logger.info(
                "No watermark templates in %s — auto-detection disabled, "
                "caller will use heuristic region.",
                self.template_dir,
            )
        else:
            logger.info("Loaded %d watermark template(s)", len(templates))
        self._templates = templates
        return templates

    def has_templates(self) -> bool:
        return len(self._load_templates()) > 0

    def detect(self, image: np.ndarray) -> List[dict]:
        """
        Detect watermark regions in a BGR or grayscale image.
        Returns a list of {"x","y","w","h","score","label"} sorted by score desc.
        """
        templates = self._load_templates()
        if not templates:
            return []

        if image.ndim == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            gray = image
        img_h, img_w = gray.shape[:2]

        detections: List[dict] = []
        # Search a range of scales because the watermark size varies with resolution.
        scales = np.linspace(0.4, 1.6, 13)
        for label, template in templates:
            t_h0, t_w0 = template.shape[:2]
            best = None
            for scale in scales:
                t_w, t_h = int(t_w0 * scale), int(t_h0 * scale)
                if t_w < 12 or t_h < 8 or t_w > img_w or t_h > img_h:
                    continue
                resized = cv2.resize(template, (t_w, t_h), interpolation=cv2.INTER_AREA)
                res = cv2.matchTemplate(gray, resized, cv2.TM_CCOEFF_NORMED)
                _, max_val, _, max_loc = cv2.minMaxLoc(res)
                if best is None or max_val > best["score"]:
                    best = {
                        "x": int(max_loc[0]),
                        "y": int(max_loc[1]),
                        "w": t_w,
                        "h": t_h,
                        "score": float(max_val),
                        "label": label,
                    }
            if best and best["score"] >= self.threshold:
                detections.append(best)

        detections.sort(key=lambda d: d["score"], reverse=True)
        if detections:
            top = detections[0]
            logger.info(
                "Watermark detected: %s @ (%d,%d) %dx%d score=%.3f",
                top["label"], top["x"], top["y"], top["w"], top["h"], top["score"],
            )
        return detections

    def detect_in_video(self, video_path: str, sample_frames: int = 12) -> List[dict]:
        """
        Sample frames across a video and return the most consistently detected
        watermark box (median position). Empty list if nothing passes threshold.
        """
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return []
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        try:
            if total <= 0:
                idxs = list(range(sample_frames))
            else:
                idxs = np.linspace(0, max(total - 1, 0), sample_frames, dtype=int).tolist()

            hits: List[dict] = []
            for idx in idxs:
                cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
                ok, frame = cap.read()
                if not ok:
                    continue
                found = self.detect(frame)
                if found:
                    hits.append(found[0])
        finally:
            cap.release()

        if not hits:
            return []

        # Aggregate by median to be robust against single-frame false positives.
        agg = {
            "x": int(np.median([h["x"] for h in hits])),
            "y": int(np.median([h["y"] for h in hits])),
            "w": int(np.median([h["w"] for h in hits])),
            "h": int(np.median([h["h"] for h in hits])),
            "score": float(np.mean([h["score"] for h in hits])),
            "label": hits[0]["label"],
            "frames_hit": len(hits),
        }
        logger.info("Video watermark aggregated over %d/%d frames: %s", len(hits), len(idxs), agg)
        return [agg]
