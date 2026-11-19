import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalFsStorage } from '../../src/core/storage.js';

describe('LocalFsStorage', () => {
  it('puts, checks existence, and returns a file URI', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-root-'));
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'st-src-'));
    const file = path.join(src, 'a.txt');
    await fs.writeFile(file, 'hi');
    const s = new LocalFsStorage(root);
    expect(await s.exists('x/y/a.txt')).toBe(false);
    const uri = await s.put(file, 'x/y/a.txt');
    expect(await s.exists('x/y/a.txt')).toBe(true);
    expect(uri).toBe(s.getUri('x/y/a.txt'));
    expect(await fs.readFile(path.join(root, 'x/y/a.txt'), 'utf8')).toBe('hi');
  });
  it('rejects keys that escape the root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-root-'));
    const s = new LocalFsStorage(root);
    await expect(s.put('/dev/null', '../evil')).rejects.toThrow();
    expect(() => s.getUri('/abs/path')).toThrow();
  });
});
