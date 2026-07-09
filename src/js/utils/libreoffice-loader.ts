/**
 * LibreOffice WASM Converter Wrapper
 *
 * Uses @matbee/libreoffice-converter package for document conversion.
 * Handles progress tracking and provides simpler API.
 */

import { WorkerBrowserConverter } from '@matbee/libreoffice-converter/browser';

const LIBREOFFICE_LOCAL_PATH = import.meta.env.BASE_URL + 'libreoffice-wasm/';

export interface LoadProgress {
  phase: 'loading' | 'initializing' | 'converting' | 'complete' | 'ready';
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: LoadProgress) => void;

// Singleton for converter instance
let converterInstance: LibreOfficeConverter | null = null;

const INIT_TIMEOUT_MS = 120_000; // 2 minutes for WASM download + init
const CONVERT_TIMEOUT_MS = 180_000; // 3 minutes per file conversion

/** Race a promise against a timeout; rejects with a clear message on expiry. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class LibreOfficeConverter {
  private converter: WorkerBrowserConverter | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private initError: Error | null = null;
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath || LIBREOFFICE_LOCAL_PATH;
  }

  async initialize(onProgress?: ProgressCallback): Promise<void> {
    if (this.initialized) return;

    // If a previous attempt failed, let the caller know immediately.
    if (this.initError) {
      throw this.initError;
    }

    // If another call is already initializing, piggy-back on its promise.
    if (this.initPromise) {
      await this.initPromise;
      if (this.initError) throw this.initError;
      return;
    }

    this.initPromise = this._doInitialize(onProgress);

    try {
      await this.initPromise;
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err));
      throw this.initError;
    } finally {
      this.initPromise = null;
    }
  }

  private async _doInitialize(onProgress?: ProgressCallback): Promise<void> {
    let progressCallback = onProgress;

    progressCallback?.({
      phase: 'loading',
      percent: 0,
      message: 'Loading conversion engine...',
    });

    // Capture async errors emitted through the onError callback so we can
    // surface them to the caller rather than silently swallowing them.
    let rejectOnError: ((err: Error) => void) | null = null;
    const asyncErrorPromise = new Promise<never>((_, reject) => {
      rejectOnError = reject;
    });

    this.converter = new WorkerBrowserConverter({
      sofficeJs: `${this.basePath}soffice.js`,
      sofficeWasm: `${this.basePath}soffice.wasm.gz`,
      sofficeData: `${this.basePath}soffice.data.gz`,
      sofficeWorkerJs: `${this.basePath}soffice.worker.js`,
      browserWorkerJs: `${this.basePath}browser.worker.global.js`,
      verbose: false,
      onProgress: (info: {
        phase: string;
        percent: number;
        message: string;
      }) => {
        if (progressCallback && !this.initialized) {
          const simplifiedMessage = `Loading conversion engine (${Math.round(info.percent)}%)...`;
          progressCallback({
            phase: info.phase as LoadProgress['phase'],
            percent: info.percent,
            message: simplifiedMessage,
          });
        }
      },
      onReady: () => {
        console.log('[LibreOffice] Ready!');
      },
      onError: (error: Error) => {
        console.error('[LibreOffice] Error:', error);
        rejectOnError?.(error);
      },
    });

    // Race: initialization vs async error vs hard timeout.
    await withTimeout(
      Promise.race([this.converter.initialize(), asyncErrorPromise]),
      INIT_TIMEOUT_MS,
      'LibreOffice initialization'
    );

    this.initialized = true;

    progressCallback?.({
      phase: 'ready',
      percent: 100,
      message: 'Conversion engine ready!',
    });
    progressCallback = undefined;
  }

  isReady(): boolean {
    return this.initialized && this.converter !== null;
  }

  async convertToPdf(file: File): Promise<Blob> {
    if (!this.converter || !this.initialized) {
      throw new Error('Converter not initialized. Call initialize() first.');
    }

    console.log(`[LibreOffice] Converting ${file.name} to PDF...`);
    console.log(
      `[LibreOffice] File type: ${file.type}, Size: ${file.size} bytes`
    );

    try {
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      console.log(`[LibreOffice] File loaded, ${uint8Array.length} bytes`);

      const startTime = Date.now();

      // Detect input format - critical for CSV to apply import filters
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      console.log(`[LibreOffice] Detected format from extension: ${ext}`);

      const result = await withTimeout(
        this.converter.convert(
          uint8Array,
          {
            outputFormat: 'pdf',
            inputFormat: ext as any,
          },
          file.name
        ),
        CONVERT_TIMEOUT_MS,
        `Conversion of ${file.name}`
      );

      const duration = Date.now() - startTime;
      console.log(
        `[LibreOffice] Conversion complete! Duration: ${duration}ms, Size: ${result.data.length} bytes`
      );

      // Create a copy to avoid SharedArrayBuffer type issues
      const data = new Uint8Array(result.data);
      return new Blob([data], { type: result.mimeType });
    } catch (error) {
      console.error(`[LibreOffice] Conversion FAILED for ${file.name}:`, error);
      throw error;
    }
  }

  async wordToPdf(file: File): Promise<Blob> {
    return this.convertToPdf(file);
  }

  async pptToPdf(file: File): Promise<Blob> {
    return this.convertToPdf(file);
  }

  async excelToPdf(file: File): Promise<Blob> {
    return this.convertToPdf(file);
  }

  /** Convert a PDF to an editable DOCX via LibreOffice's PDF import filter. */
  async pdfToDocx(file: File): Promise<Blob> {
    if (!this.converter || !this.initialized) {
      throw new Error('Converter not initialized. Call initialize() first.');
    }

    const uint8Array = new Uint8Array(await file.arrayBuffer());
    const result = await withTimeout(
      this.converter.convert(
        uint8Array,
        { outputFormat: 'docx', inputFormat: 'pdf' as any },
        file.name
      ),
      CONVERT_TIMEOUT_MS,
      `Conversion of ${file.name}`
    );
    const data = new Uint8Array(result.data);
    return new Blob([data], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  }

  async destroy(): Promise<void> {
    if (this.converter) {
      await this.converter.destroy();
    }
    this.converter = null;
    this.initialized = false;
  }
}

export function getLibreOfficeConverter(
  basePath?: string
): LibreOfficeConverter {
  if (!converterInstance) {
    converterInstance = new LibreOfficeConverter(basePath);
  }
  return converterInstance;
}
