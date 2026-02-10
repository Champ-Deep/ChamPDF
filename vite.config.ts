import { defineConfig, Plugin } from 'vitest/config';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Connect } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import viteCompression from 'vite-plugin-compression';
import handlebars from 'vite-plugin-handlebars';
import { resolve } from 'path';
import fs from 'fs';
import { constants as zlibConstants } from 'zlib';
import type { OutputBundle } from 'rollup';

const SUPPORTED_LANGUAGES = [
  'en',
  'de',
  'es',
  'zh',
  'zh-TW',
  'vi',
  'it',
  'id',
  'tr',
  'fr',
  'pt',
] as const;
const LANG_REGEX = new RegExp(
  `^/(${SUPPORTED_LANGUAGES.join('|')})(?:/(.*))?$`
);

function loadPages(): Set<string> {
  const pagesDir = resolve(__dirname, 'src/pages');
  const pages = new Set<string>();

  if (fs.existsSync(pagesDir)) {
    for (const file of fs.readdirSync(pagesDir)) {
      if (file.endsWith('.html')) {
        pages.add(file.replace('.html', ''));
      }
    }
  }

  const rootPages = ['index', '404'];
  rootPages.forEach((p) => pages.add(p));

  return pages;
}

const PAGES = loadPages();

function getBasePath(): string {
  return (process.env.BASE_URL || '/').replace(/\/$/, '');
}

function createLanguageMiddleware(isDev: boolean): Connect.NextHandleFunction {
  return (
    req: IncomingMessage,
    res: ServerResponse,
    next: Connect.NextFunction
  ): void => {
    if (!req.url) return next();

    const basePath = getBasePath();
    const [fullPathname, queryString] = req.url.split('?');

    let pathname = fullPathname;
    if (basePath && basePath !== '/' && pathname.startsWith(basePath)) {
      pathname = pathname.slice(basePath.length) || '/';
    }

    if (!pathname.startsWith('/')) {
      pathname = '/' + pathname;
    }

    const match = pathname.match(LANG_REGEX);

    if (match) {
      const lang = match[1];
      const rest = match[2] ?? '';

      if (rest === '' && !pathname.endsWith('/')) {
        const redirectUrl = basePath ? `${basePath}/${lang}/` : `/${lang}/`;
        res.statusCode = 302;
        res.setHeader(
          'Location',
          redirectUrl + (queryString ? `?${queryString}` : '')
        );
        res.end();
        return;
      }

      if (rest === '' || rest === '/') {
        req.url = '/index.html' + (queryString ? `?${queryString}` : '');
        return next();
      }

      const cleanPath = rest.replace(/\/$/, '').replace(/\.html$/, '');
      const pageName = cleanPath.split('/')[0];

      if (pageName && PAGES.has(pageName)) {
        if (isDev) {
          const srcPath = resolve(__dirname, 'src/pages', `${pageName}.html`);
          if (fs.existsSync(srcPath)) {
            req.url =
              `/src/pages/${pageName}.html` +
              (queryString ? `?${queryString}` : '');
          } else {
            req.url =
              `/${pageName}.html` + (queryString ? `?${queryString}` : '');
          }
        } else {
          const langPagePath = resolve(
            __dirname,
            'dist',
            lang,
            `${pageName}.html`
          );
          if (fs.existsSync(langPagePath)) {
            req.url =
              `/${lang}/${pageName}.html` +
              (queryString ? `?${queryString}` : '');
          } else {
            req.url =
              `/${pageName}.html` + (queryString ? `?${queryString}` : '');
          }
        }
      }

      return next();
    }

    if (isDev && pathname.endsWith('.html') && !pathname.startsWith('/src/')) {
      const pageName = pathname.slice(1).replace('.html', '');
      if (PAGES.has(pageName)) {
        const srcPath = resolve(__dirname, 'src/pages', `${pageName}.html`);
        if (fs.existsSync(srcPath)) {
          req.url =
            `/src/pages/${pageName}.html` +
            (queryString ? `?${queryString}` : '');
          return next();
        }
      }
    }

    next();
  };
}

function languageRouterPlugin(): Plugin {
  return {
    name: 'language-router',
    configureServer(server) {
      server.middlewares.use(createLanguageMiddleware(true));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createLanguageMiddleware(false));
    },
  };
}

function flattenPagesPlugin(): Plugin {
  return {
    name: 'flatten-pages',
    enforce: 'post',
    generateBundle(_: unknown, bundle: OutputBundle): void {
      for (const fileName of Object.keys(bundle)) {
        if (fileName.startsWith('src/pages/') && fileName.endsWith('.html')) {
          const newFileName = fileName.replace('src/pages/', '');
          bundle[newFileName] = bundle[fileName];
          bundle[newFileName].fileName = newFileName;
          delete bundle[fileName];
        }
      }
    },
  };
}

function rewriteHtmlPathsPlugin(): Plugin {
  const baseUrl = process.env.BASE_URL || '/';
  const normalizedBase = baseUrl.replace(/\/?$/, '/');

  const escapedBase = normalizedBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return {
    name: 'rewrite-html-paths',
    enforce: 'post',
    generateBundle(_: unknown, bundle: OutputBundle): void {
      if (normalizedBase === '/') return;

      for (const fileName of Object.keys(bundle)) {
        if (fileName.endsWith('.html')) {
          const asset = bundle[fileName];
          if (asset.type === 'asset' && typeof asset.source === 'string') {
            const hrefRegex = new RegExp(
              `href="\\/(?!${escapedBase.slice(1)}|test\\/|http|\\/\\/)`,
              'g'
            );
            const srcRegex = new RegExp(
              `src="\\/(?!${escapedBase.slice(1)}|test\\/|http|\\/\\/)`,
              'g'
            );
            const contentRegex = new RegExp(
              `content="\\/(?!${escapedBase.slice(1)}|test\\/|http|\\/\\/)`,
              'g'
            );

            asset.source = asset.source
              .replace(hrefRegex, `href="${normalizedBase}`)
              .replace(srcRegex, `src="${normalizedBase}`)
              .replace(contentRegex, `content="${normalizedBase}`);
          }
        }
      }
    },
  };
}

function getRollupInputs(): Record<string, string> {
  const inputs: Record<string, string> = {
    main: resolve(__dirname, 'index.html'),
    '404': resolve(__dirname, '404.html'),
  };

  const pagesDir = resolve(__dirname, 'src/pages');
  if (fs.existsSync(pagesDir)) {
    const files = fs.readdirSync(pagesDir);
    for (const file of files) {
      if (file.endsWith('.html')) {
        const name = file.replace('.html', '');
        inputs[name] = resolve(pagesDir, file);
      }
    }
  }

  return inputs;
}

export default defineConfig(() => {
  const USE_CDN = process.env.VITE_USE_CDN === 'true';

  const staticCopyTargets = [
    {
      src: 'node_modules/@bentopdf/pymupdf-wasm/assets/*.wasm',
      dest: 'pymupdf-wasm',
    },
    {
      src: 'node_modules/@bentopdf/pymupdf-wasm/assets/*.js',
      dest: 'pymupdf-wasm',
    },
    {
      src: 'node_modules/@bentopdf/pymupdf-wasm/assets/*.whl',
      dest: 'pymupdf-wasm',
    },
    {
      src: 'node_modules/@bentopdf/pymupdf-wasm/assets/*.zip',
      dest: 'pymupdf-wasm',
    },
    {
      src: 'node_modules/@bentopdf/pymupdf-wasm/assets/*.json',
      dest: 'pymupdf-wasm',
    },
    {
      src: 'node_modules/@bentopdf/gs-wasm/assets/*.wasm',
      dest: 'ghostscript-wasm',
    },
    {
      src: 'node_modules/@bentopdf/gs-wasm/assets/*.js',
      dest: 'ghostscript-wasm',
    },
    {
      src: 'node_modules/embedpdf-snippet/dist/pdfium.wasm',
      dest: 'embedpdf',
    },
  ];

  return {
    base: (process.env.BASE_URL || '/').replace(/\/?$/, '/'),
    plugins: [
      handlebars({
        partialDirectory: resolve(__dirname, 'src/partials'),
        context: {
          baseUrl: (process.env.BASE_URL || '/').replace(/\/?$/, '/'),
          simpleMode: false,
        },
      }),
      languageRouterPlugin(),
      flattenPagesPlugin(),
      rewriteHtmlPathsPlugin(),
      tailwindcss(),
      nodePolyfills({
        include: [
          'buffer',
          'stream',
          'util',
          'zlib',
          'process',
          'https',
          'http',
          'url',
          'path',
        ],
        globals: {
          Buffer: true,
          global: true,
          process: true,
        },
      }),
      viteStaticCopy({
        targets: staticCopyTargets,
      }),
      viteCompression({
        algorithm: 'brotliCompress',
        ext: '.br',
        threshold: 1024,
        compressionOptions: {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
            [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
          },
        },
        deleteOriginFile: false,
      }),
      viteCompression({
        algorithm: 'gzip',
        ext: '.gz',
        threshold: 1024,
        compressionOptions: {
          level: 9,
        },
        deleteOriginFile: false,
      }),
    ],
    define: {
      __SIMPLE_MODE__: JSON.stringify(true),
    },
    resolve: {
      alias: {
        '@/types': resolve(__dirname, 'src/js/types/index.ts'),
        stream: 'stream-browserify',
        zlib: 'browserify-zlib',
      },
    },
    optimizeDeps: {
      include: ['pdfkit', 'blob-stream'],
      exclude: ['coherentpdf'],
    },
    server: {
      host: true,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
      watch: {
        ignored: ['**/backend/**', '**/venv/**', '**/node_modules/**'],
      },
    },
    preview: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    build: {
      rollupOptions: {
        input: getRollupInputs(),
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/tests/setup.ts',
      coverage: {
        provider: 'v8' as const,
        reporter: ['text', 'json', 'html'],
        exclude: [
          'node_modules/',
          'src/tests/',
          '*.config.ts',
          '**/*.d.ts',
          'dist/',
        ],
      },
    },
  };
});
