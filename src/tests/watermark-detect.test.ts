// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PNG } from 'pngjs';
import {
  detectWatermark,
  buildGlyphMask,
  Raster,
  WatermarkBox,
} from '../js/logic/watermark-detect';

// External PNG fixtures produced by the real renderer. They live OUTSIDE the
// repo, so every fixture-backed case below is skipped when the directory is
// absent. Set CHAMPDF_WATERMARK_FIXTURES to the directory holding the six
// files (old-page1..3.png, new-page1..3.png) to run the full fixture matrix:
//   CHAMPDF_WATERMARK_FIXTURES=/Users/deep/repos/ChamPDF-fixtures/pages \
//     npx vitest run src/tests/watermark-detect.test.ts
const FIXTURE_DIR =
  process.env.CHAMPDF_WATERMARK_FIXTURES ??
  '/Users/deep/repos/ChamPDF-fixtures/pages';
const FIXTURE_NAMES = [
  'old-page1',
  'old-page2',
  'old-page3',
  'new-page1',
  'new-page2',
  'new-page3',
];
const hasFixtures = FIXTURE_NAMES.every((n) =>
  existsSync(join(FIXTURE_DIR, `${n}.png`))
);

// pngjs is a test-only dependency; production code stays dependency-free.
function readPng(filePath: string): Raster {
  const png = PNG.sync.read(readFileSync(filePath));
  return { width: png.width, height: png.height, data: png.data };
}

function loadFixtures(): Record<string, Raster> {
  const out: Record<string, Raster> = {};
  for (const name of FIXTURE_NAMES) {
    out[name] = readPng(join(FIXTURE_DIR, `${name}.png`));
  }
  return out;
}

/** IoU of two boxes, both expressed as page fractions. */
function iou(a: WatermarkBox, b: WatermarkBox): number {
  const ix = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  );
  const iy = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  );
  const inter = ix * iy;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function makeRaster(width: number, height: number, fill = 255): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill;
    data[i + 1] = fill;
    data[i + 2] = fill;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function fillRect(
  image: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  value: number
) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (image.width * yy + xx) << 2;
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
    }
  }
}

/** Moving "document content": random blocks well outside the search zone. */
function drawContent(image: Raster, seed: number) {
  let s = seed >>> 0;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0);
  for (let k = 0; k < 40; k++) {
    const r = rand();
    const x = (r % 460) | 0; // keeps blocks left of the x >= 0.65W zone
    const y = ((r >>> 8) % 560) | 0;
    const w = (40 + ((r >>> 16) % 80)) | 0;
    const h = (20 + ((r >>> 24) % 60)) | 0;
    fillRect(image, x, y, w, h, (60 + ((r >>> 4) % 160)) | 0);
  }
}

/**
 * Stable "icon + wordmark" lockup: six thin strokes on one baseline at the
 * bottom right, dimensions chosen so the padded box satisfies the lockup
 * geometry (aspect 2.5..9, height 1.5..5% of the page).
 */
const LOCKUP = { x: 640, y: 560, width: 54, height: 5 };
function drawLockup(image: Raster) {
  for (let k = 0; k < 6; k++) {
    fillRect(image, LOCKUP.x + k * 10, LOCKUP.y, 4, LOCKUP.height, 30);
  }
}

describe('detectWatermark (synthetic)', () => {
  it('returns null for a blank single page', () => {
    expect(detectWatermark([makeRaster(800, 600)])).toBeNull();
  });

  it('returns null for identical blank multi pages', () => {
    const pages = [
      makeRaster(800, 600),
      makeRaster(800, 600),
      makeRaster(800, 600),
    ];
    expect(detectWatermark(pages)).toBeNull();
  });

  it('finds a stable corner lockup across pages while content moves', () => {
    const pages: Raster[] = [];
    for (let f = 0; f < 3; f++) {
      const page = makeRaster(800, 600, 250);
      drawContent(page, 1234 + f * 7919);
      drawLockup(page);
      pages.push(page);
    }
    const box = detectWatermark(pages);
    expect(box).not.toBeNull();
    const found = box as WatermarkBox;
    // the padded box covers the lockup
    expect(found.x).toBeLessThanOrEqual(LOCKUP.x / 800);
    expect(found.y).toBeLessThanOrEqual(LOCKUP.y / 600);
    expect(found.x + found.width).toBeGreaterThanOrEqual(
      (LOCKUP.x + LOCKUP.width) / 800
    );
    expect(found.y + found.height).toBeGreaterThanOrEqual(
      (LOCKUP.y + LOCKUP.height) / 600
    );
    // and stays lockup-shaped (aspect measured in pixel space)
    expect(found.height).toBeGreaterThanOrEqual(0.015);
    expect(found.height).toBeLessThanOrEqual(0.05);
    const pixelAspect = (found.width * 800) / (found.height * 600);
    expect(pixelAspect).toBeGreaterThanOrEqual(2.5);
    expect(pixelAspect).toBeLessThanOrEqual(9);
  });

  it('survives full-page noise across frames (stable-only pixels)', () => {
    const pages: Raster[] = [];
    for (let f = 0; f < 3; f++) {
      const page = makeRaster(800, 600, 250);
      let s = (9871 + f * 104729) >>> 0;
      for (let i = 0; i < page.data.length; i += 4) {
        s = (s * 1664525 + 1013904223) >>> 0;
        const v = 140 + (s % 80);
        page.data[i] = v;
        page.data[i + 1] = v;
        page.data[i + 2] = v;
      }
      drawLockup(page);
      pages.push(page);
    }
    const box = detectWatermark(pages);
    expect(box).not.toBeNull();
    const found = box as WatermarkBox;
    expect(found.x).toBeLessThanOrEqual(LOCKUP.x / 800);
    expect(found.x + found.width).toBeGreaterThanOrEqual(
      (LOCKUP.x + LOCKUP.width) / 800
    );
  });

  it('finds the same lockup from a single frame via local contrast', () => {
    const page = makeRaster(800, 600, 250);
    drawLockup(page);
    const box = detectWatermark([page]);
    expect(box).not.toBeNull();
    const found = box as WatermarkBox;
    expect(found.x).toBeLessThanOrEqual(LOCKUP.x / 800);
    expect(found.x + found.width).toBeGreaterThanOrEqual(
      (LOCKUP.x + LOCKUP.width) / 800
    );
    expect(found.y + found.height).toBeGreaterThanOrEqual(
      (LOCKUP.y + LOCKUP.height) / 600
    );
  });

  it('detects dark-on-light and light-on-dark lockups equally', () => {
    // light ink on dark page
    const dark = makeRaster(800, 600, 30);
    for (let k = 0; k < 6; k++) {
      fillRect(dark, LOCKUP.x + k * 10, LOCKUP.y, 4, LOCKUP.height, 240);
    }
    const box = detectWatermark([dark]);
    expect(box).not.toBeNull();
    expect(box as WatermarkBox).toEqual(
      detectWatermark([makeRasterWhiteLockup()])
    );
  });
});

function makeRasterWhiteLockup(): Raster {
  const page = makeRaster(800, 600, 250);
  drawLockup(page);
  return page;
}

describe('buildGlyphMask (synthetic)', () => {
  it('keeps glyph strokes and does not fill the whole region', () => {
    const image = makeRaster(200, 120, 250);
    const region = { x: 40, y: 60, width: 100, height: 30 };
    for (let k = 0; k < 5; k++) {
      fillRect(image, region.x + 10 + k * 16, region.y + 8, 4, 14, 20);
    }
    const mask = buildGlyphMask(image, [region]);
    expect(mask.length).toBe(200 * 120);
    let ink = 0;
    for (const v of mask) if (v === 255) ink++;
    expect(ink).toBeGreaterThan(0);
    // far below the full rectangle: glyph-only, not region fill
    expect(ink).toBeLessThan(region.width * region.height * 0.5);
    // stroke centres are on
    expect(mask[(region.y + 15) * 200 + (region.x + 11)]).toBe(255);
    // outside the region (+ dilation radius) is untouched
    expect(mask[10 * 200 + 10]).toBe(0);
  });

  it('dilates strokes by exactly a 2px disk', () => {
    const image = makeRaster(60, 60, 250);
    fillRect(image, 30, 30, 2, 2, 10);
    const mask = buildGlyphMask(image, [
      { x: 20, y: 20, width: 20, height: 20 },
    ]);
    // seed occupies (30..31, 30..31); radius-2 disk reaches 33, not 34
    expect(mask[30 * 60 + 33]).toBe(255);
    expect(mask[30 * 60 + 34]).toBe(0);
    expect(mask[33 * 60 + 31]).toBe(255);
    expect(mask[34 * 60 + 31]).toBe(0);
  });

  it('returns an all-zero mask for a blank region', () => {
    const image = makeRaster(60, 60, 250);
    const mask = buildGlyphMask(image, [
      { x: 10, y: 10, width: 30, height: 30 },
    ]);
    for (const v of mask) expect(v).toBe(0);
  });

  it('masks only the requested regions on a multi-region call', () => {
    const image = makeRaster(120, 80, 250);
    fillRect(image, 10, 10, 6, 6, 20);
    fillRect(image, 60, 40, 6, 6, 20);
    const mask = buildGlyphMask(image, [
      { x: 55, y: 35, width: 20, height: 20 },
    ]);
    let ink = 0;
    for (let y = 35; y < 55; y++)
      for (let x = 55; x < 75; x++) if (mask[y * 120 + x]) ink++;
    expect(ink).toBeGreaterThan(0);
    // the first glyph lies outside the requested region: untouched
    expect(mask[12 * 120 + 12]).toBe(0);
  });
});

describe.skipIf(!hasFixtures)('detectWatermark (real fixtures)', () => {
  const fixtures = hasFixtures
    ? loadFixtures()
    : ({} as Record<string, Raster>);

  it('loads all six fixture pages', () => {
    expect(Object.keys(fixtures).sort()).toEqual([...FIXTURE_NAMES].sort());
    for (const name of FIXTURE_NAMES) {
      expect(fixtures[name].width).toBeGreaterThan(0);
      expect(fixtures[name].height).toBeGreaterThan(0);
    }
  });

  it('detects the new-style watermark with IoU >= 0.5 vs the confined crop', () => {
    const box = detectWatermark([
      fixtures['new-page1'],
      fixtures['new-page2'],
      fixtures['new-page3'],
    ]);
    expect(box).not.toBeNull();
    // Confined crop expectation: x in [0.90, 0.995], y in [0.94, 0.99]
    const reference: WatermarkBox = {
      x: 0.9,
      y: 0.94,
      width: 0.095,
      height: 0.05,
    };
    expect(iou(box as WatermarkBox, reference)).toBeGreaterThanOrEqual(0.5);
  });

  it('detects the old-style watermark in the same corner', () => {
    const box = detectWatermark([
      fixtures['old-page1'],
      fixtures['old-page2'],
      fixtures['old-page3'],
    ]);
    expect(box).not.toBeNull();
    const found = box as WatermarkBox;
    // bottom-right corner, inside the page
    expect(found.x).toBeGreaterThan(0.65);
    expect(found.y).toBeGreaterThan(0.85);
    expect(found.x + found.width).toBeLessThanOrEqual(1.001);
    expect(found.y + found.height).toBeLessThanOrEqual(1.001);
    // overlapping the new-style zone = same corner
    const reference: WatermarkBox = {
      x: 0.9,
      y: 0.94,
      width: 0.095,
      height: 0.05,
    };
    expect(iou(found, reference)).toBeGreaterThanOrEqual(0.3);
  });

  it('finds a watermark on every individual fixture page', () => {
    for (const name of FIXTURE_NAMES) {
      const box = detectWatermark([fixtures[name]]);
      if (!box) throw new Error(`${name} should detect a watermark`);
      expect(box.x).toBeGreaterThan(0.65);
      expect(box.y).toBeGreaterThan(0.85);
    }
  });

  it('builds a glyph mask over the detected watermark region', () => {
    const page = fixtures['new-page1'];
    const box = detectWatermark([
      fixtures['new-page1'],
      fixtures['new-page2'],
      fixtures['new-page3'],
    ]) as WatermarkBox;
    const region = {
      x: box.x * page.width,
      y: box.y * page.height,
      width: box.width * page.width,
      height: box.height * page.height,
    };
    const mask = buildGlyphMask(page, [region]);
    let ink = 0;
    const x1 = Math.floor(region.x + region.width);
    const y1 = Math.floor(region.y + region.height);
    for (let y = Math.floor(region.y); y < y1; y++) {
      for (let x = Math.floor(region.x); x < x1; x++) {
        if (mask[y * page.width + x]) ink++;
      }
    }
    const area = (x1 - Math.floor(region.x)) * (y1 - Math.floor(region.y));
    // glyph strokes only: clearly less than the full region rectangle
    expect(ink).toBeGreaterThan(100);
    expect(ink).toBeLessThan(area * 0.6);
  });
});
