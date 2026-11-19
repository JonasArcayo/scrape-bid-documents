import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parseContentDisposition, saveValidated } from '../../src/core/downloader.js';
import { AuthError, NonRetryableError, RetryableError } from '../../src/core/errors.js';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const pdf = (body: Uint8Array) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(body)]);
const chunks = (b: Buffer, n: number) =>
  Readable.from(
    Array.from({ length: Math.ceil(b.length / n) }, (_, i) => b.subarray(i * n, (i + 1) * n)),
  );

describe('saveValidated', () => {
  it('streams to disk with a correct sha256 and size, leaving no .part behind', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 5000 }),
        fc.integer({ min: 1, max: 700 }),
        async (body, n) => {
          const data = pdf(body);
          const r = await saveValidated(chunks(data, n), {
            tmpDir: tmp,
            contentLength: data.length,
            maxBytes: 1e6,
          });
          expect(r.sha256).toBe(createHash('sha256').update(data).digest('hex'));
          expect(r.size).toBe(data.length);
          expect(r.detectedType.ext).toBe('pdf');
          expect((await fs.readFile(r.tmpPath)).equals(data)).toBe(true);
          expect((await fs.readdir(tmp)).filter((f) => f.endsWith('.part'))).toEqual([]);
          await fs.unlink(r.tmpPath);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('rejects empty bodies (retryable) and cleans up', async () => {
    await expect(
      saveValidated(Readable.from([]), { tmpDir: tmp, maxBytes: 100 }),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it('rejects Content-Length mismatches as retryable (truncation)', async () => {
    const data = pdf(new Uint8Array(100));
    await expect(
      saveValidated(chunks(data, 50), {
        tmpDir: tmp,
        contentLength: data.length + 10,
        maxBytes: 1e6,
      }),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it('raises AuthError when an HTML page comes back instead of a document', async () => {
    const html = Buffer.from('<!DOCTYPE html><html><body>Please sign in</body></html>');
    await expect(
      saveValidated(chunks(html, 10), { tmpDir: tmp, maxBytes: 1e6 }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it('enforces the max size while streaming (non-retryable)', async () => {
    const data = pdf(new Uint8Array(1000));
    await expect(
      saveValidated(chunks(data, 100), { tmpDir: tmp, maxBytes: 500 }),
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(await fs.readdir(tmp)).toEqual([]);
  });
});

describe('parseContentDisposition', () => {
  it('handles plain, quoted, and RFC 5987 filenames', () => {
    expect(parseContentDisposition('attachment; filename="a b.pdf"')).toBe('a b.pdf');
    expect(parseContentDisposition('attachment; filename=plain.zip')).toBe('plain.zip');
    expect(parseContentDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")).toBe(
      'résumé.pdf',
    );
    expect(parseContentDisposition('inline')).toBeUndefined();
    expect(parseContentDisposition(undefined)).toBeUndefined();
  });
});
