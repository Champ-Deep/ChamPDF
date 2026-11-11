// Local pixel processing only. No server, model download or API key is needed.
export function removeLightPixels(
  pixels: Uint8ClampedArray,
  tolerance = 30
): Uint8ClampedArray {
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) {
    throw new Error('Background tolerance must be between 0 and 100.');
  }
  const result = new Uint8ClampedArray(pixels);
  const threshold = 255 - tolerance;
  for (let i = 0; i < result.length; i += 4) {
    if (Math.min(result[i], result[i + 1], result[i + 2]) >= threshold) {
      result[i + 3] = 0;
    }
  }
  return result;
}

async function imageCanvas(imageUrl: string): Promise<HTMLCanvasElement> {
  const image = new Image();
  image.src = imageUrl;
  await image.decode();
  if (
    !image.naturalWidth ||
    !image.naturalHeight ||
    image.naturalWidth * image.naturalHeight > 16000000
  ) {
    throw new Error('Choose an image with at most 16 million pixels.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Image processing is unavailable in this browser.');
  ctx.drawImage(image, 0, 0);
  return canvas;
}

export async function readSigningImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg'].includes(file.type)) {
    throw new Error('Choose a PNG or JPEG signature or logo.');
  }
  if (file.size > 10000000)
    throw new Error('Choose an image smaller than 10 MB.');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Unable to read the image.'));
    reader.readAsDataURL(file);
  });
  return (await imageCanvas(dataUrl)).toDataURL('image/png');
}

export async function removeImageBackground(
  imageUrl: string,
  tolerance = 30
): Promise<string> {
  const canvas = await imageCanvas(imageUrl);
  const ctx = canvas.getContext('2d')!;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  image.data.set(removeLightPixels(image.data, tolerance));
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}
