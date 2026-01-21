export interface LogoRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  pageIndex: number;
}

export interface ReplaceLogoState {
  file: File | null;
  pdfDoc: any | null;
  currentPage: number;
  totalPages: number;
  scale: number;
  regions: LogoRegion[];
  isDrawing: boolean;
  startX: number;
  startY: number;
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  replacementLogo: HTMLImageElement | null;
}

export interface LogoReplacementOptions {
  opacity: number;
  maintainAspectRatio: boolean;
  autoResize: boolean;
  backgroundColor: string;
  addBackground: boolean;
}

export interface DetectionResult {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}
