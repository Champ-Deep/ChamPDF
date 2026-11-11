/** Read a processed media response without mistaking proxy HTML for a file. */
export async function readProcessedMedia(
  response: Response,
  mediaType: 'image/png' | 'video/mp4',
  fileLimit: string
): Promise<Blob> {
  if (!response.ok) {
    let detail: unknown;
    try {
      detail = (await response.json())?.detail;
    } catch {
      // Nginx and hosting proxies return HTML rather than FastAPI JSON.
    }

    if (typeof detail === 'string' && detail.trim()) {
      throw new Error(detail);
    }

    switch (response.status) {
      case 413:
        throw new Error(
          `Upload rejected (HTTP 413). The file limit is ${fileLimit}. If your file is within this limit, the server's upload proxy needs to allow the file plus multipart form data.`
        );
      case 502:
      case 503:
        throw new Error(
          `Processing service unavailable (HTTP ${response.status}). Please try again later. The server administrator should check the backend connection.`
        );
      case 504:
        throw new Error(
          'Processing timed out (HTTP 504). Try a smaller file or retry later.'
        );
      default:
        throw new Error(
          `Processing failed (HTTP ${response.status}). Please try again.`
        );
    }
  }

  const contentType = response.headers
    .get('Content-Type')
    ?.split(';')[0]
    .trim()
    .toLowerCase();
  if (contentType !== mediaType) {
    throw new Error(
      `The server did not return a processed ${mediaType === 'image/png' ? 'PNG image' : 'MP4 video'}. The server administrator should check the API proxy and backend connection.`
    );
  }

  const blob = await response.blob();
  if (blob.size === 0) {
    throw new Error('The server returned an empty file. Please try again.');
  }
  return blob;
}
