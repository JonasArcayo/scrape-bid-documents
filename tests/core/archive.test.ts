import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractArchive, detectFileType, type ZipLimits } from '../../src/core/archive.js';
import { NonRetryableError, ZipSafetyError } from '../../src/core/errors.js';
import { buildZip } from '../helpers/zipBuilder.js';

const LIMITS: ZipLimits = {
  maxTotalBytes: 50 * 1024 * 1024,
  maxEntries: 1000,
  maxRatio: 100,
  maxDepth: 2,
};
let work: string;
beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'arch-'));
});
afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

async function run(zip: Buffer, limits: Partial<ZipLimits> = {}) {
  const zipPath = path.join(work, 'in', 'test.zip');
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  await fs.writeFile(zipPath, zip);
  const dest = path.join(work, 'out');
  return { dest, promise: extractArchive(zipPath, dest, { limits: { ...LIMITS, ...limits } }) };
}
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

describe('extractArchive', () => {
  it('round-trips arbitrary safe entries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            name: fc.stringMatching(/^[a-z0-9]{1,10}$/),
            data: fc.uint8Array({ maxLength: 200 }),
          }),
          { selector: (e) => e.name, maxLength: 8 },
        ),
        async (items) => {
          const { dest, promise } = await run(
            buildZip(items.map((i) => ({ name: `d/${i.name}.bin`, data: Buffer.from(i.data) }))),
          );
          const res = await promise;
          expect(res.outcome).toBe('extracted');
          for (const i of items) {
            const got = await fs.readFile(path.join(dest, 'd', `${i.name}.bin`));
            expect(got.equals(Buffer.from(i.data))).toBe(true);
          }
          await fs.rm(dest, { recursive: true, force: true });
        },
      ),
      { numRuns: 25 },
    );
  });

  it('rejects zip-slip names and writes nothing outside dest', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.constantFrom('/', '\\'),
        async (depth, sep) => {
          const evil = `${'..' + sep}`.repeat(depth) + 'evil.txt';
          const { dest, promise } = await run(
            buildZip([
              { name: 'ok.txt', data: Buffer.from('ok') },
              { name: evil, data: Buffer.from('x') },
            ]),
          );
          await expect(promise).rejects.toBeInstanceOf(ZipSafetyError);
          expect(await exists(dest)).toBe(false);
          expect(await exists(path.join(work, 'evil.txt'))).toBe(false);
          expect(await exists(path.join(work, 'in', 'evil.txt'))).toBe(false);
        },
      ),
      { numRuns: 15 },
    );
  });

  it('skips absolute paths and symlinks but extracts the rest', async () => {
    const { dest, promise } = await run(
      buildZip([
        { name: '/abs/passwd', data: Buffer.from('x') },
        { name: 'C:\\win\\x.txt', data: Buffer.from('x') },
        { name: 'link', data: Buffer.from('/etc/passwd'), symlink: true },
        { name: 'good.txt', data: Buffer.from('good') },
      ]),
    );
    const res = await promise;
    expect(res.skippedEntries.length).toBe(3);
    expect(await fs.readFile(path.join(dest, 'good.txt'), 'utf8')).toBe('good');
    expect(await exists(path.join(dest, 'link'))).toBe(false);
  });

  it('blocks zip bombs by compression ratio (enforced while streaming)', async () => {
    const { dest, promise } = await run(
      buildZip([{ name: 'bomb.bin', data: Buffer.alloc(20 * 1024 * 1024) }]),
    );
    await expect(promise).rejects.toBeInstanceOf(ZipSafetyError);
    expect(await exists(dest)).toBe(false);
  });

  it('blocks on total bytes and entry count', async () => {
    const noise = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 251));
    const big = await run(buildZip([{ name: 'a', data: noise, method: 'store' }]), {
      maxTotalBytes: 1000,
    });
    await expect(big.promise).rejects.toBeInstanceOf(ZipSafetyError);
    const many = await run(
      buildZip(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') }))),
      { maxEntries: 10 },
    );
    await expect(many.promise).rejects.toBeInstanceOf(ZipSafetyError);
  });

  it('extracts nested zips only up to maxDepth', async () => {
    const inner = buildZip([{ name: 'leaf.txt', data: Buffer.from('leaf') }]);
    const mid = buildZip([{ name: 'inner.zip', data: inner }]);
    const outer = buildZip([{ name: 'mid.zip', data: mid }]);

    const deep = await run(outer, { maxDepth: 2 });
    const r2 = await deep.promise;
    expect(r2.files.some((f) => f.relPath.endsWith('leaf.txt'))).toBe(true);
    expect(r2.nestedSkipped).toEqual([]);
    await fs.rm(deep.dest, { recursive: true, force: true });

    const shallow = await run(outer, { maxDepth: 1 });
    const r1 = await shallow.promise;
    expect(r1.files.some((f) => f.relPath.endsWith('leaf.txt'))).toBe(false);
    expect(r1.nestedSkipped.length).toBe(1);
    await fs.rm(shallow.dest, { recursive: true, force: true });

    const none = await run(outer, { maxDepth: 0 });
    const r0 = await none.promise;
    expect(r0.files.map((f) => f.relPath)).toEqual(['mid.zip']);
  });

  it('flags encrypted entries as needs_password and still extracts the rest', async () => {
    const { dest, promise } = await run(
      buildZip([
        { name: 'secret.txt', data: Buffer.from('zzz'), encrypted: true },
        { name: 'open.txt', data: Buffer.from('open') },
      ]),
    );
    const res = await promise;
    expect(res.outcome).toBe('needs_password');
    expect(res.encryptedEntries).toEqual(['secret.txt']);
    expect(await fs.readFile(path.join(dest, 'open.txt'), 'utf8')).toBe('open');
  });

  it('throws a non-retryable error for corrupt archives', async () => {
    const { dest, promise } = await run(
      Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(50, 7)]),
    );
    await expect(promise).rejects.toBeInstanceOf(NonRetryableError);
    expect(await exists(dest)).toBe(false);
  });
});

describe('detectFileType', () => {
  it('distinguishes docx/xlsx containers from extractable zips via the central directory', async () => {
    const mk = async (name: string, entries: string[]) => {
      const p = path.join(work, name);
      await fs.writeFile(p, buildZip(entries.map((n) => ({ name: n, data: Buffer.from('x') }))));
      return detectFileType(p);
    };
    const docx = await mk('a.bin', ['[Content_Types].xml', 'word/document.xml']);
    expect(docx.ext).toBe('docx');
    expect(docx.isZip).toBe(false);
    expect((await mk('b.bin', ['[Content_Types].xml', 'xl/workbook.xml'])).ext).toBe('xlsx');
    const plain = await mk('c.bin', ['word/notes.txt']);
    expect(plain.ext).toBe('zip');
    expect(plain.isZip).toBe(true);
  });
});
