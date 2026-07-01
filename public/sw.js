/**
 * ChamPDF Service Worker
 * Caches WASM files and static assets for offline support and faster loading
 * Supports both local and CDN delivery with deduplication
 * Version: 1.1.0
 */

const CACHE_VERSION = 'champdf-v9';
const CACHE_NAME = `${CACHE_VERSION}-static`;

const getBasePath = () => {
  const scope = self.registration?.scope || self.location.href;
  const url = new URL(scope);
  return url.pathname.replace(/\/$/, '') || '';
};

const buildCriticalAssets = (basePath) => [
  `${basePath}/pymupdf-wasm/pyodide.js`,
  `${basePath}/pymupdf-wasm/pyodide.asm.js`,
  `${basePath}/pymupdf-wasm/pyodide.asm.wasm`,
  `${basePath}/pymupdf-wasm/python_stdlib.zip`,
  `${basePath}/pymupdf-wasm/pyodide-lock.json`,

  `${basePath}/pymupdf-wasm/pymupdf-1.26.3-cp313-none-pyodide_2025_0_wasm32.whl`,
  `${basePath}/pymupdf-wasm/numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl`,
  `${basePath}/pymupdf-wasm/opencv_python-4.11.0.86-cp313-cp313-pyodide_2025_0_wasm32.whl`,
  `${basePath}/pymupdf-wasm/lxml-5.4.0-cp313-cp313-pyodide_2025_0_wasm32.whl`,
  `${basePath}/pymupdf-wasm/python_docx-1.2.0-py3-none-any.whl`,
  `${basePath}/pymupdf-wasm/pdf2docx-0.5.8-py3-none-any.whl`,
  `${basePath}/pymupdf-wasm/fonttools-4.56.0-py3-none-any.whl`,
  `${basePath}/pymupdf-wasm/typing_extensions-4.12.2-py3-none-any.whl`,
  `${basePath}/pymupdf-wasm/pymupdf4llm-0.0.27-py3-none-any.whl`,

  `${basePath}/ghostscript-wasm/gs.js`,
  `${basePath}/ghostscript-wasm/gs.wasm`,
];

self.addEventListener('install', (event) => {
  const basePath = getBasePath();
  const CRITICAL_ASSETS = buildCriticalAssets(basePath);
  // console.log('🚀 [ServiceWorker] Installing version:', CACHE_VERSION);
  // console.log('📍 [ServiceWorker] Base path detected:', basePath || '/');
  // console.log('📦 [ServiceWorker] Will cache', CRITICAL_ASSETS.length, 'critical assets');

  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        // console.log('[ServiceWorker] Caching critical assets...');
        return cacheInBatches(cache, CRITICAL_ASSETS, 5);
      })
      .then(() => {
        // Intentionally do NOT skipWaiting here. A freshly installed worker
        // stays in "waiting" until the user accepts the update (postMessage
        // SKIP_WAITING via the reload prompt) or every tab closes. Auto-
        // activating mid-session forced a reload that flashed the old skin
        // then the new one ("switching between design languages").
      })
      .catch((error) => {
        console.error('[ServiceWorker] Cache installation failed:', error);
      })
  );
});

self.addEventListener('activate', (event) => {
  // console.log('🔄 [ServiceWorker] Activating version:', CACHE_VERSION);

  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName.startsWith('champdf-') && cacheName !== CACHE_NAME) {
              // console.log('[ServiceWorker] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        // console.log('✅ [ServiceWorker] Activated successfully!');
        // console.log('🎯 [ServiceWorker] Taking control of all pages...');
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  const isCDN = url.hostname === 'cdn.jsdelivr.net';
  const isLocal = url.origin === location.origin;

  if (!isLocal && !isCDN) {
    return;
  }
  if (
    isLocal &&
    (url.searchParams.has('t') ||
      url.searchParams.has('import') ||
      url.searchParams.has('direct'))
  ) {
    // console.log('🔧 [Dev Mode] Skipping Vite HMR request:', url.pathname);
    return;
  }

  if (
    isLocal &&
    (url.pathname.includes('/@vite') ||
      url.pathname.includes('/@id') ||
      url.pathname.includes('/@fs'))
  ) {
    return;
  }

  if (shouldCache(url.pathname, isCDN)) {
    event.respondWith(cacheFirstStrategyWithDedup(event.request, isCDN));
  } else if (
    isLocal &&
    (url.pathname.endsWith('.html') || url.pathname === '/')
  ) {
    event.respondWith(networkFirstStrategy(event.request));
  }
});

/**
 * Cache-first strategy with deduplication
 * Ensures we only cache CDN OR local version, never both
 */
async function cacheFirstStrategyWithDedup(request, isCDN) {
  const url = new URL(request.url);
  const fileName = url.pathname.split('/').pop();

  try {
    const cachedResponse = await findCachedFile(fileName);
    if (cachedResponse) {
      // console.log('⚡ [Cache HIT] Instant load:', fileName);
      return cachedResponse;
    }

    // console.log(`📥 [Cache MISS] Downloading from ${isCDN ? 'CDN' : 'local'}:`, fileName);

    const networkResponse = await fetch(request);

    if (networkResponse && networkResponse.status === 200) {
      // Caching is best-effort: a failed cache.put (206 partial response,
      // storage quota, or an oversized body) must never reject the actual
      // fetch — otherwise large WASM runtimes fail to load (issue #16).
      try {
        const cache = await caches.open(CACHE_NAME);
        await removeDuplicateCache(cache, fileName, isCDN);
        await cache.put(request, networkResponse.clone());
        // console.log(`💾 [Cached from ${isCDN ? 'CDN' : 'local'}] Saved:`, fileName);
      } catch (cacheErr) {
        console.warn('[ServiceWorker] Skipped caching', fileName, cacheErr);
      }
    }

    return networkResponse;
  } catch (error) {
    if (isCDN) {
      console.warn(`⚠️ [CDN Failed] Trying local fallback for: ${fileName}`);
      const basePath = getBasePath();
      const localPath = getLocalPathForCDNUrl(url.pathname);

      if (localPath) {
        const localUrl = `${basePath}${localPath}${fileName}`;
        try {
          const fallbackResponse = await fetch(localUrl);
          if (fallbackResponse && fallbackResponse.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(localUrl, fallbackResponse.clone());
            // console.log('✅ [Fallback Success] Cached local version:', fileName);
            return fallbackResponse;
          }
        } catch (fallbackError) {
          console.error(
            '[ServiceWorker] Both CDN and local failed for:',
            fileName
          );
        }
      }
    }
    throw error;
  }
}

async function findCachedFile(fileName) {
  const cache = await caches.open(CACHE_NAME);
  const requests = await cache.keys();

  for (const req of requests) {
    const reqUrl = new URL(req.url);
    if (reqUrl.pathname.endsWith(fileName)) {
      return await cache.match(req);
    }
  }
  return null;
}

async function removeDuplicateCache(cache, fileName, isCDN) {
  const requests = await cache.keys();

  for (const req of requests) {
    const reqUrl = new URL(req.url);
    if (reqUrl.pathname.endsWith(fileName)) {
      // If caching CDN version, remove local version (and vice versa)
      const reqIsCDN = reqUrl.hostname === 'cdn.jsdelivr.net';
      if (reqIsCDN !== isCDN) {
        await cache.delete(req);
        // console.log(`[Dedup] Removed ${reqIsCDN ? 'CDN' : 'local'} version of:`, fileName);
      }
    }
  }
}

/**
 * Network-first strategy: Try network first, fallback to cache
 * Perfect for HTML files that might update
 */
async function networkFirstStrategy(request) {
  try {
    const networkResponse = await fetch(request);

    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }

    return networkResponse;
  } catch (error) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      // console.log('[Offline Mode] Serving from cache:', request.url.split('/').pop());
      return cachedResponse;
    }
    throw error;
  }
}

/**
 * Map CDN URL path to local path
 * Returns the local directory path for a given CDN package
 */
function getLocalPathForCDNUrl(pathname) {
  if (pathname.includes('/@champdf/pymupdf-wasm')) {
    return '/pymupdf-wasm/';
  }
  if (pathname.includes('/@champdf/gs-wasm')) {
    return '/ghostscript-wasm/';
  }
  if (pathname.includes('/@matbee/libreoffice-converter')) {
    return '/libreoffice-wasm/';
  }
  return null;
}

/**
 * Determine if a URL should be cached
 * Handles both local and CDN URLs
 */
function shouldCache(pathname, isCDN = false) {
  // Never intercept the very large LibreOffice runtime blobs. Caching them
  // triggers 206/oversized `cache.put` failures that reject the fetch and
  // break PowerPoint→PDF (issue #16). Let them load directly from network.
  if (
    pathname.includes('/libreoffice-wasm/') &&
    /\.(gz|wasm|data)$/.test(pathname)
  ) {
    return false;
  }

  if (isCDN) {
    return (
      pathname.includes('/@champdf/pymupdf-wasm') ||
      pathname.includes('/@champdf/gs-wasm') ||
      pathname.includes('/@matbee/libreoffice-converter') ||
      pathname.match(/\.(wasm|whl|zip|json|js|gz)$/)
    );
  }

  return (
    pathname.includes('/libreoffice-wasm/') ||
    pathname.includes('/pymupdf-wasm/') ||
    pathname.includes('/ghostscript-wasm/') ||
    pathname.includes('/embedpdf/') ||
    pathname.includes('/assets/') ||
    pathname.match(
      /\.(js|mjs|css|wasm|whl|zip|json|png|jpg|jpeg|gif|svg|woff|woff2|ttf|gz|br)$/
    )
  );
}

/**
 * Cache assets in batches to avoid overwhelming the browser
 */
async function cacheInBatches(cache, urls, batchSize = 5) {
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    // console.log(`[ServiceWorker] Caching batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(urls.length / batchSize)}`);

    await Promise.all(
      batch.map(async (url) => {
        try {
          await cache.add(url);
          const fileName = url.split('/').pop();
          const fileSize =
            fileName.includes('.wasm') || fileName.includes('.whl')
              ? '(large file)'
              : '';
          // console.log(`  ✓ Cached: ${fileName} ${fileSize}`);
        } catch (error) {
          console.warn('[ServiceWorker] Failed to cache:', url, error.message);
        }
      })
    );
  }
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.delete(CACHE_NAME).then(() => {
        console.log('[ServiceWorker] Cache cleared');
      })
    );
  }
});

// console.log('🎉 [ServiceWorker] Script loaded successfully! Ready to cache assets.');
// console.log('📊 [ServiceWorker] Cache version:', CACHE_VERSION);
