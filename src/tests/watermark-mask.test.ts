// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
  buildGlyphMask,
  detectWatermark,
  type Raster,
} from '../js/logic/watermark-detect';
import {
  buildRepeatingWatermarkMask,
  repeatingMaskToPixels,
} from '../js/logic/watermark-mask';

function page(background: number, extraX: number): Raster {
  const data = new Uint8Array(800 * 600 * 4).fill(255);
  for (let p = 0; p < 800 * 600; p++) data.fill(background, p * 4, p * 4 + 3);
  const image = { width: 800, height: 600, data };
  for (const x of [704, 720, 736, 752, extraX]) {
    for (let y = 568; y < 575; y++)
      for (let xx = x; xx < x + 3; xx++) {
        const offset = (y * 800 + xx) * 4;
        data.fill(background < 100 ? 240 : 20, offset, offset + 3);
      }
  }
  return image;
}
const box = { x: 0.8, y: 0.9, width: 0.2, height: 0.1 };

describe('repeating glyph evidence', () => {
  it('excludes page-specific ink INSIDE the detection box while keeping repeating glyphs', () => {
    const samples = [page(250, 650), page(250, 665), page(250, 680)];
    const evidence = buildRepeatingWatermarkMask(samples, box)!;
    expect(evidence).not.toBeNull();
    const mask = repeatingMaskToPixels(evidence, 800, 600);
    for (const x of [650, 665, 680]) expect(mask[571 * 800 + x]).toBe(0);
    for (const x of [704, 720, 736, 752]) expect(mask[571 * 800 + x]).toBe(255);
    // The old fresh-per-page approach would erase this content.
    expect(
      buildGlyphMask(samples[0], [{ x: 640, y: 540, width: 160, height: 60 }])[
        571 * 800 + 650
      ]
    ).toBe(255);
  });

  it('is polarity agnostic across background changes', () => {
    const evidence = buildRepeatingWatermarkMask(
      [page(250, 650), page(30, 665), page(180, 680)],
      box
    )!;
    expect(evidence).not.toBeNull();
    expect(repeatingMaskToPixels(evidence, 800, 600)[571 * 800 + 704]).toBe(
      255
    );
  });

  it('maps evidence at another output size and dilates by 2 output pixels only', () => {
    const evidence = buildRepeatingWatermarkMask(
      [page(250, 650), page(250, 665)],
      box
    )!;
    const mask = repeatingMaskToPixels(evidence, 1600, 1200);
    expect(mask[1142 * 1600 + 1406]).toBe(255);
    expect(mask[1142 * 1600 + 1405]).toBe(0);
    expect(mask[1142 * 1600 + 1300]).toBe(0);
  });

  it('does not invent repeated evidence from one page or empty samples', () => {
    expect(buildRepeatingWatermarkMask([], box)).toBeNull();
    expect(buildRepeatingWatermarkMask([page(250, 650)], box)).toBeNull();
    const blank = {
      width: 100,
      height: 100,
      data: new Uint8Array(40000).fill(255),
    };
    expect(buildRepeatingWatermarkMask([blank, blank], box)).toBeNull();
  });
});

const fixtures =
  process.env.CHAMPDF_WATERMARK_FIXTURES ??
  '/Users/deep/repos/ChamPDF-fixtures/pages';
const available = ['old', 'new'].every((style) =>
  [1, 2, 3].every((n) => existsSync(join(fixtures, `${style}-page${n}.png`)))
);
describe.skipIf(!available)('real watermark evidence', () => {
  it.each(['new', 'old'])(
    'confines %s-style masks to glyphs, not nearby labels or borders',
    (style) => {
      const samples = [1, 2, 3].map((n) =>
        PNG.sync.read(readFileSync(join(fixtures, `${style}-page${n}.png`)))
      );
      const found = detectWatermark(samples)!;
      const evidence = buildRepeatingWatermarkMask(samples, found)!;
      expect(evidence).not.toBeNull();
      const mask = repeatingMaskToPixels(evidence, 1376, 768);
      let ink = 0,
        outside = 0;
      for (let y = 0; y < 768; y++)
        for (let x = 0; x < 1376; x++)
          if (mask[y * 1376 + x]) {
            ink++;
            // Independent native-pixel glyph envelope, not the padded detector bbox.
            if (x < 1266 || x >= 1372 || y < 744 || y >= 761) outside++;
          }
      expect(ink).toBeGreaterThan(400);
      expect(outside).toBe(0);
    }
  );
});
