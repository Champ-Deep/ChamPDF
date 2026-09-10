import { afterEach, vi } from 'vitest';

// Suites that opt into the node environment (`@vitest-environment node`, e.g.
// the mupdf-backed converters, whose WASM loader needs the node code path) have
// no DOM at all — every browser stub below has to be skipped for them.
const hasDom = typeof window !== 'undefined';

if (hasDom) {
  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });
}

global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

if (hasDom) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// jsdom doesn't implement DOMMatrix, which pdfjs-dist references on import.
// Provide a minimal stub so modules importing pdfjs (e.g. render-utils) can load.
if (typeof (globalThis as any).DOMMatrix === 'undefined') {
  class DOMMatrixStub {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    constructor(_init?: unknown) {}
    multiplySelf() {
      return this;
    }
    translateSelf() {
      return this;
    }
    scaleSelf() {
      return this;
    }
  }
  (globalThis as any).DOMMatrix = DOMMatrixStub;
}
