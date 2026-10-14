import {
  buildGlyphMask,
  dilateMask,
  type Raster,
  type WatermarkBox,
} from './watermark-detect';

/** Cropped, undilated repeating glyph evidence in reference-page pixels. */
export interface WatermarkMask {
  pageWidth: number;
  pageHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Keep pixel evidence, not just its bounding box. Page-specific text and art
 * inside the padded detection box must never become automatic removal seeds.
 * Require contrast at the same location on every frame (one dropout allowed
 * with five or six samples for antialiasing/background variation). Polarity
 * is irrelevant. Manual and single-page selections still use local contrast.
 */
export function buildRepeatingWatermarkMask(
  pages: Raster[],
  box: WatermarkBox
): WatermarkMask | null {
  if (pages.length < 2) return null;
  const frames = pages.slice(0, 6);
  const ref = frames[0];
  const x = Math.max(0, Math.floor(box.x * ref.width));
  const y = Math.max(0, Math.floor(box.y * ref.height));
  const width =
    Math.min(ref.width, Math.ceil((box.x + box.width) * ref.width)) - x;
  const height =
    Math.min(ref.height, Math.ceil((box.y + box.height) * ref.height)) - y;
  if (width <= 0 || height <= 0) return null;
  const votes = new Uint8Array(width * height);
  for (const frame of frames) {
    const seeds = buildGlyphMask(
      frame,
      [
        {
          x: box.x * frame.width,
          y: box.y * frame.height,
          width: box.width * frame.width,
          height: box.height * frame.height,
        },
      ],
      false
    );
    for (let yy = 0; yy < height; yy++) {
      for (let xx = 0; xx < width; xx++) {
        const fx = Math.min(
          frame.width - 1,
          Math.floor(((x + xx + 0.5) * frame.width) / ref.width)
        );
        const fy = Math.min(
          frame.height - 1,
          Math.floor(((y + yy + 0.5) * frame.height) / ref.height)
        );
        if (seeds[fy * frame.width + fx]) votes[yy * width + xx]++;
      }
    }
  }
  const minimum = frames.length - (frames.length >= 5 ? 1 : 0);
  const data = votes.map((vote) => (vote >= minimum ? 255 : 0));
  // Reject isolated compression/noise specks without trimming real glyphs.
  const visited = new Uint8Array(data.length);
  for (let p = 0; p < data.length; p++) {
    if (!data[p] || visited[p]) continue;
    const pixels = [p];
    visited[p] = 1;
    for (let i = 0; i < pixels.length; i++) {
      const px = pixels[i] % width;
      const py = Math.floor(pixels[i] / width);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx,
            ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (data[q] && !visited[q]) {
            visited[q] = 1;
            pixels.push(q);
          }
        }
      }
    }
    if (pixels.length < 3) for (const q of pixels) data[q] = 0;
  }
  if (data.reduce((sum, value) => sum + Number(value > 0), 0) < 30) return null;
  return {
    pageWidth: ref.width,
    pageHeight: ref.height,
    x,
    y,
    width,
    height,
    data,
  };
}

/** Scale the same evidence to each page, then add the 2px inpaint margin. */
export function repeatingMaskToPixels(
  evidence: WatermarkMask,
  width: number,
  height: number
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const sx = width / evidence.pageWidth;
  const sy = height / evidence.pageHeight;
  for (
    let y = Math.max(0, Math.floor(evidence.y * sy));
    y < Math.min(height, Math.ceil((evidence.y + evidence.height) * sy));
    y++
  ) {
    for (
      let x = Math.max(0, Math.floor(evidence.x * sx));
      x < Math.min(width, Math.ceil((evidence.x + evidence.width) * sx));
      x++
    ) {
      const ex = Math.floor((x + 0.5) / sx) - evidence.x;
      const ey = Math.floor((y + 0.5) / sy) - evidence.y;
      if (
        ex >= 0 &&
        ey >= 0 &&
        ex < evidence.width &&
        ey < evidence.height &&
        evidence.data[ey * evidence.width + ex]
      )
        mask[y * width + x] = 255;
    }
  }
  return dilateMask(mask, width, height);
}
