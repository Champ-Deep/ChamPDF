import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { showAlert } from '../js/ui.js';
import { downloadFile } from '../js/utils/helpers.js';

vi.mock('lucide', () => ({ createIcons: vi.fn(), icons: {} }));
vi.mock('../js/ui.js', () => ({ showAlert: vi.fn() }));
vi.mock('../js/utils/helpers.js', () => ({
  formatBytes: (value: number) => `${value} bytes`,
  downloadFile: vi.fn(),
}));
vi.mock('../js/animations/tool-page-animations.js', () => ({
  initDropZoneAnimation: vi.fn(),
  animateFileRemoved: vi.fn(),
}));
vi.mock('../js/animations/modal-animations.js', () => ({
  celebrateSuccess: vi.fn(),
}));

function upload(file: File) {
  const input = document.getElementById('file-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change'));
}

function click(id: string) {
  document.getElementById(id)!.click();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:processed-file');
      static revokeObjectURL = vi.fn();
    }
  );
  document.body.innerHTML = `
    <input id="file-input" type="file">
    <button id="process-btn"></button>
    <button id="download-btn" class="hidden"></button>
    <button id="download-zip-btn"></button>
    <button id="process-another-btn"></button>
    <div id="drop-zone"></div>
    <div id="options-section" class="hidden"></div>
    <div id="file-display-area"></div>
    <div id="loader-modal" class="hidden"></div>
    <div id="process-progress"></div><div id="loader-text"></div>
    <div id="download-section" class="hidden"></div>
    <div id="result-status"></div><div id="batch-preview"></div>
    <div id="processing-status" class="hidden"></div>
    <div id="progress-bar"></div><div id="status-text"></div>
    <div id="status-detail"></div>
    <div id="error-section" class="hidden"><div id="error-message"></div></div>
    <input type="radio" name="logo-preset" value="none">
    <input type="radio" name="watermark-position" value="bottom-right">
  `;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('background removal upload and download', () => {
  it('makes a processed PNG available to download with the original basename', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'Content-Type': 'image/png' },
      })
    );
    await import('../js/logic/remove-bg-page.js');
    upload(new File(['image'], 'portrait.jpg', { type: 'image/jpeg' }));
    click('process-btn');
    await vi.waitFor(() =>
      expect(
        document
          .getElementById('download-section')!
          .classList.contains('hidden')
      ).toBe(false)
    );
    const [endpoint, options] = vi.mocked(fetch).mock.calls[0];
    expect(endpoint).toBe('/api/remove-background');
    expect((options!.body as FormData).get('output_format')).toBe('png');
    click('download-btn');
    expect(downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({ size: 4 }),
      'portrait_no_bg.png'
    );
  });

  it('explains an HTML 413 response and allows retry without a bogus download', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('<h1>413 Request Entity Too Large</h1>', { status: 413 })
    );
    await import('../js/logic/remove-bg-page.js');
    upload(new File(['image'], 'portrait.jpg', { type: 'image/jpeg' }));
    click('process-btn');
    await vi.waitFor(() => expect(showAlert).toHaveBeenCalled());
    expect(showAlert).toHaveBeenLastCalledWith(
      'Processing Failed',
      expect.stringMatching(/413.*10MB/)
    );
    expect(
      document.getElementById('loader-modal')!.classList.contains('hidden')
    ).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(
      new Response('png', { headers: { 'Content-Type': 'image/png' } })
    );
    click('process-btn');
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
  });

  it('does not treat a successful HTML fallback as a processed PNG', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('<html>Frontend</html>', {
        headers: { 'Content-Type': 'text/html' },
      })
    );
    await import('../js/logic/remove-bg-page.js');
    upload(new File(['image'], 'portrait.jpg', { type: 'image/jpeg' }));
    click('process-btn');
    await vi.waitFor(() => expect(showAlert).toHaveBeenCalled());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('video watermark removal upload and download', () => {
  it('sends remove-only and bottom-right settings and downloads the MP4', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('mp4', { headers: { 'Content-Type': 'video/mp4' } })
    );
    await import('../js/logic/video-rebrander-page.js');
    upload(new File(['video'], 'watermarked.mp4', { type: 'video/mp4' }));
    const radio = document.querySelector('input[value="none"]')!;
    radio.dispatchEvent(new Event('change'));
    click('process-btn');
    await vi.waitFor(() =>
      expect(
        document
          .getElementById('download-section')!
          .classList.contains('hidden')
      ).toBe(false)
    );
    const [endpoint, options] = vi.mocked(fetch).mock.calls[0];
    expect(endpoint).toBe('/api/process-video');
    const form = options!.body as FormData;
    expect(form.get('logo_preset')).toBe('none');
    expect(form.get('watermark_position')).toBe('bottom-right');
    expect(form.get('quality')).toBe('fast');
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    click('download-btn');
    const anchor = anchorClick.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('watermarked_rebranded.mp4');
    expect(anchor.href).toBe('blob:processed-file');
  });

  it.each([
    [413, /413.*100MB/],
    [502, /502.*backend/i],
    [504, /timed out.*504/i],
  ])('explains an HTML HTTP %s response', async (status, message) => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('<html>proxy error</html>', { status })
    );
    await import('../js/logic/video-rebrander-page.js');
    upload(new File(['video'], 'watermarked.mp4', { type: 'video/mp4' }));
    click('process-btn');
    await vi.waitFor(() =>
      expect(document.getElementById('error-message')!.textContent).toMatch(
        message
      )
    );
    expect(
      (document.getElementById('process-btn') as HTMLButtonElement).disabled
    ).toBe(false);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
