import { afterEach, vi } from 'vitest';

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

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
