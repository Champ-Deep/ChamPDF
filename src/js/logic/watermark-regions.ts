import type { WatermarkRegion } from '../types/remove-watermark-type';

export const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));

/** No rounding here: round only when constructing a raster mask. */
export function fractionToPixels(
  region: WatermarkRegion,
  width: number,
  height: number
): WatermarkRegion {
  return {
    ...region,
    x: region.x * width,
    y: region.y * height,
    width: region.width * width,
    height: region.height * height,
  };
}

export function pixelsToFraction(
  region: WatermarkRegion,
  width: number,
  height: number
): WatermarkRegion {
  return {
    ...region,
    x: region.x / width,
    y: region.y / height,
    width: region.width / width,
    height: region.height / height,
  };
}

export function pointerFraction(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
) {
  return {
    x: clamp((clientX - rect.left) / rect.width),
    y: clamp((clientY - rect.top) / rect.height),
  };
}

export function moveRegion(
  region: WatermarkRegion,
  dx: number,
  dy: number
): WatermarkRegion {
  return {
    ...region,
    x: clamp(region.x + dx, 0, 1 - region.width),
    y: clamp(region.y + dy, 0, 1 - region.height),
    autoMaskId: dx === 0 && dy === 0 ? region.autoMaskId : undefined,
  };
}

export function resizeRegion(
  region: WatermarkRegion,
  handle: string,
  dx: number,
  dy: number,
  minWidth: number,
  minHeight: number
): WatermarkRegion {
  let { x, y } = region;
  let right = x + region.width;
  let bottom = y + region.height;
  if (handle.includes('w'))
    x = clamp(x + dx, 0, right - Math.min(minWidth, right));
  if (handle.includes('e'))
    right = clamp(right + dx, x + Math.min(minWidth, 1 - x), 1);
  if (handle.includes('n'))
    y = clamp(y + dy, 0, bottom - Math.min(minHeight, bottom));
  if (handle.includes('s'))
    bottom = clamp(bottom + dy, y + Math.min(minHeight, 1 - y), 1);
  return {
    ...region,
    x,
    y,
    width: right - x,
    height: bottom - y,
    autoMaskId: dx === 0 && dy === 0 ? region.autoMaskId : undefined,
  };
}

const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const copy = (regions: WatermarkRegion[]) => regions.map((r) => ({ ...r }));

type Gesture = {
  pointerId: number;
  mode: string;
  index: number;
  start: { x: number; y: number };
  original: WatermarkRegion;
  before: WatermarkRegion[];
};

/** DOM-only editor. It never reads or draws pixels on the PDF canvas. */
export class WatermarkRegionEditor {
  private selected = -1;
  private gesture: Gesture | null = null;
  private draft: WatermarkRegion | null = null;
  private history: WatermarkRegion[][] = [];
  private enabled = true;
  private observer: ResizeObserver;

  constructor(
    private canvas: HTMLCanvasElement,
    private overlay: HTMLElement,
    private info: HTMLElement,
    private getRegions: () => WatermarkRegion[],
    private setRegions: (regions: WatermarkRegion[]) => void,
    private getPageIndex: () => number
  ) {
    overlay.addEventListener('pointerdown', this.onDown);
    overlay.addEventListener('pointermove', this.onMove);
    overlay.addEventListener('pointerup', this.onUp);
    overlay.addEventListener('pointercancel', this.onCancel);
    overlay.addEventListener('lostpointercapture', this.onCancel);
    overlay.addEventListener('keydown', this.onKey);
    overlay.addEventListener('click', this.onDeleteClick);
    info.addEventListener('click', this.onDeleteClick);
    this.observer = new ResizeObserver(this.sync);
    this.observer.observe(canvas);
    if (canvas.parentElement) this.observer.observe(canvas.parentElement);
    window.addEventListener('resize', this.sync);
    this.sync();
  }

  sync = () => {
    const rect = this.canvas.getBoundingClientRect();
    Object.assign(this.overlay.style, {
      left: `${this.canvas.offsetLeft}px`,
      top: `${this.canvas.offsetTop}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };

  setEnabled(enabled: boolean) {
    this.cancel();
    this.enabled = enabled;
    this.overlay.hidden = !enabled;
    this.render();
  }

  reset() {
    this.cancel();
    this.history = [];
    this.selected = -1;
    this.setEnabled(true);
  }

  pageChanged() {
    this.cancel();
    this.selected = -1;
    this.sync();
    this.render();
  }

  replace(regions: WatermarkRegion[]) {
    this.cancel();
    this.history.push(copy(this.getRegions()));
    this.setRegions(copy(regions));
    this.selected = -1;
    this.render();
  }

  clear() {
    if (this.enabled) this.replace([]);
  }
  undo() {
    if (!this.enabled) return;
    this.cancel();
    const previous = this.history.pop();
    if (previous) this.setRegions(previous);
    this.selected = -1;
    this.render();
  }

  private remove(index: number) {
    if (!this.enabled || !this.getRegions()[index]) return;
    this.replace(this.getRegions().filter((_, i) => i !== index));
    this.overlay.focus({ preventScroll: true });
  }

  private onDeleteClick = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-delete-region]'
    );
    if (button) {
      event.preventDefault();
      this.remove(Number(button.dataset.deleteRegion));
    }
  };

  private onDown = (event: PointerEvent) => {
    if (!this.enabled || this.gesture || event.button !== 0 || !event.isPrimary)
      return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-delete-region]')) return;
    event.preventDefault();
    this.overlay.focus({ preventScroll: true });
    const start = pointerFraction(
      event.clientX,
      event.clientY,
      this.overlay.getBoundingClientRect()
    );
    const box = target.closest<HTMLElement>('[data-region]');
    const index = box ? Number(box.dataset.region) : -1;
    const original =
      index >= 0
        ? { ...this.getRegions()[index] }
        : { ...start, width: 0, height: 0, pageIndex: this.getPageIndex() };
    this.selected = index;
    this.gesture = {
      pointerId: event.pointerId,
      mode: target.dataset.handle || (box ? 'move' : 'draw'),
      index,
      start,
      original,
      before: copy(this.getRegions()),
    };
    if (!box) this.draft = original;
    this.overlay.setPointerCapture(event.pointerId);
    this.render();
  };

  private onMove = (event: PointerEvent) => {
    const g = this.gesture;
    if (!g || event.pointerId !== g.pointerId) return;
    const rect = this.overlay.getBoundingClientRect();
    const point = pointerFraction(event.clientX, event.clientY, rect);
    const dx = point.x - g.start.x;
    const dy = point.y - g.start.y;
    if (g.mode === 'draw') {
      this.draft = {
        x: Math.min(point.x, g.start.x),
        y: Math.min(point.y, g.start.y),
        width: Math.abs(dx),
        height: Math.abs(dy),
        pageIndex: this.getPageIndex(),
      };
    } else {
      const regions = [...this.getRegions()];
      regions[g.index] =
        g.mode === 'move'
          ? moveRegion(g.original, dx, dy)
          : resizeRegion(
              g.original,
              g.mode,
              dx,
              dy,
              8 / rect.width,
              8 / rect.height
            );
      this.setRegions(regions);
    }
    this.render();
  };

  private onUp = (event: PointerEvent) => {
    const g = this.gesture;
    if (!g || event.pointerId !== g.pointerId) return;
    this.onMove(event);
    const rect = this.overlay.getBoundingClientRect();
    if (
      this.draft &&
      this.draft.width * rect.width >= 8 &&
      this.draft.height * rect.height >= 8
    ) {
      this.setRegions([...this.getRegions(), this.draft]);
      this.selected = this.getRegions().length - 1;
    }
    if (JSON.stringify(g.before) !== JSON.stringify(this.getRegions()))
      this.history.push(g.before);
    this.finish();
    this.render();
  };

  private finish() {
    const id = this.gesture?.pointerId;
    this.gesture = null;
    this.draft = null;
    if (id !== undefined && this.overlay.hasPointerCapture(id))
      this.overlay.releasePointerCapture(id);
  }

  private cancel() {
    if (this.gesture) this.setRegions(this.gesture.before);
    this.finish();
  }

  private onCancel = () => {
    this.cancel();
    this.render();
  };
  private onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      this.cancel();
      this.render();
    }
    if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      this.selected >= 0
    ) {
      event.preventDefault();
      this.remove(this.selected);
    }
  };

  render() {
    this.overlay.replaceChildren();
    this.info.replaceChildren();
    const regions = this.getRegions();
    const summary = document.createElement('span');
    summary.className = 'text-sm text-gray-300';
    summary.textContent = `${regions.length} region${regions.length === 1 ? '' : 's'} selected`;
    this.info.append(summary);
    regions.forEach((region, index) => {
      if (region.pageIndex === this.getPageIndex())
        this.renderBox(region, index);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className =
        'rounded bg-gray-700 px-2 py-1 text-xs text-white hover:bg-gray-600';
      chip.dataset.deleteRegion = String(index);
      chip.disabled = !this.enabled;
      chip.textContent = `Page ${region.pageIndex + 1} · Region ${index + 1} ×`;
      chip.setAttribute(
        'aria-label',
        `Delete region ${index + 1} on page ${region.pageIndex + 1}`
      );
      this.info.append(chip);
    });
    if (this.draft) this.renderBox(this.draft, -1);
  }

  private renderBox(region: WatermarkRegion, index: number) {
    const box = document.createElement('div');
    box.className = 'absolute border-2';
    Object.assign(box.style, {
      left: `${region.x * 100}%`,
      top: `${region.y * 100}%`,
      width: `${region.width * 100}%`,
      height: `${region.height * 100}%`,
      borderColor: index === this.selected ? '#fb923c' : '#ef4444',
      background: 'rgba(239,68,68,0.18)',
      cursor: 'move',
      boxSizing: 'border-box',
    });
    if (index >= 0) {
      box.dataset.region = String(index);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.deleteRegion = String(index);
      button.textContent = '×';
      button.setAttribute('aria-label', `Delete region ${index + 1}`);
      Object.assign(button.style, {
        position: 'absolute',
        right: '2px',
        top: '2px',
        width: '20px',
        height: '20px',
        lineHeight: '18px',
        background: '#991b1b',
        color: '#fff',
        borderRadius: '4px',
        zIndex: '2',
        cursor: 'pointer',
      });
      box.append(button);
      if (index === this.selected)
        handles.forEach((handle) => {
          const node = document.createElement('span');
          node.dataset.handle = handle;
          Object.assign(node.style, {
            position: 'absolute',
            width: '12px',
            height: '12px',
            background: '#fff',
            border: '2px solid #c2410c',
            boxSizing: 'border-box',
            left: handle.includes('w')
              ? '0%'
              : handle.includes('e')
                ? '100%'
                : '50%',
            top: handle.includes('n')
              ? '0%'
              : handle.includes('s')
                ? '100%'
                : '50%',
            transform: 'translate(-50%, -50%)',
            cursor: `${handle}-resize`,
            zIndex: '3',
          });
          box.append(node);
        });
    } else box.style.pointerEvents = 'none';
    this.overlay.append(box);
  }
}
