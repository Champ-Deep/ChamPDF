import { describe, expect, it } from 'vitest';
import {
  readSigningImage,
  removeLightPixels,
} from '../js/components/pdf-signer/image-background.js';

describe('local signing image cleanup', () => {
  it('removes white and light gray while preserving dark/colored ink and existing transparency', () => {
    const source = new Uint8ClampedArray([
      255, 255, 255, 255, 230, 230, 230, 255, 20, 30, 40, 255, 255, 0, 0, 255,
      10, 20, 30, 64,
    ]);
    const cleaned = removeLightPixels(source, 30);
    expect(Array.from(cleaned)).toEqual([
      255, 255, 255, 0, 230, 230, 230, 0, 20, 30, 40, 255, 255, 0, 0, 255, 10,
      20, 30, 64,
    ]);
    expect(source[3]).toBe(255);
    expect(source[7]).toBe(255);
  });
  it('uses tolerance explicitly and rejects invalid values', () => {
    const pixels = new Uint8ClampedArray([
      254, 255, 255, 255, 255, 255, 255, 255,
    ]);
    expect(Array.from(removeLightPixels(pixels, 0))).toEqual([
      254, 255, 255, 255, 255, 255, 255, 0,
    ]);
    for (const tolerance of [-1, 101, NaN, Infinity])
      expect(() => removeLightPixels(pixels, tolerance)).toThrow('tolerance');
  });
  it('rejects non-raster and oversized inputs before decoding', async () => {
    await expect(
      readSigningImage(
        new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' })
      )
    ).rejects.toThrow('PNG or JPEG');
    const tooLarge = { type: 'image/png', size: 10000001 } as File;
    await expect(readSigningImage(tooLarge)).rejects.toThrow('10 MB');
  });
});
