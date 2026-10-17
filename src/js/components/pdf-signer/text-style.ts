import { StandardFonts, rgb, type PDFDocument, type PDFPage } from 'pdf-lib';
import type { Annotation, TextStyle } from './types.js';

export const TEXT_FONTS = {
  Helvetica: {
    label: 'Sans serif',
    css: 'Arial, Helvetica, sans-serif',
    pdf: StandardFonts.Helvetica,
  },
  TimesRoman: {
    label: 'Serif',
    css: '"Times New Roman", Times, serif',
    pdf: StandardFonts.TimesRoman,
  },
  Courier: {
    label: 'Monospace',
    css: '"Courier New", Courier, monospace',
    pdf: StandardFonts.Courier,
  },
};

export function getTextStyle(data: Annotation['data']): TextStyle {
  return {
    fontFamily:
      data.fontFamily && Object.hasOwn(TEXT_FONTS, data.fontFamily)
        ? data.fontFamily
        : 'Helvetica',
    fontSize: Number.isFinite(data.fontSize)
      ? Math.max(6, Math.min(72, data.fontSize!))
      : 12,
    color: /^#[0-9a-f]{6}$/i.test(data.color || '') ? data.color! : '#000000',
  };
}

export async function drawTextBox(
  doc: PDFDocument,
  page: PDFPage,
  annotation: Annotation
) {
  const text = annotation.data.text || '';
  if (!text) return;
  const style = getTextStyle(annotation.data);
  const font = await doc.embedFont(TEXT_FONTS[style.fontFamily].pdf);
  const { width, height } = page.getSize();
  const boxWidth = (annotation.width / 100) * width - 4;
  const boxHeight = (annotation.height / 100) * height - 4;
  const lineHeight = style.fontSize * 1.2;
  const lines: string[] = [];
  try {
    // Prefer word boundaries, but also wrap unbroken identifiers.
    for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
      let line = '';
      for (const char of paragraph.replace(/\t/g, '    ')) {
        if (font.widthOfTextAtSize(char, style.fontSize) > boxWidth) {
          throw new Error('Text box is too narrow.');
        }
        if (
          line &&
          font.widthOfTextAtSize(line + char, style.fontSize) > boxWidth
        ) {
          const breakAt = line.lastIndexOf(' ') + 1;
          if (breakAt > 0) {
            lines.push(line.slice(0, breakAt));
            line = line.slice(breakAt);
          } else {
            lines.push(line);
            line = '';
          }
        }
        line += char;
      }
      lines.push(line);
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Text box is too narrow.') {
      throw new Error(
        'Enlarge the text box or reduce its font size before saving.',
        { cause: error }
      );
    }
    throw new Error(
      'This text contains characters unsupported by the selected PDF font. Use Latin text or the PDF Editor for other scripts.',
      { cause: error }
    );
  }
  if (lines.length * lineHeight > boxHeight) {
    throw new Error(
      'Enlarge the text box or reduce its font size before saving.'
    );
  }
  const hex = style.color.slice(1);
  const color = rgb(
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255
  );
  const x = (annotation.x / 100) * width + 2;
  const top = height - (annotation.y / 100) * height - 2;
  lines.forEach((line, i) => {
    if (line)
      page.drawText(line, {
        x,
        y: top - style.fontSize - i * lineHeight,
        size: style.fontSize,
        font,
        color,
      });
  });
}
