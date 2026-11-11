import { describe, expect, it } from 'vitest';
import { readProcessedMedia } from '../js/utils/media-response.js';

describe('processed media response validation', () => {
  it('preserves the backend detail instead of hiding it with a generic status', async () => {
    const response = new Response(
      JSON.stringify({ detail: 'File too large. Maximum size: 100MB' }),
      { status: 413 }
    );
    await expect(
      readProcessedMedia(response, 'video/mp4', '100MB')
    ).rejects.toThrow('File too large. Maximum size: 100MB');
  });

  it.each([null, {}, { detail: [] }, { detail: 123 }, { detail: '' }])(
    'handles malformed backend errors: %j',
    async (body) => {
      const response = new Response(JSON.stringify(body), { status: 500 });
      await expect(
        readProcessedMedia(response, 'image/png', '10MB')
      ).rejects.toThrow('HTTP 500');
    }
  );

  it('rejects an empty PNG response', async () => {
    const response = new Response(null, {
      headers: { 'Content-Type': 'image/png' },
    });
    await expect(
      readProcessedMedia(response, 'image/png', '10MB')
    ).rejects.toThrow('empty file');
  });

  it('rejects a JSON response even with HTTP 200', async () => {
    const response = new Response('{}', {
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(
      readProcessedMedia(response, 'video/mp4', '100MB')
    ).rejects.toThrow('did not return a processed MP4 video');
  });

  it('accepts MIME parameters on a nonempty result', async () => {
    const response = new Response('png', {
      headers: { 'Content-Type': 'image/png; charset=binary' },
    });
    await expect(
      readProcessedMedia(response, 'image/png', '10MB')
    ).resolves.toMatchObject({ size: 3 });
  });
});
