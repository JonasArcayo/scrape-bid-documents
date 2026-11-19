import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import type { SiteBrowser } from '../../src/core/browser.js';
import { loadConfig } from '../../src/core/config.js';
import { AuthError, NonRetryableError } from '../../src/core/errors.js';
import { Manifest } from '../../src/core/manifest.js';
import { Runner } from '../../src/core/runner.js';
import { LocalFsStorage } from '../../src/core/storage.js';
import { AdapterRegistry } from '../../src/sites/registry.js';
import {
  FakeDownloader,
  fakeAdapter,
  pdfBytes,
  silentLogger,
  tmpDir,
  urlRef,
} from '../helpers/fakes.js';

async function setup() {
  const root = await tmpDir('runner-');
  const config = loadConfig({
    DATA_DIR: root,
    SESSIONS_DIR: path.join(root, 's'),
  } as NodeJS.ProcessEnv);
  const manifest = new Manifest(':memory:');
  const closed: string[] = [];
  const browser = {
    openSite: async (site: string): Promise<SiteBrowser> => ({
      context: {} as BrowserContext,
      newPage: async () => {
        throw new Error('no browser in tests');
      },
      saveSession: async () => undefined,
      close: async () => void closed.push(site),
    }),
  };
  const registry = new AdapterRegistry();
  const mk = (signal = new AbortController().signal) =>
    new Runner({
      registry,
      config,
      manifest,
      storage: new LocalFsStorage(path.join(root, 'downloads')),
      logger: silentLogger,
      browser,
      createDownloader: ({ tmpDir: t }) =>
        new FakeDownloader(t, {
          'https://a/1': () => pdfBytes('a1'),
          'https://b/1': () => pdfBytes('b1'),
          'https://c/1': () => new NonRetryableError('404', { status: 404 }),
        }),
      dumper: { dump: async () => undefined },
      signal,
    });
  return { registry, manifest, closed, mk };
}

describe('Runner', () => {
  it('isolates failures: a site whose login fails does not stop the others; browsers always close', async () => {
    const { registry, manifest, closed, mk } = await setup();
    registry.register(fakeAdapter([urlRef('https://a/1')], { name: 'a' }));
    registry.register({
      ...fakeAdapter([urlRef('https://b/1')], { name: 'bad' }),
      login: async () => {
        throw new AuthError('bad credentials');
      },
    });
    registry.register(fakeAdapter([urlRef('https://b/1')], { name: 'b' }));
    registry.register(fakeAdapter([urlRef('https://c/1')], { name: 'c' }));
    const out = await mk().run(['a', 'bad', 'b', 'c', 'nope']);
    const by = Object.fromEntries(out.map((s) => [s.site, s]));
    expect(by.a?.downloaded).toBe(1);
    expect(by.bad?.fatal).toMatch(/bad credentials/);
    expect(by.b?.downloaded).toBe(1);
    expect(by.c?.failed).toBe(1);
    expect(by.nope?.fatal).toMatch(/unknown site/i);
    expect(closed.sort()).toEqual(['a', 'b', 'bad', 'c']);
    expect(manifest.stats('a').downloaded).toBe(1);
  });

  it('stops starting new sites after shutdown is requested', async () => {
    const { registry, mk } = await setup();
    registry.register(fakeAdapter([urlRef('https://a/1')], { name: 'a' }));
    registry.register(fakeAdapter([urlRef('https://b/1')], { name: 'b' }));
    const ac = new AbortController();
    ac.abort();
    const out = await mk(ac.signal).run(['a', 'b']);
    expect(out).toEqual([]);
  });

  it('retryFailed re-attempts only failed docs of a site', async () => {
    const { registry, manifest, mk } = await setup();
    registry.register(
      fakeAdapter(
        [urlRef('https://a/1', { externalId: '1' }), urlRef('https://c/1', { externalId: '2' })],
        { name: 'a' },
      ),
    );
    await mk().run(['a']);
    expect(manifest.listFailed('a')).toHaveLength(1);
    const out = await mk().run(['a'], { retryFailed: true });
    expect(out[0]?.failed).toBe(1);
    expect(out[0]?.downloaded).toBe(0);
    expect(manifest.find('a', 'ext:2')?.attempts).toBe(2);
  });
});
