import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeOpenCV } from '../js/logic/watermark-opencv';

afterEach(() => vi.useRealTimers());

describe('watermark OpenCV initialization', () => {
  it('accepts an already initialized runtime', async () => {
    const cv = { Mat: class {} };
    expect(await initializeOpenCV(async () => ({ default: cv }))).toEqual({
      cv,
    });
  });

  it('waits for WASM readiness without relying on a callback', async () => {
    vi.useFakeTimers();
    const cv: { Mat?: unknown } = {};
    const loading = initializeOpenCV(async () => ({ default: cv }));
    await vi.advanceTimersByTimeAsync(100);
    cv.Mat = class {};
    await vi.advanceTimersByTimeAsync(50);
    expect(await loading).toEqual({ cv });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a promised runtime', async () => {
    const cv = { Mat: class {} };
    expect(
      await initializeOpenCV(async () => ({ default: Promise.resolve(cv) }))
    ).toEqual({ cv });
  });

  it('does not assimilate an Emscripten self-resolving thenable', async () => {
    const cv = {
      Mat: class {},
      then: vi.fn((ready: (value: unknown) => void) => ready(cv)),
    };
    const result = await initializeOpenCV(async () => ({ default: cv }));
    expect(result.cv).toBe(cv);
    expect(cv.then).not.toHaveBeenCalled();
  });

  it('handles a delayed self-resolving runtime without promise assimilation', async () => {
    const cv = {
      Mat: undefined as unknown,
      then: (ready: (value: unknown) => void) => {
        cv.Mat = class {};
        ready(cv);
        return cv;
      },
    };
    expect((await initializeOpenCV(async () => ({ default: cv }))).cv).toBe(cv);
  });

  it.each(['import', 'runtime', 'promise'])(
    'bounds a stalled %s and cleans timers',
    async (stage) => {
      vi.useFakeTimers();
      const loading = initializeOpenCV(
        () =>
          stage === 'import'
            ? new Promise(() => {})
            : Promise.resolve({
                default: stage === 'runtime' ? {} : new Promise(() => {}),
              }),
        100
      );
      const result = expect(loading).rejects.toThrow(
        'OpenCV did not initialize'
      );
      await vi.advanceTimersByTimeAsync(100);
      await result;
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('reports an import failure and permits a fresh retry', async () => {
    await expect(
      initializeOpenCV(async () => {
        throw new Error('download failed');
      })
    ).rejects.toThrow('download failed');
    const cv = { Mat: class {} };
    expect((await initializeOpenCV(async () => ({ default: cv }))).cv).toBe(cv);
  });
});
