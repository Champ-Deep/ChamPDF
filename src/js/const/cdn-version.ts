export const PACKAGE_VERSIONS = {
  ghostscript: '0.1.0',
} as const;

export const CDN_URLS = {
  ghostscript: `https://cdn.jsdelivr.net/npm/@bentopdf/gs-wasm@${PACKAGE_VERSIONS.ghostscript}/assets/`,
} as const;
