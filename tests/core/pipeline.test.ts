import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Manifest } from '../../src/core/manifest.js';
import {
  buildStorageKey,
  deriveKey,
  Pipeline,
  type PipelineDeps,
} from '../../src/core/pipeline.js';
import { LocalFsStorage } from '../../src/core/storage.js';
import {
  AuthError,
  NonRetryableError,
  RetryableError,
  SiteChangedError,
} from '../../src/core/errors.js';
import type { DocumentRef } from '../../src/core/models.js';
import type { SiteAdapter } from '../../src/sites/types.js';
import { buildZip } from '../helpers/zipBuilder.js';
import {
  FakeDownloader,
  fakeAdapter,
  fakeCtx,
  fastConfig,
  pdfBytes,
  silentLogger,
  tmpDir,
  urlRef,
  type Behavior,
} from '../helpers/fakes.js';

interface Env {
  root: string;
  tmp: string;
  manifest: Manifest;
  storage: LocalFsStorage;
}
let env: Env;
beforeEach(async () => {
  const root = await tmpDir('pipe-root-');
  env = {
    root,
    tmp: await tmpDir('pipe-tmp-'),
    manifest: new Manifest(':memory:'),
    storage: new LocalFsStorage(path.join(root, 'downloads')),
  };
});

const ok =
  (tag: string): Behavior =>
  () =>
    pdfBytes(tag);

function make(
  adapter: SiteAdapter,
  behaviors: Record<string, Behavior>,
  over: Partial<PipelineDeps> = {},
) {
  const downloader = new FakeDownloader(env.tmp, behaviors);
  const config = fastConfig();
  const pipeline = new Pipeline({
    adapter,
    ctx: fakeCtx(config),
    downloader,
    storage: env.storage,
    manifest: env.manifest,
    logger: silentLogger,
    config,
    tmpDir: env.tmp,
    ...over,
  });
  return { pipeline, downloader };
}

const listStored = async (): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(path.relative(path.join(env.root, 'downloads'), p));
    }
  };
  await walk(path.join(env.root, 'downloads'));
  return out.sort();
};

describe('Pipeline', () => {
  it('stores documents as <site>/<yyyy-mm>/<name> and records them', async () => {
    const { pipeline } = make(fakeAdapter([urlRef('https://x/a', { title: 'Bid A' })]), {
      'https://x/a': ok('a'),
    });
    const s = await pipeline.run();
    expect(s).toMatchObject({ discovered: 1, downloaded: 1, failed: 0 });
    const files = await listStored();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^fake\/\d{4}-\d{2}\/Bid A\.pdf$/);
    expect(env.manifest.stats('fake').downloaded).toBe(1);
    expect(await fsp.readdir(env.tmp)).toEqual([]);
  });

  it('dedups identical content globally; skips already-done docs on re-run', async () => {
    const refs = [urlRef('https://x/1'), urlRef('https://x/2')];
    const beh = { 'https://x/1': ok('same'), 'https://x/2': ok('same') };
    const first = make(fakeAdapter(refs), beh);
    const s1 = await first.pipeline.run();
    expect(s1).toMatchObject({ downloaded: 1, duplicates: 1 });
    expect(await listStored()).toHaveLength(1);

    const second = make(fakeAdapter(refs), beh);
    const s2 = await second.pipeline.run();
    expect(s2).toMatchObject({ skipped: 2, downloaded: 0 });
    expect(second.downloader.total()).toBe(0);

    // different site, same content: still deduped across sites
    const third = make(fakeAdapter([urlRef('https://y/9')], { name: 'other' }), {
      'https://y/9': ok('same'),
    });
    const s3 = await third.pipeline.run();
    expect(s3.duplicates).toBe(1);
  });

  it('one failing document never stops the site', async () => {
    const refs = [urlRef('https://x/a'), urlRef('https://x/404'), urlRef('https://x/b')];
    const { pipeline } = make(fakeAdapter(refs), {
      'https://x/a': ok('a'),
      'https://x/404': () => new NonRetryableError('HTTP 404', { status: 404 }),
      'https://x/b': ok('b'),
    });
    const s = await pipeline.run();
    expect(s).toMatchObject({ discovered: 3, downloaded: 2, failed: 1 });
    expect(env.manifest.listFailed('fake')).toHaveLength(1);
  });

  it('retries transient errors but not permanent ones', async () => {
    const { pipeline, downloader } = make(
      fakeAdapter([urlRef('https://x/flaky'), urlRef('https://x/gone')]),
      {
        'https://x/flaky': (n) =>
          n < 3 ? new RetryableError('503', { status: 503 }) : pdfBytes('f'),
        'https://x/gone': () => new NonRetryableError('403', { status: 403 }),
      },
    );
    const s = await pipeline.run();
    expect(s).toMatchObject({ downloaded: 1, failed: 1 });
    expect(downloader.calls.get('https://x/flaky')).toBe(3);
    expect(downloader.calls.get('https://x/gone')).toBe(1);
  });

  it('re-logs in once on AuthError (shared across concurrent docs) then retries', async () => {
    let loggedIn = false;
    let logins = 0;
    const auth: Behavior = () =>
      loggedIn ? pdfBytes(Math.random().toString()) : new AuthError('html page');
    const adapter = fakeAdapter(
      [urlRef('https://x/1'), urlRef('https://x/2'), urlRef('https://x/3')],
      {
        login: async () => {
          logins++;
          await new Promise((r) => setTimeout(r, 10));
          loggedIn = true;
        },
      },
    );
    const { pipeline } = make(adapter, {
      'https://x/1': auth,
      'https://x/2': auth,
      'https://x/3': auth,
    });
    const s = await pipeline.run();
    expect(s).toMatchObject({ downloaded: 3, failed: 0 });
    expect(logins).toBe(1);
  });

  it('fails the document if auth still fails after re-login', async () => {
    const adapter = fakeAdapter([urlRef('https://x/1')], { login: async () => undefined });
    const { pipeline } = make(adapter, { 'https://x/1': () => new AuthError('still html') });
    const s = await pipeline.run();
    expect(s.failed).toBe(1);
  });

  it('extracts ZIPs: keeps original + folder, child rows with parent_id, nested ok', async () => {
    const inner = buildZip([{ name: 'deep.txt', data: Buffer.from('deep') }]);
    const zip = buildZip([
      { name: 'spec.pdf', data: pdfBytes('spec') },
      { name: 'sub/notes.txt', data: Buffer.from('notes') },
      { name: 'inner.zip', data: inner },
    ]);
    const { pipeline } = make(
      fakeAdapter([urlRef('https://x/z', { title: 'bundle', externalId: 'Z1' })]),
      {
        'https://x/z': () => zip,
      },
    );
    const s = await pipeline.run();
    expect(s.downloaded).toBe(1);
    expect(s.extractedFiles).toBe(4);
    const files = await listStored();
    expect(files.some((f) => /bundle\.zip$/.test(f))).toBe(true);
    expect(files.some((f) => /bundle_extracted\/spec\.pdf$/.test(f))).toBe(true);
    expect(files.some((f) => /bundle_extracted\/sub\/notes\.txt$/.test(f))).toBe(true);
    expect(files.some((f) => /inner_extracted\/deep\.txt$/.test(f))).toBe(true);
    const parent = env.manifest.find('fake', 'ext:Z1');
    expect(parent?.status).toBe('extracted');
    const stats = env.manifest.stats('fake');
    expect(stats.extracted).toBe(1);
    expect(stats.downloaded).toBe(4);
    expect(await fsp.readdir(env.tmp)).toEqual([]);
  });

  it('marks encrypted ZIPs needs_password and corrupt ZIPs failed_extract, keeping the original', async () => {
    const enc = buildZip([{ name: 's.txt', data: Buffer.from('s'), encrypted: true }]);
    const corrupt = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(60, 9)]);
    const { pipeline } = make(
      fakeAdapter([
        urlRef('https://x/e', { externalId: 'E' }),
        urlRef('https://x/c', { externalId: 'C' }),
      ]),
      {
        'https://x/e': () => enc,
        'https://x/c': () => corrupt,
      },
    );
    const s = await pipeline.run();
    expect(s.needsPassword).toBe(1);
    expect(env.manifest.find('fake', 'ext:E')?.status).toBe('needs_password');
    expect(env.manifest.find('fake', 'ext:C')?.status).toBe('failed_extract');
    expect((await listStored()).filter((f) => f.endsWith('.zip'))).toHaveLength(2);
  });

  it('honors limit and abort signal', async () => {
    const refs = Array.from({ length: 10 }, (_, i) => urlRef(`https://x/${i}`));
    const beh = Object.fromEntries(refs.map((r, i) => [`https://x/${i}`, ok(String(i))]));
    const limited = make(fakeAdapter(refs), beh, { limit: 3 });
    expect((await limited.pipeline.run()).discovered).toBe(3);

    env.manifest = new Manifest(':memory:');
    const ac = new AbortController();
    const config = fastConfig({ concurrency: 1 });
    const downloader = new FakeDownloader(env.tmp, {
      ...beh,
      'https://x/1': () => (ac.abort(), pdfBytes('abort')),
    });
    const p = new Pipeline({
      adapter: fakeAdapter(refs),
      ctx: fakeCtx(config, ac.signal),
      downloader,
      storage: env.storage,
      manifest: env.manifest,
      logger: silentLogger,
      config,
      tmpDir: env.tmp,
    });
    const s = await p.run();
    expect(s.discovered).toBeLessThan(10);
    expect(s.downloaded).toBeGreaterThanOrEqual(2); // in-flight work finished
  });

  it('records a fatal discovery error (SiteChangedError) but finishes in-flight docs', async () => {
    const adapter = fakeAdapter([urlRef('https://x/a')], {
      throwAfter: new SiteChangedError('selector gone'),
    });
    const { pipeline } = make(adapter, { 'https://x/a': ok('a') });
    const s = await pipeline.run();
    expect(s.downloaded).toBe(1);
    expect(s.fatal).toMatch(/selector gone/);
  });

  it('retryKeys re-attempts only failed documents', async () => {
    const refs = [
      urlRef('https://x/a', { externalId: 'A' }),
      urlRef('https://x/b', { externalId: 'B' }),
    ];
    const first = make(fakeAdapter(refs), {
      'https://x/a': ok('a'),
      'https://x/b': () => new NonRetryableError('boom'),
    });
    await first.pipeline.run();
    const second = make(
      fakeAdapter(refs),
      { 'https://x/a': ok('a'), 'https://x/b': ok('b') },
      {
        retryKeys: new Set(['ext:B']),
      },
    );
    const s = await second.pipeline.run();
    expect(s).toMatchObject({ downloaded: 1, failed: 0 });
    expect(second.downloader.calls.has('https://x/a')).toBe(false);
    expect(env.manifest.find('fake', 'ext:B')?.status).toBe('downloaded');
  });

  it('property: every discovered doc is accounted for, and stored files == unique contents', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ content: fc.integer({ min: 0, max: 4 }), fail: fc.boolean() }), {
          maxLength: 8,
        }),
        async (docs) => {
          env.manifest = new Manifest(':memory:');
          await fsp.rm(path.join(env.root, 'downloads'), { recursive: true, force: true });
          const refs: DocumentRef[] = docs.map((_, i) =>
            urlRef(`https://x/${i}`, { externalId: `d${i}` }),
          );
          const beh = Object.fromEntries(
            docs.map((d, i) => [
              `https://x/${i}`,
              (d.fail ? () => new NonRetryableError('x') : ok(`c${d.content}`)) as Behavior,
            ]),
          );
          const { pipeline } = make(fakeAdapter(refs), beh);
          const s = await pipeline.run();
          expect(s.downloaded + s.duplicates + s.failed + s.skipped).toBe(docs.length);
          const uniq = new Set(docs.filter((d) => !d.fail).map((d) => d.content)).size;
          expect((await listStored()).length).toBe(uniq);
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('deriveKey', () => {
  it('prefers externalId, else derives from the request, else the click source page', () => {
    expect(deriveKey(urlRef('https://x/a', { externalId: '7' }))).toBe('ext:7');
    expect(deriveKey(urlRef('https://x/a'))).toBe(deriveKey(urlRef('https://x/a')));
    expect(deriveKey(urlRef('https://x/a'))).not.toBe(deriveKey(urlRef('https://x/b')));
    const click = (title: string): DocumentRef => ({
      sourcePageUrl: 'https://x/p',
      title,
      download: { kind: 'click', open: async () => undefined, trigger: async () => undefined },
    });
    expect(deriveKey(click('a'))).not.toBe(deriveKey(click('b')));
  });
});

describe('buildStorageKey', () => {
  it('property: always site/yyyy-mm/<single safe segment> with the detected extension', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom('pdf', 'zip', 'docx', 'bin'), (name, ext) => {
        const key = buildStorageKey({
          site: 'a',
          date: new Date('2026-03-05T00:00:00Z'),
          baseName: name,
          ext,
        });
        expect(key).toMatch(/^a\/2026-03\/[^/\\]+$/);
        expect(key).not.toContain('..');
        if (ext !== 'bin') expect(key.toLowerCase().endsWith(`.${ext}`)).toBe(true);
      }),
    );
  });
});
