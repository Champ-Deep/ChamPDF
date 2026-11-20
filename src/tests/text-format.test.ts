import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  drawTextBox,
  getTextStyle,
} from '../js/components/pdf-signer/text-style';
import type { Annotation } from '../js/components/pdf-signer/types';

const box = (data: Annotation['data']): Annotation => ({
  id: 't',
  type: 'text',
  page: 0,
  x: 10,
  y: 10,
  width: 60,
  height: 20,
  data,
});

describe('text box formatting', () => {
  it('defaults and sanitizes bold, italic and alignment', () => {
    expect(getTextStyle({})).toMatchObject({
      bold: false,
      italic: false,
      align: 'left',
    });
    expect(getTextStyle({ align: 'bogus' as never }).align).toBe('left');
  });

  it.each([
    ['Helvetica', 'Helvetica-BoldOblique'],
    ['TimesRoman', 'Times-BoldItalic'],
    ['Courier', 'Courier-BoldOblique'],
  ] as const)(
    'embeds the %s bold italic face in the PDF',
    async (fontFamily, face) => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([400, 400]);
      await drawTextBox(
        doc,
        page,
        box({
          text: 'Hello',
          fontFamily,
          bold: true,
          italic: true,
          align: 'right',
        })
      );
      const bytes = Buffer.from(
        await doc.save({ useObjectStreams: false })
      ).toString('latin1');
      expect(bytes).toContain(`/BaseFont /${face}`);
    }
  );
});
