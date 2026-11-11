import { describe, expect, it } from 'vitest';
import {
  fractionToPixels,
  pixelsToFraction,
  pointerFraction,
  resizeRegion,
  moveRegion,
  WatermarkRegionEditor,
} from '../js/logic/watermark-regions';
import type { WatermarkRegion } from '../js/types/remove-watermark-type';

const region: WatermarkRegion = {
  x: 0.9,
  y: 0.94,
  width: 0.095,
  height: 0.05,
  pageIndex: 2,
};

describe('region coordinate mapping', () => {
  it('preserves evidence on selection, clears it on manual edits, and retains it in undo snapshots', () => {
    const automatic = { ...region, autoMaskId: 42 };
    expect(moveRegion(automatic, 0, 0).autoMaskId).toBe(42);
    expect(resizeRegion(automatic, 'se', 0, 0, 0.01, 0.01).autoMaskId).toBe(42);
    expect(moveRegion(automatic, -0.01, 0).autoMaskId).toBeUndefined();
    expect(
      resizeRegion(automatic, 'se', -0.01, 0, 0.01, 0.01).autoMaskId
    ).toBeUndefined();
    expect(fractionToPixels(automatic, 1376, 768).autoMaskId).toBe(42);
  });
  it.each([
    [1376, 768],
    [2064, 1152],
    [2752, 1536],
    [473, 264],
  ])('round-trips at %ix%i render pixels', (width, height) => {
    const restored = pixelsToFraction(
      fractionToPixels(region, width, height),
      width,
      height
    );
    expect(restored.pageIndex).toBe(region.pageIndex);
    for (const coordinate of ['x', 'y', 'width', 'height'] as const) {
      expect(restored[coordinate]).toBeCloseTo(region[coordinate], 12);
    }
  });
  it('maps CSS pointer positions independently of canvas backing pixels', () => {
    expect(
      pointerFraction(550, 225, { left: 50, top: 25, width: 1000, height: 400 })
    ).toEqual({ x: 0.5, y: 0.5 });
    expect(
      pointerFraction(0, 1000, { left: 50, top: 25, width: 1000, height: 400 })
    ).toEqual({ x: 0, y: 1 });
  });
  it('clamps moved and resized boxes to the normalized page bounds', () => {
    expect(moveRegion(region, 0.5, 0.5).x + region.width).toBe(1);
    const resized = resizeRegion(region, 'se', 1, 1, 0.01, 0.01);
    expect(resized.x + resized.width).toBe(1);
    expect(resized.y + resized.height).toBe(1);
    const min = resizeRegion(region, 'nw', 1, 1, 0.02, 0.02);
    expect(min.width).toBeCloseTo(0.02);
    expect(min.height).toBeCloseTo(0.02);
  });
});

describe('DOM region editor', () => {
  it('draws, moves, resizes, cancels, and deletes without touching PDF canvas', () => {
    const wrapper = document.createElement('div');
    const canvas = document.createElement('canvas');
    const overlay = document.createElement('div');
    const info = document.createElement('div');
    wrapper.append(canvas, overlay, info);
    document.body.append(wrapper);
    const originalObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 500 }) as DOMRect;
    overlay.setPointerCapture = () => {};
    overlay.hasPointerCapture = () => false;
    let regions: WatermarkRegion[] = [];
    const editor = new WatermarkRegionEditor(
      canvas,
      overlay,
      info,
      () => regions,
      (value) => {
        regions = value;
      },
      () => 2
    );
    const pointer = (target: Element, type: string, x: number, y: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        button: 0,
      });
      Object.defineProperties(event, {
        pointerId: { value: 1 },
        isPrimary: { value: true },
      });
      target.dispatchEvent(event);
    };
    pointer(overlay, 'pointerdown', 900, 400);
    pointer(overlay, 'pointermove', 990, 480);
    pointer(overlay, 'pointerup', 990, 480);
    expect(regions).toHaveLength(1);
    expect(regions[0].pageIndex).toBe(2);
    expect(regions[0].x).toBeCloseTo(0.9);
    expect(regions[0].y).toBeCloseTo(0.8);
    expect(regions[0].width).toBeCloseTo(0.09);
    expect(regions[0].height).toBeCloseTo(0.16);
    pointer(overlay.querySelector('[data-region]')!, 'pointerdown', 950, 440);
    pointer(overlay, 'pointermove', 1100, 600);
    pointer(overlay, 'pointerup', 1100, 600);
    expect(regions[0].x + regions[0].width).toBe(1);
    expect(regions[0].y + regions[0].height).toBe(1);
    pointer(
      overlay.querySelector('[data-handle="nw"]')!,
      'pointerdown',
      910,
      400
    );
    pointer(overlay, 'pointermove', 970, 460);
    pointer(overlay, 'pointerup', 970, 460);
    expect(regions[0].width).toBeGreaterThanOrEqual(8 / 1000);
    expect(regions[0].height).toBeGreaterThanOrEqual(8 / 500);
    pointer(overlay, 'pointerdown', 100, 100);
    pointer(overlay, 'pointermove', 300, 250);
    overlay.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    expect(regions).toHaveLength(1);
    pointer(overlay.querySelector('[data-region]')!, 'pointerdown', 975, 465);
    pointer(overlay, 'pointerup', 975, 465);
    overlay.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })
    );
    expect(regions).toHaveLength(0);
    expect(canvas.width).toBe(300);
    globalThis.ResizeObserver = originalObserver;
    wrapper.remove();
  });

  it('edits only overlay DOM, supports delete, undo and clear', () => {
    const wrapper = document.createElement('div');
    const canvas = document.createElement('canvas');
    const overlay = document.createElement('div');
    const info = document.createElement('div');
    wrapper.append(canvas, overlay, info);
    document.body.append(wrapper);
    const originalObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    let regions: WatermarkRegion[] = [];
    const editor = new WatermarkRegionEditor(
      canvas,
      overlay,
      info,
      () => regions,
      (value) => {
        regions = value;
      },
      () => 2
    );
    editor.replace([{ ...region, autoMaskId: 42 }]);
    expect(overlay.querySelectorAll('[data-region]')).toHaveLength(1);
    expect(overlay.querySelectorAll('[data-handle]')).toHaveLength(0);
    expect(info.querySelectorAll('[data-delete-region]')).toHaveLength(1);
    (info.querySelector('[data-delete-region]') as HTMLElement).click();
    expect(regions).toHaveLength(0);
    editor.undo();
    expect(regions).toHaveLength(1);
    expect(regions[0].autoMaskId).toBe(42);
    editor.clear();
    expect(regions).toHaveLength(0);
    expect(canvas.width).toBe(300);
    globalThis.ResizeObserver = originalObserver;
    wrapper.remove();
  });
});
