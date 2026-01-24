"""Background removal service using rembg ML model."""
import io
from pathlib import Path
from PIL import Image
from rembg import remove
import logging

logger = logging.getLogger(__name__)

class ImageProcessor:
    """Handles image background removal using ML."""

    def __init__(self):
        """Initialize the image processor."""
        # Model is auto-downloaded to ~/.u2net on first use
        logger.info("ImageProcessor initialized - model will download on first use")

    async def remove_background(
        self,
        input_bytes: bytes,
        output_format: str = "png"
    ) -> bytes:
        """
        Remove background from image using rembg ML model.

        Args:
            input_bytes: Input image bytes (PNG, JPG, WebP, etc.)
            output_format: Output format (default: png)

        Returns:
            Processed image bytes with transparent background
        """
        try:
            # Load input image
            input_image = Image.open(io.BytesIO(input_bytes))
            logger.info(f"Processing image: {input_image.size} - {input_image.mode}")

            # Remove background using rembg
            # This uses the U2Net model (automatic download ~176MB first run)
            output_image = remove(input_image)

            # Convert to bytes
            output_buffer = io.BytesIO()
            output_image.save(output_buffer, format=output_format.upper())
            output_bytes = output_buffer.getvalue()

            logger.info(f"Background removed successfully - output size: {len(output_bytes)} bytes")
            return output_bytes

        except Exception as e:
            logger.error(f"Background removal failed: {str(e)}")
            raise RuntimeError(f"Failed to process image: {str(e)}")
