import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sanitizeFilename, withHashSuffix } from '../../src/utils/sanitize.js';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

describe('sanitizeFilename', () => {
  it('never yields separators, control chars, or empty names', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (raw) => {
        const out = sanitizeFilename(raw);
        expect(out.length).toBeGreaterThan(0);
        // eslint-disable-next-line no-control-regex -- asserting control chars are removed
        expect(out).not.toMatch(/[\\/:*?"<>|\u0000-\u001f\u007f]/);
        expect(out).not.toMatch(/^\.+$/);
        expect(out).not.toMatch(/[. ]$/);
      }),
    );
  });

  it('respects the length cap and preserves the extension', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 600 }), (base) => {
        const out = sanitizeFilename(`${base}.pdf`, { maxLength: 100 });
        expect(out.length).toBeLessThanOrEqual(100);
        expect(out.endsWith('.pdf') || !/\.pdf$/.test(`${base}.pdf`.trim())).toBe(true);
      }),
    );
  });

  it('defuses Windows reserved names', () => {
    for (const n of ['CON', 'nul.txt', 'com1.pdf', 'LPT9']) {
      const out = sanitizeFilename(n);
      const stem = out.replace(/\.[^.]*$/, '');
      expect(stem).not.toMatch(WINDOWS_RESERVED);
    }
  });

  it('blocks path traversal', () => {
    const out = sanitizeFilename('../../etc/passwd');
    expect(out).not.toContain('/');
    expect(out).not.toContain('..');
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = sanitizeFilename(raw);
        expect(sanitizeFilename(once)).toBe(once);
      }),
    );
  });
});

describe('withHashSuffix', () => {
  it('inserts the hash before the extension', () => {
    expect(withHashSuffix('report.pdf', 'abcdef1234567890')).toBe('report-abcdef12.pdf');
    expect(withHashSuffix('noext', 'abcdef1234567890')).toBe('noext-abcdef12');
  });
});
