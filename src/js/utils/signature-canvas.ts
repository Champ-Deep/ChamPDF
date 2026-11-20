/** Transparent 3x PNG source for both signature creation paths. */
export function renderSignatureCanvas(
  canvas: HTMLCanvasElement,
  name: string,
  font: string,
  color: string,
  size = 48
) {
  canvas.width = 1800;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable');
  ctx.scale(3, 3);
  ctx.font = `${size}px "${font}", cursive`;
  const width = ctx.measureText(name).width;
  if (width > 552) ctx.font = `${(size * 552) / width}px "${font}", cursive`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 300, 100);
}

/** Crop transparent margins so saved signatures and placed boxes hug the ink. */
export async function trimTransparent(blob: Blob, pad = 12): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(blob);
    const { width: w, height: h } = bmp;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    let x0 = w,
      y0 = h,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (d[(y * w + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    if (x1 < 0) return blob;
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w - 1, x1 + pad);
    y1 = Math.min(h - 1, y1 + pad);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    out
      .getContext('2d')!
      .drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return await new Promise((res) =>
      out.toBlob((b) => res(b || blob), 'image/png')
    );
  } catch {
    return blob; // shortcut: untrimmed fallback when canvas is unavailable
  }
}
