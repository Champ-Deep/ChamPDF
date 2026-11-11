import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  drawTextBox,
  getTextStyle,
} from '../js/components/pdf-signer/text-style.js';
import type { Annotation } from '../js/components/pdf-signer/types.js';

function box(text: string, data: Partial<Annotation['data']> = {}): Annotation {
  return {
    id: 'box',
    type: 'text',
    page: 1,
    x: 10,
    y: 10,
    width: 25,
    height: 12,
    data: { text, ...data },
  };
}

describe('text box export', () => {
  it('validates styles and uses safe defaults for absent or invalid settings', () => {
    expect(getTextStyle({})).toEqual({
      fontFamily: 'Helvetica',
      fontSize: 12,
      color: '#000000',
    });
    expect(
      getTextStyle({ fontSize: 500, color: 'red', fontFamily: 'bad' as never })
    ).toEqual({ fontFamily: 'Helvetica', fontSize: 72, color: '#000000' });
    expect(getTextStyle({ fontSize: NaN })).toMatchObject({ fontSize: 12 });
  });
  it('wraps unbroken identifiers and preserves explicit blank lines', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const draw = vi.spyOn(page, 'drawText');
    await drawTextBox(
      doc,
      page,
      box('ABCDEF\n\nChampions', { fontFamily: 'Courier', fontSize: 20 })
    );
    expect(draw).toHaveBeenNthCalledWith(
      1,
      'ABCDEF',
      expect.objectContaining({ x: 62, y: 698, size: 20 })
    );
    expect(draw).toHaveBeenNthCalledWith(
      2,
      'Champions',
      expect.objectContaining({ y: 650 })
    );
    draw.mockClear();
    await drawTextBox(doc, page, {
      ...box('12345678901234567890', { fontFamily: 'Courier', fontSize: 20 }),
      width: 10,
      height: 30,
    });
    expect(draw.mock.calls.map(([text]) => text).join('')).toBe(
      '12345678901234567890'
    );
    for (const [text] of draw.mock.calls)
      expect(text.length).toBeLessThanOrEqual(4);
    await expect(doc.save()).resolves.toBeInstanceOf(Uint8Array);
  });
  it('wraps at word boundaries when words fit in the selected box', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const draw = vi.spyOn(page, 'drawText');
    await drawTextBox(
      doc,
      page,
      box('Approved Champions', { fontFamily: 'Courier', fontSize: 20 })
    );
    expect(draw.mock.calls.map(([text]) => text)).toEqual([
      'Approved ',
      'Champions',
    ]);
  });

  it('rejects overflowing text instead of losing or drawing outside the box', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    await expect(
      drawTextBox(doc, page, {
        ...box('Too large', { fontSize: 72 }),
        height: 3,
      })
    ).rejects.toThrow('Enlarge');
    await expect(
      drawTextBox(doc, page, { ...box('W', { fontSize: 72 }), width: 1 })
    ).rejects.toThrow('Enlarge');
  });
  it('reports unsupported characters clearly without claiming a successful export', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    await expect(drawTextBox(doc, page, box('你好'))).rejects.toThrow(
      'unsupported'
    );
  });
});
