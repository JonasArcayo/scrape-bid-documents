import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sniffType } from '../../src/utils/fileType.js';

const b = (...x: number[]) => Buffer.from(x);

describe('sniffType', () => {
  it('detects PDF', () => {
    expect(sniffType(Buffer.from('%PDF-1.7\n...')).ext).toBe('pdf');
  });
  it('detects plain ZIP', () => {
    const t = sniffType(Buffer.concat([b(0x50, 0x4b, 3, 4), Buffer.alloc(30)]));
    expect(t.isZip).toBe(true);
    expect(t.ext).toBe('zip');
  });
  it('detects empty ZIP', () => {
    expect(sniffType(b(0x50, 0x4b, 5, 6, 0, 0, 0, 0)).isZip).toBe(true);
  });
  it('refines OOXML zips by header hints; they are NOT extractable archives', () => {
    const mk = (name: string) =>
      Buffer.concat([b(0x50, 0x4b, 3, 4), Buffer.from(`[Content_Types].xml....${name}....`)]);
    const docx = sniffType(mk('word/document.xml'));
    expect(docx.ext).toBe('docx');
    expect(docx.isZip).toBe(false);
    expect(sniffType(mk('xl/workbook.xml')).ext).toBe('xlsx');
    expect(sniffType(mk('ppt/presentation.xml')).ext).toBe('pptx');
    // folder named word/ inside a plain zip (no OOXML content types) stays a zip
    const plain = sniffType(Buffer.concat([b(0x50, 0x4b, 3, 4), Buffer.from('word/notes.txt')]));
    expect(plain.ext).toBe('zip');
    expect(plain.isZip).toBe(true);
  });
  it('detects legacy OLE (doc/xls) and images', () => {
    expect(sniffType(b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)).ext).toBe('doc');
    expect(sniffType(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)).ext).toBe('png');
    expect(sniffType(b(0xff, 0xd8, 0xff, 0xe0)).ext).toBe('jpg');
  });
  it('flags HTML even with leading whitespace/BOM', () => {
    for (const s of [
      '<!DOCTYPE html><html>',
      '  \n<html lang="en">',
      '﻿<HTML>',
      '<head><title>Login</title>',
    ]) {
      expect(sniffType(Buffer.from(s)).isHtml).toBe(true);
    }
  });
  it('never claims PDF/ZIP for a buffer that lacks their magic', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 64 }), (arr) => {
        const buf = Buffer.from(arr);
        const t = sniffType(buf);
        if (!buf.subarray(0, 5).equals(Buffer.from('%PDF-'))) expect(t.ext).not.toBe('pdf');
        if (!(buf[0] === 0x50 && buf[1] === 0x4b)) expect(t.isZip).toBe(false);
      }),
    );
  });
});
