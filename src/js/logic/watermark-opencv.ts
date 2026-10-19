/** Bound both the bundle import and WASM initialization, including missed callbacks. */
export function initializeOpenCV(
  importModule: () => Promise<{ default: any }> = () =>
    import('./watermark-opencv-runtime').then((module) => ({
      default: module.getOpenCVRuntime(),
    })),
  timeoutMs = 30_000
): Promise<{ cv: any }> {
  return new Promise((resolve, reject) => {
    let runtime: any;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      if (error) reject(error);
      // Older Emscripten builds are self-resolving thenables. Never resolve
      // with the runtime directly or await it: that can starve the event loop.
      else resolve({ cv: runtime });
    };
    const check = () => {
      if (runtime?.Mat) finish();
    };
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            'OpenCV did not initialize within 30 seconds. Reload the page and try again.'
          )
        ),
      timeoutMs
    );
    const poll = setInterval(check, 50);
    importModule()
      .then(({ default: module }) => {
        if (settled) return;
        runtime = module;
        if (module?.Mat) check();
        else if (typeof module?.then === 'function') {
          module.then(
            (ready: any) => {
              runtime = ready;
              check();
            },
            (error: Error) => finish(error)
          );
        }
      })
      .catch((error: Error) => finish(error));
  });
}
