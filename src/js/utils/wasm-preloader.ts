import { getLibreOfficeConverter } from './libreoffice-loader.js';
import loadGsWASM from '@bentopdf/gs-wasm';
import { setCachedGsModule } from './ghostscript-loader.js';
import { getWasmBaseUrl } from '../config/wasm-cdn-config.js';

export enum PreloadStatus {
  IDLE = 'idle',
  LOADING = 'loading',
  READY = 'ready',
  ERROR = 'error',
}

interface PreloadState {
  libreoffice: PreloadStatus;
  ghostscript: PreloadStatus;
}

const preloadState: PreloadState = {
  libreoffice: PreloadStatus.IDLE,
  ghostscript: PreloadStatus.IDLE,
};

export function getPreloadStatus(): Readonly<PreloadState> {
  return { ...preloadState };
}

async function preloadLibreOffice(): Promise<void> {
  if (preloadState.libreoffice !== PreloadStatus.IDLE) return;

  preloadState.libreoffice = PreloadStatus.LOADING;
  console.log('[Preloader] Starting LibreOffice WASM preload...');

  try {
    const converter = getLibreOfficeConverter();
    await converter.initialize();
    preloadState.libreoffice = PreloadStatus.READY;
    console.log('[Preloader] LibreOffice WASM ready');
  } catch (e) {
    preloadState.libreoffice = PreloadStatus.ERROR;
    console.warn('[Preloader] LibreOffice preload failed:', e);
  }
}

// PyMuPDF (Pyodide) preloading is gone with the mupdf.js migration: mupdf is a
// lazy chunk each tool imports on first use (~10MB, no Python VM to boot), so
// there is nothing worth warming eagerly on every page load anymore.

async function preloadGhostscript(): Promise<void> {
  if (preloadState.ghostscript !== PreloadStatus.IDLE) return;

  preloadState.ghostscript = PreloadStatus.LOADING;
  console.log('[Preloader] Starting Ghostscript WASM preload...');

  try {
    const gsBaseUrl = getWasmBaseUrl('ghostscript');
    const gsModule = await loadGsWASM({
      locateFile: (path: string) => {
        if (path.endsWith('.wasm')) {
          return gsBaseUrl + 'gs.wasm';
        }
        // Emscripten also probes for its glue/worker JS. Unmapped, that
        // resolves next to the bundled chunk (/assets/gs.js) and 404s on every
        // page load. The real file sits alongside gs.wasm.
        if (path.endsWith('.js')) {
          return gsBaseUrl + 'gs.js';
        }
        return path;
      },
      print: () => {},
      printErr: () => {},
    });
    setCachedGsModule(gsModule as any);
    preloadState.ghostscript = PreloadStatus.READY;
    console.log('[Preloader] Ghostscript WASM ready');
  } catch (e) {
    preloadState.ghostscript = PreloadStatus.ERROR;
    console.warn('[Preloader] Ghostscript preload failed:', e);
  }
}

function scheduleIdleTask(task: () => Promise<void>): void {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => task(), { timeout: 5000 });
  } else {
    setTimeout(() => task(), 1000);
  }
}

export function startBackgroundPreload(): void {
  console.log('[Preloader] Scheduling background WASM preloads...');

  const libreOfficePages = [
    'word-to-pdf',
    'excel-to-pdf',
    'ppt-to-pdf',
    'powerpoint-to-pdf',
    'docx-to-pdf',
    'xlsx-to-pdf',
    'pptx-to-pdf',
    'csv-to-pdf',
    'rtf-to-pdf',
    'odt-to-pdf',
    'ods-to-pdf',
    'odp-to-pdf',
  ];

  const currentPath = window.location.pathname;
  const isLibreOfficePage = libreOfficePages.some((page) =>
    currentPath.includes(page)
  );

  if (isLibreOfficePage) {
    console.log(
      '[Preloader] Skipping preloads on LibreOffice page to save memory'
    );
    return;
  }

  scheduleIdleTask(async () => {
    console.log('[Preloader] Starting Ghostscript WASM preload...');
    await preloadGhostscript();
    console.log('[Preloader] Preload complete');
  });
}
