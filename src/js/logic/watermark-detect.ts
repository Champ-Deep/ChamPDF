/**
 * Pure, on-device watermark detection for rendered page rasters.
 *
 * No dependencies. Works on any { width, height, data } RGBA raster (for
 * example the output of a PNG decoder or a canvas getImageData buffer).
 *
 * Coordinate contract:
 * - `detectWatermark` returns the watermark box as FRACTIONS of the page:
 *   { x, y } is the top-left corner, { width, height } the size, each
 *   normalized to [0, 1] against page width / height. Multiply by the page
 *   pixel dimensions to get a pixel box.
 * - `buildGlyphMask` takes REGIONS in PIXEL coordinates (top-left x/y plus
 *   pixel width/height) and returns a full-image single-channel mask.
 *
 * Detection strategy (see detectWatermark):
 * - Primary: multi-page pixel stability. The page chrome and any watermark
 *   are identical across sampled frames while document content moves, so
 *   pixels that stay stable in the bottom-right zone and differ from the
 *   dominant stable background colour are watermark candidates.
 * - Fallback (single frame): polarity-agnostic local-background contrast,
 *   i.e. pixels that stand out from the median luminance of their local
 *   cell, whatever the polarity of the ink.
 * In both modes candidates are grouped into lockup-like shapes (icon plus
 * wordmark on one baseline), padded, and validated against the expected
 * lockup geometry instead of a hardcoded bounding box.
 */

export interface Raster {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface WatermarkBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Component {
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Search zone: watermarks sit in the bottom-right corner of the page. */
const BR_X_FRACTION = 0.65;
const BR_Y_FRACTION = 0.85;

/** At most this many sampled frames take part in the stability vote. */
const MAX_FRAMES = 6;

/** Max luminance drift (0..255) for a pixel to count as stable. */
// Raster antialiasing and translucent ink can drift slightly across pages.
const STABILITY_TOLERANCE = 8;

/** Min summed per-channel distance from the stable background colour. */
const FOREGROUND_DISTANCE = 48;

/** Min |luminance - local background| for single-page contrast ink. */
const CONTRAST_TOLERANCE = 24;

/** Local background is the median luminance of this cell size (pixels). */
const BACKGROUND_CELL = 8;

/** Padding: at least 3px, or 2% of the page dimension, whichever is larger. */
const PAD_MIN_PIXELS = 3;
const PAD_FRACTION = 0.02;

/** Lockup-like geometry applied to the padded box. */
const ASPECT_MIN = 2.5;
const ASPECT_MAX = 9;
const HEIGHT_MIN_FRACTION = 0.015;
const HEIGHT_MAX_FRACTION = 0.05;

/** Ink density bounds: a lockup is strokes, not a solid block or hairline. */
const FILL_MIN = 0.1;
const FILL_MAX = 0.85;

/** Components smaller than this many pixels are noise. */
const MIN_COMPONENT_PIXELS = (regionWidth: number, regionHeight: number) =>
  Math.max(8, Math.floor((regionWidth * regionHeight) / 40000));

/** Two components join a lockup when they share a baseline and a small gap. */
const MIN_VERTICAL_OVERLAP = 0.6;
const MAX_HORIZONTAL_GAP_FACTOR = 4;
const MAX_HORIZONTAL_GAP_MIN = 40;

/** Rows/columns below this share of the densest row/column are trimmed. */
const TRIM_DENSITY = 0.25;

/** Below this many foreground pixels the stability vote is inconclusive. */
const MIN_STABLE_FOREGROUND = 30;

/** Dilation disk radius for buildGlyphMask, in pixels. */
const MASK_DILATE_RADIUS = 2;

function luminanceAt(image: Raster, x: number, y: number): number {
  const i = (image.width * y + x) << 2;
  return (
    0.299 * image.data[i] +
    0.587 * image.data[i + 1] +
    0.114 * image.data[i + 2]
  );
}

function colorKeyAt(image: Raster, x: number, y: number): number {
  const i = (image.width * y + x) << 2;
  return (
    ((image.data[i] >> 3) << 10) |
    ((image.data[i + 1] >> 3) << 5) |
    (image.data[i + 2] >> 3)
  );
}

function regionStarts(
  width: number,
  height: number
): {
  x0: number;
  y0: number;
} {
  return {
    x0: Math.floor(BR_X_FRACTION * width),
    y0: Math.floor(BR_Y_FRACTION * height),
  };
}

/** Luminance of frame k at the position mapped from page 0 coordinates. */
function mappedLuminance(
  frame: Raster,
  refWidth: number,
  refHeight: number,
  x: number,
  y: number
): number {
  const nx = Math.min(
    frame.width - 1,
    Math.round((x / refWidth) * frame.width)
  );
  const ny = Math.min(
    frame.height - 1,
    Math.round((y / refHeight) * frame.height)
  );
  return luminanceAt(frame, nx, ny);
}

/**
 * Pixels in the bottom-right zone whose luminance is stable across the
 * sampled frames.
 */
function stableMask(pages: Raster[], refWidth: number, refHeight: number) {
  const mask = new Uint8Array(refWidth * refHeight);
  const { x0, y0 } = regionStarts(refWidth, refHeight);
  for (let y = y0; y < refHeight; y++) {
    for (let x = x0; x < refWidth; x++) {
      const base = luminanceAt(pages[0], x, y);
      let stable = true;
      for (let k = 1; k < pages.length; k++) {
        const other = mappedLuminance(pages[k], refWidth, refHeight, x, y);
        if (Math.abs(other - base) > STABILITY_TOLERANCE) {
          stable = false;
          break;
        }
      }
      if (stable) mask[y * refWidth + x] = 1;
    }
  }
  return mask;
}

/** Dominant (5 bits per channel quantized) colour among masked pixels. */
function dominantColor(
  image: Raster,
  mask: Uint8Array,
  width: number
): { r: number; g: number; b: number } {
  const hist = new Map<number, number>();
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const key = colorKeyAt(image, p % width, Math.floor(p / width));
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  let bestKey = 0;
  let bestCount = -1;
  for (const [key, count] of hist) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  return {
    r: ((bestKey >> 10) & 31) << 3,
    g: ((bestKey >> 5) & 31) << 3,
    b: (bestKey & 31) << 3,
  };
}

/**
 * 8-connected components of a binary mask. Leading/trailing rows and columns
 * that carry less than TRIM_DENSITY of the densest row/column are dropped, so
 * a faint line brushing the lockup does not inflate its bounding box.
 */
function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minXBound: number,
  minYBound: number
): Component[] {
  const visited = new Uint8Array(mask.length);
  const components: Component[] = [];
  const stack: number[] = [];
  for (let y = minYBound; y < height; y++) {
    for (let x = minXBound; x < width; x++) {
      const seed = y * width + x;
      if (!mask[seed] || visited[seed]) continue;
      visited[seed] = 1;
      stack.push(seed);
      const pixels: number[] = [];
      while (stack.length) {
        const p = stack.pop() as number;
        pixels.push(p);
        const px = p % width;
        const py = Math.floor(p / width);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const qx = px + dx;
            const qy = py + dy;
            if (qx < minXBound || qy < minYBound || qx >= width || qy >= height)
              continue;
            const q = qy * width + qx;
            if (mask[q] && !visited[q]) {
              visited[q] = 1;
              stack.push(q);
            }
          }
        }
      }
      const component = trimComponent(pixels, width);
      if (component) components.push(component);
    }
  }
  return components;
}

/** Bounding box of a component after dropping sparse edge rows/columns. */
function trimComponent(pixels: number[], width: number): Component | null {
  if (!pixels.length) return null;
  let minX = width;
  let maxX = 0;
  let minY = Number.MAX_SAFE_INTEGER;
  let maxY = 0;
  for (const p of pixels) {
    const px = p % width;
    const py = Math.floor(p / width);
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const rowCounts = new Int32Array(maxY - minY + 1);
  const colCounts = new Int32Array(maxX - minX + 1);
  for (const p of pixels) {
    rowCounts[Math.floor(p / width) - minY]++;
    colCounts[(p % width) - minX]++;
  }
  let maxRow = 0;
  for (const c of rowCounts) if (c > maxRow) maxRow = c;
  let maxCol = 0;
  for (const c of colCounts) if (c > maxCol) maxCol = c;
  const rowFloor = Math.max(1, Math.floor(maxRow * TRIM_DENSITY));
  const colFloor = Math.max(1, Math.floor(maxCol * TRIM_DENSITY));
  let rowStart = 0;
  while (rowStart < rowCounts.length && rowCounts[rowStart] < rowFloor)
    rowStart++;
  let rowEnd = rowCounts.length - 1;
  while (rowEnd > rowStart && rowCounts[rowEnd] < rowFloor) rowEnd--;
  let colStart = 0;
  while (colStart < colCounts.length && colCounts[colStart] < colFloor)
    colStart++;
  let colEnd = colCounts.length - 1;
  while (colEnd > colStart && colCounts[colEnd] < colFloor) colEnd--;
  const bx0 = minX + colStart;
  const bx1 = minX + colEnd;
  const by0 = minY + rowStart;
  const by1 = minY + rowEnd;
  let count = 0;
  for (const p of pixels) {
    const px = p % width;
    const py = Math.floor(p / width);
    if (px >= bx0 && px <= bx1 && py >= by0 && py <= by1) count++;
  }
  return { count, minX: bx0, minY: by0, maxX: bx1, maxY: by1 };
}

interface Group {
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Join components that share a baseline (overlapping vertically) and sit
 * close horizontally: that is how an icon-plus-wordmark lockup is laid out.
 */
function groupIntoLockups(components: Component[]): Group[] {
  const sorted = [...components].sort((a, b) => a.minX - b.minX);
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      const overlap = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + 1;
      const minHeight = Math.min(a.maxY - a.minY + 1, b.maxY - b.minY + 1);
      const gap = Math.max(
        0,
        Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX) + 1
      );
      const maxGap = Math.max(
        MAX_HORIZONTAL_GAP_MIN,
        MAX_HORIZONTAL_GAP_FACTOR *
          Math.max(a.maxY - a.minY + 1, b.maxY - b.minY + 1)
      );
      if (
        minHeight > 0 &&
        overlap / minHeight >= MIN_VERTICAL_OVERLAP &&
        gap <= maxGap
      ) {
        union(i, j);
      }
    }
  }
  const byRoot = new Map<number, Group>();
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const root = find(i);
    const group = byRoot.get(root);
    if (!group) {
      byRoot.set(root, {
        count: c.count,
        minX: c.minX,
        minY: c.minY,
        maxX: c.maxX,
        maxY: c.maxY,
      });
    } else {
      group.count += c.count;
      group.minX = Math.min(group.minX, c.minX);
      group.minY = Math.min(group.minY, c.minY);
      group.maxX = Math.max(group.maxX, c.maxX);
      group.maxY = Math.max(group.maxY, c.maxY);
    }
  }
  return [...byRoot.values()];
}

/**
 * Pad a raw lockup box (at least 3px, or 2% of each page dimension, so the
 * returned zone tolerates sub-pixel render differences), clamp it to the
 * page, and keep only lockup-like shapes: aspect between 2.5 and 9 and a
 * height between 1.5% and 5% of the page.
 */
function padAndValidate(group: Group, width: number, height: number) {
  const padX = Math.max(PAD_MIN_PIXELS, Math.round(PAD_FRACTION * width));
  const padY = Math.max(PAD_MIN_PIXELS, Math.round(PAD_FRACTION * height));
  const x0 = Math.max(0, group.minX - padX);
  const y0 = Math.max(0, group.minY - padY);
  const x1 = Math.min(width - 1, group.maxX + padX);
  const y1 = Math.min(height - 1, group.maxY + padY);
  const boxWidth = x1 - x0 + 1;
  const boxHeight = y1 - y0 + 1;
  if (boxHeight <= 0 || boxWidth <= 0) return null;
  const aspect = boxWidth / boxHeight;
  if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) return null;
  const heightFraction = boxHeight / height;
  if (
    heightFraction < HEIGHT_MIN_FRACTION ||
    heightFraction > HEIGHT_MAX_FRACTION
  ) {
    return null;
  }
  const rawWidth = group.maxX - group.minX + 1;
  const rawHeight = group.maxY - group.minY + 1;
  const fill = group.count / (rawWidth * rawHeight);
  if (fill < FILL_MIN || fill > FILL_MAX) return null;
  return { x0, y0, x1, y1, width: boxWidth, height: boxHeight };
}

/** Pick the valid candidate closest to the bottom-right corner. */
function selectCandidate(
  candidates: { x0: number; y0: number; width: number; height: number }[],
  width: number,
  height: number
): WatermarkBox | null {
  let best: (typeof candidates)[number] | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const right = (c.x0 + c.width) / width;
    const bottom = (c.y0 + c.height) / height;
    const score = right + bottom;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (!best) return null;
  return {
    x: best.x0 / width,
    y: best.y0 / height,
    width: best.width / width,
    height: best.height / height,
  };
}

/** Multi-page mode: stable pixels that stand out from the stable background. */
function detectByStability(pages: Raster[]): WatermarkBox | null {
  const ref = pages[0];
  const { width, height } = ref;
  const { x0: zoneX, y0: zoneY } = regionStarts(width, height);
  const stable = stableMask(pages, width, height);
  const background = dominantColor(ref, stable, width);
  const foreground = new Uint8Array(stable.length);
  for (let y = zoneY; y < height; y++) {
    for (let x = zoneX; x < width; x++) {
      const p = y * width + x;
      if (!stable[p]) continue;
      const i = p << 2;
      const distance =
        Math.abs(ref.data[i] - background.r) +
        Math.abs(ref.data[i + 1] - background.g) +
        Math.abs(ref.data[i + 2] - background.b);
      if (distance > FOREGROUND_DISTANCE) foreground[p] = 1;
    }
  }
  let foregroundCount = 0;
  for (let p = 0; p < foreground.length; p++) {
    if (foreground[p]) foregroundCount++;
  }
  // When almost nothing separates from the dominant stable colour (for
  // example the only stable content on screen IS the watermark), the vote is
  // inconclusive: return null so the caller falls back to local contrast.
  if (foregroundCount < MIN_STABLE_FOREGROUND) return null;
  const byContrast = collectCandidates(foreground, width, height);
  if (byContrast) return byContrast;
  // The vote found repeated pixels but none separated from the dominant
  // stable colour (the watermark can itself be that dominant colour): retry
  // treating every stable pixel as candidate ink. The lockup geometry and
  // ink-density filters still apply.
  return collectCandidates(stable, width, height);
}

/** Single-page mode: polarity-agnostic local-background contrast ink. */
function detectByLocalContrast(page: Raster): WatermarkBox | null {
  const { width, height } = page;
  const { x0: zoneX, y0: zoneY } = regionStarts(width, height);
  const mask = new Uint8Array(width * height);
  const cellsX = Math.ceil(width / BACKGROUND_CELL);
  const cellsY = Math.ceil(height / BACKGROUND_CELL);
  const cellMedian = new Float64Array(cellsX * cellsY);
  const bucket: number[] = [];
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      bucket.length = 0;
      const ex = Math.min(width, (cx + 1) * BACKGROUND_CELL);
      const ey = Math.min(height, (cy + 1) * BACKGROUND_CELL);
      for (let y = cy * BACKGROUND_CELL; y < ey; y++) {
        for (let x = cx * BACKGROUND_CELL; x < ex; x++) {
          bucket.push(luminanceAt(page, x, y));
        }
      }
      bucket.sort((a, b) => a - b);
      cellMedian[cy * cellsX + cx] = bucket.length
        ? bucket[Math.floor(bucket.length / 2)]
        : 0;
    }
  }
  for (let y = zoneY; y < height; y++) {
    for (let x = zoneX; x < width; x++) {
      const median =
        cellMedian[
          Math.floor(y / BACKGROUND_CELL) * cellsX +
            Math.floor(x / BACKGROUND_CELL)
        ];
      if (Math.abs(luminanceAt(page, x, y) - median) > CONTRAST_TOLERANCE) {
        mask[y * width + x] = 1;
      }
    }
  }
  return collectCandidates(mask, width, height);
}

/** Shared tail of both modes: components, lockup grouping, validation. */
function collectCandidates(
  mask: Uint8Array,
  width: number,
  height: number
): WatermarkBox | null {
  const { x0: zoneX, y0: zoneY } = regionStarts(width, height);
  const components = connectedComponents(
    mask,
    width,
    height,
    zoneX,
    zoneY
  ).filter(
    (c) => c.count >= MIN_COMPONENT_PIXELS(width - zoneX, height - zoneY)
  );
  const groups = groupIntoLockups(components).map((g) =>
    trimGroupBand(g, mask, width)
  );
  const candidates: {
    x0: number;
    y0: number;
    width: number;
    height: number;
  }[] = [];
  for (const group of groups) {
    const box = padAndValidate(group, width, height);
    if (box) candidates.push(box);
  }
  return selectCandidate(candidates, width, height);
}

/**
 * Drop edge rows/columns of a group that carry less than TRIM_DENSITY of the
 * densest row/column: a stray speck glued to the lockup must not stretch the
 * padded box past the height cap. The pixel count is recomputed on the
 * trimmed box so the ink-density check stays honest.
 */
function trimGroupBand(group: Group, mask: Uint8Array, width: number): Group {
  const w = group.maxX - group.minX + 1;
  const h = group.maxY - group.minY + 1;
  const rowCounts = new Int32Array(h);
  const colCounts = new Int32Array(w);
  for (let y = group.minY; y <= group.maxY; y++) {
    for (let x = group.minX; x <= group.maxX; x++) {
      if (!mask[y * width + x]) continue;
      rowCounts[y - group.minY]++;
      colCounts[x - group.minX]++;
    }
  }
  let maxRow = 0;
  for (const c of rowCounts) if (c > maxRow) maxRow = c;
  let maxCol = 0;
  for (const c of colCounts) if (c > maxCol) maxCol = c;
  const rowFloor = Math.max(1, Math.floor(maxRow * TRIM_DENSITY));
  const colFloor = Math.max(1, Math.floor(maxCol * TRIM_DENSITY));
  let rowStart = 0;
  while (rowStart < h && rowCounts[rowStart] < rowFloor) rowStart++;
  let rowEnd = h - 1;
  while (rowEnd > rowStart && rowCounts[rowEnd] < rowFloor) rowEnd--;
  let colStart = 0;
  while (colStart < w && colCounts[colStart] < colFloor) colStart++;
  let colEnd = w - 1;
  while (colEnd > colStart && colCounts[colEnd] < colFloor) colEnd--;
  const minX = group.minX + colStart;
  const maxX = group.minX + colEnd;
  const minY = group.minY + rowStart;
  const maxY = group.minY + rowEnd;
  let count = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (mask[y * width + x]) count++;
    }
  }
  return { count, minX, minY, maxX, maxY };
}

/**
 * Detect a corner watermark in one or more sampled page frames.
 *
 * Pass up to 6 frames of the same document (screenshots or rendered pages).
 * With multiple frames the primary detector votes on pixel stability across
 * frames; with a single frame it falls back to local-background contrast.
 * Returns the watermark box as fractions of the page, or null when no
 * lockup-like watermark is found (for example a blank page).
 */
export function detectWatermark(pages: Raster[]): WatermarkBox | null {
  if (!pages.length) return null;
  const frames = pages.slice(0, MAX_FRAMES);
  if (frames.length > 1) {
    const found = detectByStability(frames);
    if (found) return found;
  }
  return detectByLocalContrast(frames[0]);
}

/**
 * Build a full-image single-channel mask (0 or 255) of the glyphs inside the
 * given pixel regions. Only pixels that contrast against their local
 * background are kept, then dilated by MASK_DILATE_RADIUS pixels, so the mask
 * follows the glyph strokes instead of filling the whole region rectangle.
 */
export function buildGlyphMask(
  image: Raster,
  regions: PixelRect[],
  dilate = true
): Uint8Array {
  const { width, height } = image;
  const mask = new Uint8Array(width * height);
  for (const region of regions) {
    const rx0 = Math.max(0, Math.floor(region.x));
    const ry0 = Math.max(0, Math.floor(region.y));
    const rx1 = Math.min(width - 1, Math.ceil(region.x + region.width) - 1);
    const ry1 = Math.min(height - 1, Math.ceil(region.y + region.height) - 1);
    if (rx1 < rx0 || ry1 < ry0) continue;
    const bucket: number[] = [];
    for (
      let cy = Math.floor(ry0 / BACKGROUND_CELL);
      cy <= Math.floor(ry1 / BACKGROUND_CELL);
      cy++
    ) {
      for (
        let cx = Math.floor(rx0 / BACKGROUND_CELL);
        cx <= Math.floor(rx1 / BACKGROUND_CELL);
        cx++
      ) {
        bucket.length = 0;
        const ex = Math.min(ry1, (cy + 1) * BACKGROUND_CELL - 1);
        const sx = Math.max(rx0, cx * BACKGROUND_CELL);
        const sy = Math.max(ry0, cy * BACKGROUND_CELL);
        for (let y = sy; y <= ex; y++) {
          const rowEnd = Math.min(rx1, (cx + 1) * BACKGROUND_CELL - 1);
          for (let x = sx; x <= rowEnd; x++) {
            bucket.push(luminanceAt(image, x, y));
          }
        }
        if (!bucket.length) continue;
        bucket.sort((a, b) => a - b);
        const median = bucket[Math.floor(bucket.length / 2)];
        for (let y = sy; y <= ex; y++) {
          const rowEnd = Math.min(rx1, (cx + 1) * BACKGROUND_CELL - 1);
          for (let x = sx; x <= rowEnd; x++) {
            if (
              Math.abs(luminanceAt(image, x, y) - median) > CONTRAST_TOLERANCE
            ) {
              mask[y * width + x] = 255;
            }
          }
        }
      }
    }
  }
  return dilate ? dilateMask(mask, width, height) : mask;
}

export function dilateMask(mask: Uint8Array, width: number, height: number) {
  // Dilate seeds by a radius-2 disk at the output resolution, not preview DPR.
  const seeds: number[] = [];
  for (let p = 0; p < mask.length; p++) if (mask[p]) seeds.push(p);
  const offsets: [number, number][] = [];
  for (let dy = -MASK_DILATE_RADIUS; dy <= MASK_DILATE_RADIUS; dy++) {
    for (let dx = -MASK_DILATE_RADIUS; dx <= MASK_DILATE_RADIUS; dx++) {
      if (dx * dx + dy * dy <= MASK_DILATE_RADIUS * MASK_DILATE_RADIUS) {
        offsets.push([dx, dy]);
      }
    }
  }
  for (const p of seeds) {
    const sx = p % width;
    const sy = Math.floor(p / width);
    for (const [dx, dy] of offsets) {
      const x = sx + dx;
      const y = sy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      mask[y * width + x] = 255;
    }
  }
  return mask;
}
