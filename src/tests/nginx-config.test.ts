// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

// nginx treats an unquoted `{` as a block opener, so a regex location holding a
// quantifier like {32,64} must be quoted or the container dies at start (502).
describe('nginx regex locations', () => {
  for (const file of ['nginx.conf', 'nginx.railway.conf.template']) {
    it(`${file} quotes every regex location that contains braces`, () => {
      const bad = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => /^\s*location\s+~\*?\s+[^"'\s]*\{/.test(l));
      expect(bad).toEqual([]);
    });
  }
});
