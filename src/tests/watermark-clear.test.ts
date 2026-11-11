// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { clearDocumentMarks, Raster } from '../js/logic/watermark-detect';

function page(width: number, height: number): Raster {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  return { width, height, data };
}

function fill(
  r: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: [number, number, number]
) {
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * r.width + x) * 4;
      r.data[i] = rgb[0];
      r.data[i + 1] = rgb[1];
      r.data[i + 2] = rgb[2];
    }
}

function pixel(r: Raster, x: number, y: number) {
  const i = (y * r.width + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2]];
}

describe('clearDocumentMarks', () => {
  it('clears a pale grey mark and keeps the dark text it overlaps', () => {
    const img = page(200, 100);
    fill(img, 20, 20, 180, 80, [207, 207, 207]);
    fill(img, 40, 45, 160, 50, [0, 0, 0]);
    const cleared = clearDocumentMarks(img, [
      { x: 10, y: 10, width: 180, height: 80 },
    ]);
    expect(cleared).toBeGreaterThan(5000);
    expect(pixel(img, 30, 30)).toEqual([255, 255, 255]);
    expect(pixel(img, 100, 47)).toEqual([0, 0, 0]);
  });

  it('clears a coloured translucent stamp but keeps dark coloured headings', () => {
    const img = page(200, 100);
    fill(img, 20, 20, 180, 80, [242, 184, 184]);
    fill(img, 40, 30, 160, 36, [20, 40, 160]);
    clearDocumentMarks(img, [{ x: 0, y: 0, width: 200, height: 100 }]);
    expect(pixel(img, 25, 70)).toEqual([255, 255, 255]);
    expect(pixel(img, 100, 33)).toEqual([20, 40, 160]);
  });

  it('clears a pale stamp in a box with no text in it', () => {
    const img = page(200, 100);
    fill(img, 30, 30, 170, 70, [242, 184, 184]);
    clearDocumentMarks(img, [{ x: 10, y: 10, width: 180, height: 80 }]);
    expect(pixel(img, 100, 50)).toEqual([255, 255, 255]);
  });

  it('leaves pixels outside the region alone', () => {
    const img = page(200, 100);
    fill(img, 0, 0, 200, 100, [210, 210, 210]);
    fill(img, 0, 0, 200, 10, [255, 255, 255]);
    fill(img, 50, 50, 60, 60, [0, 0, 0]);
    clearDocumentMarks(img, [{ x: 0, y: 0, width: 100, height: 100 }]);
    expect(pixel(img, 150, 80)).toEqual([210, 210, 210]);
  });

  it('does nothing in a flat region', () => {
    const img = page(50, 50);
    expect(
      clearDocumentMarks(img, [{ x: 0, y: 0, width: 50, height: 50 }])
    ).toBe(0);
  });
});
