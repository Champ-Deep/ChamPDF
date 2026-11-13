import { describe, it, expect, vi } from 'vitest';
import { AnnotationLayer } from '../js/components/pdf-signer/annotation-layer.js';
import { renderSignatureCanvas } from '../js/utils/signature-canvas.js';
import type { Annotation } from '../js/components/pdf-signer/types.js';

vi.mock('lucide', () => ({ createIcons: vi.fn(), icons: {} }));
vi.mock('../js/utils/helpers.js', () => ({
  escapeHtml: (value: string) => value,
}));
vi.mock('../js/utils/signature-storage.js', () => ({
  getAllSignaturesWithImages: async () => [],
}));
vi.mock('../js/utils/signature-library-init.js', () => ({
  openSignatureLibrary: vi.fn(),
}));
import { SignerToolbar } from '../js/components/pdf-signer/toolbar.js';

describe('signature fixes', () => {
  it('renders a transparent 3x canvas and fits long names without filling the background', () => {
    const canvas = document.createElement('canvas');
    const ctx = {
      scale: vi.fn(),
      measureText: () => ({ width: 1104 }),
      fillText: vi.fn(),
      fillRect: vi.fn(),
      font: '',
    };
    vi.spyOn(canvas, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D
    );
    renderSignatureCanvas(canvas, 'Long signature name', 'Kalam', '#000000');
    expect([canvas.width, canvas.height]).toEqual([1800, 600]);
    expect(ctx.scale).toHaveBeenCalledWith(3, 3);
    expect(ctx.font).toBe('24px "Kalam", cursive');
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it('keeps text literal, selects it on focus and scales points for preview zoom', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const select = vi.fn();
    const update = vi.fn();
    const layer = new AnnotationLayer(root, update, select);
    layer.setScale(1.25);
    const annotation: Annotation = {
      id: 'text',
      type: 'text',
      page: 1,
      x: 10,
      y: 10,
      width: 25,
      height: 8,
      data: { text: '</textarea><img src=x>', fontSize: 24 },
    };
    layer.addAnnotation(annotation);
    const input = root.querySelector('textarea')!;
    expect(input.value).toBe(annotation.data.text);
    expect(root.querySelector('img')).toBeNull();
    layer.updateAnnotationContent(annotation);
    const updatedInput = root.querySelector('textarea')!;
    expect(updatedInput.style.fontSize).toBe('30px');
    updatedInput.focus();
    expect(select).toHaveBeenCalledWith('text');
    updatedInput.value = 'Changed';
    updatedInput.dispatchEvent(new Event('input'));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ text: 'Changed', fontSize: 24 }),
      })
    );
  });

  it('shows one selected-text size control and rejects invalid edits', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const change = vi.fn();
    const toolbar = new SignerToolbar(root, {
      onAddAnnotation: vi.fn(),
      onDeleteSelected: vi.fn(),
      onUpdateTextStyle: change,
    });
    await toolbar.refresh();
    const input = root.querySelector<HTMLInputElement>('#text-font-size')!;
    expect(root.querySelectorAll('#text-font-size')).toHaveLength(1);
    expect(
      root.querySelector('#text-properties')?.classList.contains('hidden')
    ).toBe(true);
    expect(root.textContent).not.toContain(
      'Select a text field to change its size.'
    );
    toolbar.setSelection({
      id: 'text',
      type: 'text',
      page: 1,
      x: 0,
      y: 0,
      width: 25,
      height: 8,
      data: { fontSize: 24 },
    });
    expect(
      root.querySelector('#text-properties')?.classList.contains('hidden')
    ).toBe(false);
    expect(input.value).toBe('24');
    input.value = '500';
    input.dispatchEvent(new Event('change'));
    expect(change).not.toHaveBeenCalled();
    input.value = '';
    input.dispatchEvent(new Event('change'));
    expect(change).not.toHaveBeenCalled();
    input.value = '1';
    input.dispatchEvent(new Event('change'));
    expect(change).not.toHaveBeenCalled();
    input.value = '24';
    input.dispatchEvent(new Event('change'));
    expect(change).toHaveBeenLastCalledWith({ fontSize: 24 });
    toolbar.setSelection(null);
    expect(
      root.querySelector('#text-properties')?.classList.contains('hidden')
    ).toBe(true);
  });
});
