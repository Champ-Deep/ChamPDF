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
