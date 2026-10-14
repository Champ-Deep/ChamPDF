import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { AnnotationLayer } from '../js/components/pdf-signer/annotation-layer.js';
import { PDFSigner } from '../js/components/pdf-signer/index.js';
import { SignerToolbar } from '../js/components/pdf-signer/toolbar.js';
import type { Annotation } from '../js/components/pdf-signer/types.js';
import * as imageBackground from '../js/components/pdf-signer/image-background.js';
import { openSignatureLibrary } from '../js/utils/signature-library-init.js';

vi.mock('lucide', () => ({ createIcons: vi.fn(), icons: {} }));
vi.mock('../js/utils/signature-storage.js', () => ({
  getAllSignaturesWithImages: vi.fn(async () => []),
}));
vi.mock('../js/utils/signature-library-init.js', () => ({
  openSignatureLibrary: vi.fn(),
}));
vi.mock('../js/utils/helpers.js', () => ({ downloadFile: vi.fn() }));
vi.mock('../js/components/pdf-signer/pdf-renderer.js', () => ({
  PDFRenderer: class {
    async loadPDF() {
      return { totalPages: 2 };
    }
    async renderPage() {
      return { width: 600, height: 800 };
    }
    setScale() {}
  },
}));

function textAnnotation(text = ''): Annotation {
  return {
    id: 'text-1',
    type: 'text',
    page: 1,
    x: 10,
    y: 10,
    width: 40,
    height: 20,
    data: { text },
  };
}

function setupSigner() {
  document.body.innerHTML =
    '<div><div id="canvas"></div><div id="overlay"></div></div><div id="toolbar"></div>';
  return new PDFSigner(
    document.getElementById('canvas')!,
    document.getElementById('overlay')!,
    document.getElementById('toolbar')!
  );
}

async function settle() {
  await vi.waitFor(() =>
    expect(document.querySelector('.tool-btn[data-type="text"]')).not.toBeNull()
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('signing text boxes', () => {
  it.each(['initials', 'date'] as const)(
    'keeps %s values out of HTML attributes on rerender',
    (type) => {
      const container = document.createElement('div');
      const layer = new AnnotationLayer(container, vi.fn(), vi.fn());
      const annotation = textAnnotation('\"/><img src=x onerror=alert(1)>');
      annotation.type = type;
      layer.addAnnotation(annotation);
      expect(container.querySelector('input')!.value).toBe(
        annotation.data.text
      );
      expect(container.querySelector('img')).toBeNull();
      layer.destroy();
    }
  );

  it('preserves literal user text across rerenders without creating markup', () => {
    const container = document.createElement('div');
    const layer = new AnnotationLayer(container, vi.fn(), vi.fn());
    const text = '</textarea><img src=x onerror="alert(1)"> & <name>';
    layer.addAnnotation(textAnnotation(text));
    expect(container.querySelector('textarea')!.value).toBe(text);
    expect(container.querySelector('img')).toBeNull();
    layer.clear();
  });

  it('selects a text box when editing so toolbar settings target the correct field', () => {
    const onSelect = vi.fn();
    const container = document.createElement('div');
    const layer = new AnnotationLayer(container, vi.fn(), onSelect);
    layer.addAnnotation(textAnnotation());
    container.querySelector('textarea')!.click();
    expect(onSelect).toHaveBeenLastCalledWith('text-1');
    layer.clear();
  });

  it('customizes selected text and retains its style and content across page and zoom changes', async () => {
    const signer = setupSigner();
    await settle();
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    doc.addPage([600, 800]);
    const bytes = await doc.save();
    await signer.loadPDF({
      name: 'fixture.pdf',
      arrayBuffer: async () => bytes.buffer,
    } as File);
    (document.querySelector('[data-type="text"]') as HTMLButtonElement).click();
    const textarea = document.querySelector('textarea')!;
    textarea.value = 'Approved\nChampions';
    textarea.dispatchEvent(new Event('input'));
    const size = document.getElementById('text-font-size') as HTMLInputElement;
    expect(size).not.toBeNull();
    size.value = '20';
    size.dispatchEvent(new Event('change'));
    const color = document.getElementById('text-color') as HTMLInputElement;
    color.value = '#123456';
    color.dispatchEvent(new Event('input'));
    const font = document.getElementById(
      'text-font-family'
    ) as HTMLSelectElement;
    font.value = 'Courier';
    font.dispatchEvent(new Event('change'));
    expect(signer.getAnnotations()[0].data).toMatchObject({
      text: 'Approved\nChampions',
      fontSize: 20,
      color: '#123456',
      fontFamily: 'Courier',
    });
    await signer.nextPage();
    await signer.prevPage();
    await signer.setZoom(2);
    const restored = document.querySelector('textarea')!;
    expect(restored.value).toBe('Approved\nChampions');
    expect(restored.style.fontSize).toBe('40px');
    expect(restored.style.color).toBe('rgb(18, 52, 86)');
    expect(restored.style.fontFamily).toContain('Courier');
    await signer.savePDF();
    const { downloadFile } = await import('../js/utils/helpers.js');
    const blob = vi.mocked(downloadFile).mock.calls[0][0] as Blob;
    const savedBytes = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(blob);
    });
    const output = await PDFDocument.load(savedBytes);
    const contents = output
      .getPage(0)
      .node.Contents() as import('pdf-lib').PDFArray;
    const stream = output.context.lookup(contents.get(0)) as PDFRawStream;
    const commands = new TextDecoder().decode(
      decodePDFRawStream(stream).decode()
    );
    expect(commands).toContain('20 Tf');
    expect(commands).toContain(
      '0.07058823529411765 0.20392156862745098 0.33725490196078434 rg'
    );
    const resources = output.getPage(0).node.Resources()!;
    const fonts = resources.lookup(PDFName.of('Font'), PDFDict);
    const embeddedFont = output.context.lookup(fonts.values()[0], PDFDict);
    expect(embeddedFont.get(PDFName.of('BaseFont'))!.toString()).toBe(
      '/Courier'
    );
    expect(commands).toContain('417070726F766564');
    signer.destroy();
  });
});

describe('signing toolbar', () => {
  it('exports a checked checkbox without asking a Latin font to encode a checkmark', async () => {
    const signer = setupSigner();
    await settle();
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    doc.addPage([600, 800]);
    const bytes = await doc.save();
    await signer.loadPDF({
      name: 'fixture.pdf',
      arrayBuffer: async () => bytes.buffer,
    } as File);
    (
      document.querySelector('[data-type="checkbox"]') as HTMLButtonElement
    ).click();
    const checkbox = document.querySelector(
      '#overlay input[type="checkbox"]'
    ) as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await expect(signer.savePDF()).resolves.toBeUndefined();
    const { downloadFile } = await import('../js/utils/helpers.js');
    expect(downloadFile).toHaveBeenCalledOnce();
    signer.destroy();
  });

  it('removes and restores only the selected image, reprocessing from the original', async () => {
    const remove = vi
      .spyOn(imageBackground, 'removeImageBackground')
      .mockResolvedValue('data:image/png;base64,cleaned');
    const signer = setupSigner();
    await settle();
    document.getElementById('add-new-signature')!.click();
    vi.mocked(openSignatureLibrary).mock.calls[0][0]!(
      'data:image/png;base64,original'
    );
    document.getElementById('remove-image-background')!.click();
    await vi.waitFor(() =>
      expect(signer.getAnnotations()[0].data.imageUrl).toBe(
        'data:image/png;base64,cleaned'
      )
    );
    expect(signer.getAnnotations()[0].data.originalImageUrl).toBe(
      'data:image/png;base64,original'
    );
    await vi.waitFor(() =>
      expect(
        (
          document.getElementById(
            'remove-image-background'
          ) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    const tolerance = document.getElementById(
      'background-tolerance'
    ) as HTMLInputElement;
    tolerance.value = '10';
    document.getElementById('remove-image-background')!.click();
    await vi.waitFor(() =>
      expect(remove).toHaveBeenLastCalledWith(
        'data:image/png;base64,original',
        10
      )
    );
    await vi.waitFor(() =>
      expect(
        (
          document.getElementById(
            'restore-image-background'
          ) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    document.getElementById('restore-image-background')!.click();
    expect(signer.getAnnotations()[0].data.imageUrl).toBe(
      'data:image/png;base64,original'
    );
    expect(signer.getAnnotations()[0].data.originalImageUrl).toBeUndefined();
    signer.destroy();
  });

  it('keeps the original on processing failure and does not resurrect a deleted image', async () => {
    const remove = vi
      .spyOn(imageBackground, 'removeImageBackground')
      .mockRejectedValue(new Error('Decode failed'));
    const signer = setupSigner();
    await settle();
    document.getElementById('add-new-signature')!.click();
    vi.mocked(openSignatureLibrary).mock.calls[0][0]!(
      'data:image/png;base64,original'
    );
    document.getElementById('remove-image-background')!.click();
    await vi.waitFor(() =>
      expect(document.getElementById('signer-tool-status')!.textContent).toBe(
        'Decode failed'
      )
    );
    expect(signer.getAnnotations()[0].data).toMatchObject({
      imageUrl: 'data:image/png;base64,original',
    });
    let finish: (value: string) => void;
    remove.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    document.getElementById('remove-image-background')!.click();
    signer.deleteSelected();
    await expect(signer.savePDF()).rejects.toThrow(
      'Wait for image background cleanup'
    );
    finish!('data:image/png;base64,cleaned');
    await vi.waitFor(() =>
      expect(
        (
          document.getElementById(
            'remove-image-background'
          ) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    expect(signer.getAnnotations()).toHaveLength(0);
    expect(document.querySelector('#overlay img')).toBeNull();
    signer.destroy();
  });

  it('disconnects old drop and keyboard handlers when the editor is reset', async () => {
    const signer = setupSigner();
    await settle();
    signer.destroy();
    const overlay = document.getElementById('overlay')!;
    const event = new MouseEvent('drop', {
      clientX: 20,
      clientY: 20,
      bubbles: true,
    });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        getData: () =>
          JSON.stringify({
            type: 'signature',
            imageUrl: 'data:image/png;base64,old',
          }),
      },
    });
    overlay.dispatchEvent(event);
    expect(signer.getAnnotations()).toHaveLength(0);
  });

  it('does not delete the selected text box when a font selector receives Delete', async () => {
    const signer = setupSigner();
    await settle();
    (document.querySelector('[data-type="text"]') as HTMLButtonElement).click();
    document
      .getElementById('text-font-family')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })
      );
    expect(signer.getAnnotations()).toHaveLength(1);
    signer.destroy();
  });

  it('exposes a local image upload and a separate embedded-logo removal tool', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    new SignerToolbar(container, {
      onAddAnnotation: vi.fn(),
      onDeleteSelected: vi.fn(),
    });
    await settle();
    expect(
      container.querySelector(
        'input[type="file"][accept="image/png,image/jpeg"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelector('a[href$="remove-watermark.html"]')
    ).not.toBeNull();
  });
});
