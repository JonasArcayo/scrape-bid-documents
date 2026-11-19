// eslint-disable-next-line no-control-regex -- intentionally strips control characters
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const EXT = /^[A-Za-z0-9]{1,10}$/;

/** Truncate a string to at most `maxBytes` UTF-8 bytes without splitting code points. */
function truncateBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

function splitExt(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf('.');
  if (i >= 0 && EXT.test(name.slice(i + 1))) {
    return { stem: name.slice(0, i), ext: name.slice(i) };
  }
  return { stem: name, ext: '' };
}

/**
 * Turn an arbitrary string into a safe single path segment: no separators, control
 * characters, traversal, Windows reserved names, or trailing dots/spaces; capped in
 * length (bytes) while preserving the extension. Idempotent.
 */
export function sanitizeFilename(raw: string, opts: { maxLength?: number } = {}): string {
  const max = opts.maxLength ?? 120;
  const cleaned = raw.replace(ILLEGAL, '_').trim();
  const { stem: rawStem, ext: rawExt } = splitExt(cleaned);
  const ext = truncateBytes(rawExt, Math.max(0, max - 1));
  const limit = Math.max(1, max - Buffer.byteLength(ext));

  let stem = rawStem
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  stem = truncateBytes(stem, limit).replace(/[.\s]+$/, '');
  if (stem === '') stem = 'unnamed';
  if (RESERVED.test(stem.split('.')[0] ?? '')) {
    stem = `_${truncateBytes(stem, limit - 1)}`.replace(/[.\s]+$/, '');
  }
  return stem + ext;
}

/** Insert a short hash before the extension, for collision handling. */
export function withHashSuffix(name: string, sha256: string): string {
  const { stem, ext } = splitExt(name);
  return `${stem}-${sha256.slice(0, 8)}${ext}`;
}
