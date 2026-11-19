import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadRegistry } from '../../src/sites/registry.js';
import { tmpDir } from '../helpers/fakes.js';

const mod = (name: string) => `export default { name: '${name}', async *discover() {} };\n`;

describe('loadRegistry', () => {
  it('auto-discovers top-level adapter files; ignores _prefixed, internal modules, and subfolders', async () => {
    const dir = await tmpDir('reg-');
    await fs.writeFile(path.join(dir, 'alpha.mjs'), mod('alpha'));
    await fs.writeFile(
      path.join(dir, 'multi.mjs'),
      `export default [{ name: 'm1', async *discover() {} }, { name: 'm2', async *discover() {} }];`,
    );
    await fs.writeFile(path.join(dir, '_hidden.mjs'), mod('hidden'));
    await fs.writeFile(path.join(dir, 'types.mjs'), 'export default 42;');
    await fs.mkdir(path.join(dir, 'helpers'));
    await fs.writeFile(path.join(dir, 'helpers', 'x.mjs'), mod('nested'));

    const reg = await loadRegistry(dir, { configDir: false });
    expect(reg.list().map((a) => a.name)).toEqual(['alpha', 'm1', 'm2']);
  });

  it('rejects duplicate names and non-adapter default exports', async () => {
    const dup = await tmpDir('reg-dup-');
    await fs.writeFile(path.join(dup, 'a.mjs'), mod('same'));
    await fs.writeFile(path.join(dup, 'b.mjs'), mod('same'));
    await expect(loadRegistry(dup, { configDir: false })).rejects.toThrow(/Duplicate/);

    const bad = await tmpDir('reg-bad-');
    await fs.writeFile(path.join(bad, 'a.mjs'), 'export default { nope: true };');
    await expect(loadRegistry(bad, { configDir: false })).rejects.toThrow(/not a SiteAdapter/);
  });

  it('the real sites folder registers all 12 bidlocker agencies from JSON configs', async () => {
    const reg = await loadRegistry();
    const names = reg.list().map((a) => a.name);
    expect(names).toContain('bidlocker-trimet');
    expect(names).toContain('bidlocker-oregonmetro');
    expect(reg.listByTag('bidlocker')).toHaveLength(12);
  });
});
