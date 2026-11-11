/**
 * Type definitions for the PDF Signer component
 */

export interface TextStyle {
  fontFamily: 'Helvetica' | 'TimesRoman' | 'Courier';
  fontSize: number; // PDF points, independent of editor zoom
  color: string;
}

export interface Annotation {
  id: string;
  type: 'signature' | 'date' | 'text' | 'initials' | 'checkbox';
  page: number;
  x: number; // percentage from left (0-100)
  y: number; // percentage from top (0-100)
  width: number; // percentage of page width
  height: number; // percentage of page height
  data: {
    imageUrl?: string; // for signature/initials
    originalImageUrl?: string; // retained for non-destructive background cleanup
    text?: string; // for text/date
    checked?: boolean; // for checkbox
    fontFamily?: TextStyle['fontFamily'];
    fontSize?: number;
    color?: string;
  };
}

export interface SignerState {
  pdfDoc: any; // PDF.js document
  currentPage: number;
  totalPages: number;
  scale: number;
  annotations: Annotation[];
  selectedAnnotation: string | null;
}

export interface PageDimensions {
  width: number;
  height: number;
}
