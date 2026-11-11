import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseSigningToken,
  isLinkTokenShape,
  loadSession,
  saveSession,
  clearSession,
  statusChip,
  shortHash,
  escapeHtml,
} from '../js/utils/sign-api';

const TOKEN = 'k7Zp3xQ9rT2vB8nM4cW6yL1sD5fG0hJa'; // 32 url-safe chars

describe('sign-api', () => {
  describe('parseSigningToken', () => {
    it('reads the token from /s/<token>', () => {
      expect(parseSigningToken(`/s/${TOKEN}`, '')).toBe(TOKEN);
      expect(parseSigningToken(`/s/${TOKEN}/`, '')).toBe(TOKEN);
    });

    it('falls back to ?t=<token>', () => {
      expect(parseSigningToken('/sign-document.html', `?t=${TOKEN}`)).toBe(
        TOKEN
      );
    });

    it('rejects malformed tokens', () => {
      expect(parseSigningToken('/s/short', '')).toBeNull();
      expect(parseSigningToken('/s/has%20space', '')).toBeNull();
      expect(
        parseSigningToken('/sign-document.html', '?t=<script>')
      ).toBeNull();
      expect(parseSigningToken('/other', '')).toBeNull();
    });

    it('prefers the path over the query string', () => {
      const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      expect(parseSigningToken(`/s/${TOKEN}`, `?t=${other}`)).toBe(TOKEN);
    });
  });

  describe('isLinkTokenShape', () => {
    it('accepts 32 to 64 url-safe characters', () => {
      expect(isLinkTokenShape(TOKEN)).toBe(true);
      expect(isLinkTokenShape('a'.repeat(64))).toBe(true);
      expect(isLinkTokenShape('a'.repeat(31))).toBe(false);
      expect(isLinkTokenShape('a'.repeat(65))).toBe(false);
      expect(isLinkTokenShape(null)).toBe(false);
    });
  });

  describe('session storage', () => {
    beforeEach(() => sessionStorage.clear());

    it('round-trips a session per token', () => {
      expect(loadSession(TOKEN)).toBeNull();
      saveSession(TOKEN, 'sess-1');
      expect(loadSession(TOKEN)).toBe('sess-1');
      clearSession(TOKEN);
      expect(loadSession(TOKEN)).toBeNull();
    });
  });

  describe('rendering helpers', () => {
    it('escapes html in status chips', () => {
      expect(statusChip('<b>')).toContain('&lt;b&gt;');
      expect(statusChip('executed')).toContain('green');
    });

    it('shortens hashes', () => {
      expect(shortHash('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijkl…');
      expect(shortHash(null)).toBe('-');
    });

    it('escapes html', () => {
      expect(escapeHtml('<a href="x">&</a>')).toBe(
        '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;'
      );
    });
  });
});
