"""
ProPainter Wrapper - Optional GPU-accelerated video inpainting.

ProPainter (https://github.com/sczhou/ProPainter) provides state-of-the-art
video inpainting using flow-based temporal propagation. It requires:
  - CUDA-capable GPU with 7+ GB VRAM
  - PyTorch >= 1.7.1
  - ProPainter model files in ./weights/

This module is entirely optional. When ProPainter is not available,
the VideoProcessor automatically falls back to OpenCV inpainting
(which works well on CPU for small static logos like NotebookLM).

To enable ProPainter:
  1. Install PyTorch with CUDA support
  2. pip install -r propainter_requirements.txt
  3. Download model weights to ./weights/
  4. Set PROPAINTER_ENABLED=true in environment

Usage from video_processor.py is automatic when available.
"""

import os
import logging
from pathlib import Path
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# Check if ProPainter can be loaded
PROPAINTER_AVAILABLE = False
PROPAINTER_REASON = "Not checked yet"

def check_propainter_available() -> Tuple[bool, str]:
    """Check if ProPainter dependencies are available."""
    global PROPAINTER_AVAILABLE, PROPAINTER_REASON

    # Must be explicitly enabled
    if not os.environ.get("PROPAINTER_ENABLED", "").lower() in ("true", "1", "yes"):
        PROPAINTER_REASON = "PROPAINTER_ENABLED not set"
        PROPAINTER_AVAILABLE = False
        return False, PROPAINTER_REASON

    try:
        import torch
        if not torch.cuda.is_available():
            PROPAINTER_REASON = "CUDA not available"
            PROPAINTER_AVAILABLE = False
            return False, PROPAINTER_REASON

        vram_gb = torch.cuda.get_device_properties(0).total_mem / (1024**3)
        if vram_gb < 4:
            PROPAINTER_REASON = f"Insufficient VRAM: {vram_gb:.1f}GB (need 4+GB)"
            PROPAINTER_AVAILABLE = False
            return False, PROPAINTER_REASON

    except ImportError:
        PROPAINTER_REASON = "PyTorch not installed"
        PROPAINTER_AVAILABLE = False
        return False, PROPAINTER_REASON

    # Check for model weights
    weights_dir = Path(os.environ.get("PROPAINTER_WEIGHTS", "./weights"))
    required_models = [
        "ProPainter.pth",
        "recurrent_flow_completion.pth",
        "raft-things.pth",
    ]

    missing = [m for m in required_models if not (weights_dir / m).exists()]
    if missing:
        PROPAINTER_REASON = f"Missing model weights: {', '.join(missing)}"
        PROPAINTER_AVAILABLE = False
        return False, PROPAINTER_REASON

    PROPAINTER_AVAILABLE = True
    PROPAINTER_REASON = f"Ready (CUDA, {vram_gb:.1f}GB VRAM)"
    return True, PROPAINTER_REASON


def is_available() -> bool:
    """Return whether ProPainter is available for use."""
    return PROPAINTER_AVAILABLE


def get_status() -> str:
    """Return a human-readable status string."""
    return PROPAINTER_REASON


# Run check at import time
try:
    check_propainter_available()
    if PROPAINTER_AVAILABLE:
        logger.info(f"ProPainter: {PROPAINTER_REASON}")
    else:
        logger.debug(f"ProPainter not available: {PROPAINTER_REASON}")
except Exception as e:
    PROPAINTER_REASON = f"Check failed: {e}"
    logger.debug(f"ProPainter check error: {e}")
