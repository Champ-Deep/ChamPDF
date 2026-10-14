export interface WatermarkRegion {
  /** Top-left origin and size, normalized to page fractions in [0, 1]. */
  x: number;
  y: number;
  width: number;
  height: number;
  pageIndex: number;
}

export interface RemoveWatermarkState {
  file: File | null;
  pdfDoc: any | null;
  currentPage: number;
  totalPages: number;
  scale: number;
  regions: WatermarkRegion[];
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
}

export interface InpaintingOptions {
  method: 'telea' | 'ns' | 'gemini'; // Telea, Navier-Stokes, or Gemini AI
  radius: number; // Inpainting radius in pixels (ignored for 'gemini')
}

export interface ProcessingProgress {
  current: number;
  total: number;
  status: string;
}
