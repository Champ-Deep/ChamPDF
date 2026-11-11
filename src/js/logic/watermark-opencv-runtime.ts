import cv from '@techstark/opencv-js';

// Keep the CommonJS runtime behind an ES module boundary. Vite's direct
// dynamic-import interop spreads cv.then into the namespace, causing native
// Promise assimilation to loop on Emscripten's self-resolving thenable.
export function getOpenCVRuntime() {
  return cv;
}
