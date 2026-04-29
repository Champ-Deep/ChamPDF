export interface WatermarkRegion {
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
  isDrawing: boolean;
  startX: number;
  startY: number;
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
