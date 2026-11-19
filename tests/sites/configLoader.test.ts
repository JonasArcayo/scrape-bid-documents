import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSiteConfigs } from '../../src/sites/configLoader.js';
import { AdapterRegistry } from '../../src/sites/registry.js';
import { tmpDir } from '../helpers/fakes.js';

describe('loadSiteConfigs', () => {
  it('loads valid nested JSON configs, skips _prefixed and disabled entries, and preserves metadata', async () => {
    const dir = await tmpDir('cfg-');
    await fs.mkdir(path.join(dir, 'county'));
    await fs.mkdir(path.join(dir, '_disabled'));

    await fs.writeFile(
      path.join(dir, 'county', 'a.json'),
      JSON.stringify({
        name: 'county-a',
        tags: ['ca', 'water'],
        template: 'link-list',
        urls: ['https://example.gov/bids'],
        selectors: { link: ['a[href$=".pdf"]', 'a.doc'] },
      }),
    );
    await fs.writeFile(
      path.join(dir, 'county', 'paused.json'),
      JSON.stringify({
        name: 'county-paused',
        enabled: false,
        template: 'link-list',
        urls: ['https://example.gov/paused'],
        selectors: { link: 'a.doc' },
      }),
    );
    await fs.writeFile(
      path.join(dir, '_disabled', 'ignored.json'),
      JSON.stringify({ invalid: true }),
    );
    await fs.writeFile(path.join(dir, '_schema.json'), '{}');

    const { adapters, meta } = loadSiteConfigs(dir);
    expect(adapters.map((a) => a.name)).toEqual(['county-a']);
    expect(meta.get('county-a')?.tags).toEqual(['ca', 'water']);

    const reg = new AdapterRegistry();
    for (const a of adapters) reg.register(a, meta.get(a.name));
    expect(reg.listByTag('water').map((a) => a.name)).toEqual(['county-a']);
    expect(reg.listByTag('other')).toEqual([]);
  });

  it('fails fast with file path when table-links is missing selectors.row or JSON is invalid', async () => {
    const dir = await tmpDir('cfg-bad-');
    const missingRow = path.join(dir, 'bad-table.json');
    await fs.writeFile(
      missingRow,
      JSON.stringify({
        name: 'bad-table',
        template: 'table-links',
        urls: ['https://example.gov/bids'],
        selectors: { link: 'a.doc' },
      }),
    );
    expect(() => loadSiteConfigs(dir)).toThrow(/bad-table\.json.*selectors\.row/);

    await fs.rm(missingRow);
    await fs.writeFile(path.join(dir, 'broken.json'), '{not-json');
    expect(() => loadSiteConfigs(dir)).toThrow(/Invalid JSON.*broken\.json/);
  });
});
