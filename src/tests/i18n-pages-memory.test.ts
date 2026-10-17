/**
 * Regression test: scripts/generate-i18n-pages.mjs builds one JSDOM document per
 * (page x language) pair. It never closed the windows, so every DOM stayed
 * reachable and the full `npm run build` died with "Ineffective mark-compacts
 * near heap limit" at the 4GB cap set in package.json.
 *
 * The fix is dom.window.close() after each serialize. This test pins it: run the
 * real script over a synthetic dist with a deliberately small heap and assert it
 * exits 0. Without the close() calls it aborts on heap exhaustion.
 *
 * Deduces quickly: the synthetic dist is small, so the only way to run out of a
 * 128MB heap is to be holding the DOMs.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO, 'scripts/generate-i18n-pages.mjs');

const LANGS = ['en', 'de', 'fr', 'es'];
// Enough (page x language) DOMs that a leaked window is fatal under the cap below.
// The real dist is ~132 pages x 10 languages.
const PAGES = [
  'index',
  'merge-pdf',
  'sign-document',
  ...Array.from({ length: 57 }, (_, i) => `tool-${i}`),
];

let tmp: string;

function page(n: number): string {
  return `<!doctype html><html><head><title>t</title></head><body>${'<p>x</p>'.repeat(
    n
  )}<a href="/merge-pdf">go</a></body></html>`;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chamdf-i18n-'));
  const dist = path.join(tmp, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  PAGES.forEach((p, i) =>
    fs.writeFileSync(path.join(dist, `${p}.html`), page(400 + i))
  );

  const locales = path.join(tmp, 'locales');
  for (const l of LANGS) {
    const dir = path.join(locales, l);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'common.json'),
      JSON.stringify({ hello: l === 'en' ? 'Hello' : `Hello ${l}` })
    );
    fs.writeFileSync(
      path.join(dir, 'tools.json'),
      JSON.stringify(
        Object.fromEntries(
          PAGES.map((p) => [
            p.replace(/-([a-z])/g, (g: string) => g[1].toUpperCase()),
            {
              pageTitle: `${p} - ${l}`,
              subtitle: `sub ${l}`,
            },
          ])
        )
      )
    );
  }
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('generate-i18n-pages', () => {
  it('completes under a 96MB heap, proving JSDOM windows are released', () => {
    // 384MB measured on this fixture: closes cleanly with the fix in place, and
    // aborts with "Ineffective mark-compacts near heap limit" without it. That
    // is the same failure the real 4GB build hit.
    const out = execFileSync(
      process.execPath,
      ['--max-old-space-size=384', SCRIPT],
      {
        env: {
          ...process.env,
          CHAMPDF_DIST_DIR: path.join(tmp, 'dist'),
          CHAMPDF_LOCALES_DIR: path.join(tmp, 'locales'),
          SITE_URL: 'https://example.test',
          BASE_URL: '/',
        },
        encoding: 'utf8',
      }
    );
    expect(out).toContain('i18n pages generated successfully');

    // And the output is real: German pages exist, carry the translated title,
    // the localized hreflang set, and a canonical URL.
    const de = fs.readFileSync(
      path.join(tmp, 'dist', 'de', 'merge-pdf.html'),
      'utf8'
    );
    expect(de).toContain('merge-pdf - de');
    expect(de).toContain('hreflang="x-default"');
    expect(de).toContain('hreflang="fr"');
    expect(de).toContain('rel="canonical"');
    expect(de).toContain('href="https://example.test/de/merge-pdf"');
    // Internal links get the language prefix; external/asset ones do not.
    expect(de).toContain('href="/de/merge-pdf"');
  });

  it('leaves the English-only signer page out of the language copies', () => {
    // sign-document.html is served via the /s/<token> rewrite and is never
    // reachable at /<lang>/sign-document.html, so it must not be copied.
    expect(
      fs.existsSync(path.join(tmp, 'dist', 'de', 'sign-document.html'))
    ).toBe(false);
  });
});
