import type { DetectedType } from '../core/models.js';

const t = (ext: string, mime: string, extra: Partial<DetectedType> = {}): DetectedType => ({
  ext,
  mime,
  isZip: false,
  isHtml: false,
  ...extra,
});

const startsWith = (buf: Buffer, sig: readonly number[]): boolean =>
  buf.length >= sig.length && sig.every((v, i) => buf[i] === v);

/** True when the buffer begins with a ZIP local-header / empty / spanned signature. */
export function hasZipMagic(buf: Buffer): boolean {
  return (
    startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buf, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(buf, [0x50, 0x4b, 0x07, 0x08])
  );
}

const OOXML = [
  {
    hint: 'word/',
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  {
    hint: 'xl/',
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  {
    hint: 'ppt/',
    ext: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
] as const;

/** Map an OOXML kind (from entry names) to its type, or undefined. */
export function ooxmlType(ext: string): DetectedType | undefined {
  const m = OOXML.find((o) => o.ext === ext);
  return m ? t(m.ext, m.mime) : undefined;
}

/**
 * Sniff the real file type from leading bytes (never trusts extension or Content-Type).
 * For ZIP containers this uses a cheap header heuristic; the downloader refines it
 * precisely via the central directory (see `archive.classifyZip`).
 * `isZip` is true only for generic archives that should be extracted (not docx/xlsx/pptx).
 */
export function sniffType(buf: Buffer): DetectedType {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return t('pdf', 'application/pdf');
  if (hasZipMagic(buf)) {
    const head = buf.subarray(0, 8192).toString('latin1');
    if (head.includes('[Content_Types].xml')) {
      const m = OOXML.find((o) => head.includes(o.hint));
      if (m) return t(m.ext, m.mime);
    }
    return t('zip', 'application/zip', { isZip: true });
  }
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return t('doc', 'application/msword');
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47])) return t('png', 'image/png');
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return t('jpg', 'image/jpeg');
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return t('gif', 'image/gif');
  if (startsWith(buf, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return t('rtf', 'application/rtf');
  if (startsWith(buf, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
    return t('7z', 'application/x-7z-compressed');
  if (startsWith(buf, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return t('rar', 'application/vnd.rar');
  if (startsWith(buf, [0x1f, 0x8b])) return t('gz', 'application/gzip');

  const text = buf
    .subarray(0, 512)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  if (/^(<!doctype html|<html|<head|<body)/.test(text)) {
    return t('html', 'text/html', { isHtml: true });
  }
  return t('bin', 'application/octet-stream');
}
