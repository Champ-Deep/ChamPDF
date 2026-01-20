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
  method: 'telea' | 'ns'; // Telea or Navier-Stokes
  radius: number; // Inpainting radius in pixels
}

export interface ProcessingProgress {
  current: number;
  total: number;
  status: string;
}
