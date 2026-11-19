import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { BrowserManager, type SiteBrowser } from '../src/core/browser.js';
import { Downloader } from '../src/core/downloader.js';
import { Manifest } from '../src/core/manifest.js';
import { Pipeline } from '../src/core/pipeline.js';
import { LocalFsStorage } from '../src/core/storage.js';
import type { DocumentRef } from '../src/core/models.js';
import type { SiteContext } from '../src/sites/types.js';
import { buildZip } from './helpers/zipBuilder.js';
import { fakeAdapter, fastConfig, pdfBytes, silentLogger, tmpDir } from './helpers/fakes.js';

let server: http.Server;
let base = '';
let flakyHits = 0;
let manager: BrowserManager | undefined;
let site: SiteBrowser | undefined;
let skip = false;
const zip = buildZip([
  { name: 'a.pdf', data: pdfBytes('in-zip') },
  { name: 'n/b.txt', data: Buffer.from('bee') },
]);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = (req.url ?? '').split('?')[0];
    if (u === '/page') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><a id="dl" href="/bundle.zip">Download</a></body></html>');
    } else if (u === '/bundle.zip') {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="bundle.zip"');
      res.end(zip);
    } else if (u === '/doc.pdf') {
      res.setHeader('content-type', 'application/pdf');
      res.end(pdfBytes('plain'));
    } else if (u === '/fake.pdf') {
      // lies about its type: HTML login page where a document was expected
      res.setHeader('content-type', 'application/pdf');
      res.end('<!DOCTYPE html><html><body>Please log in</body></html>');
    } else if (u === '/flaky') {
      res.setHeader('content-type', 'application/pdf');
      if (++flakyHits < 2) {
        res.statusCode = 503;
        res.setHeader('retry-after', '0');
        res.end('busy');
      } else res.end(pdfBytes('flaky-ok'));
    } else if (u === '/post' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/pdf');
        res.end(pdfBytes(`posted:${body}`));
      });
    } else {
      res.statusCode = 404;
      res.end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const root = await tmpDir('e2e-sessions-');
    manager = new BrowserManager({
      sessionsDir: root,
      debugDir: path.join(root, 'debug'),
      logger: silentLogger,
    });
    site = await manager.openSite('e2e', fastConfig());
  } catch {
    skip = true;
  }
});
afterAll(async () => {
  await site?.close();
  await manager?.shutdown();
  await new Promise((r) => server.close(r));
});

describe('end-to-end with a real browser and local server', () => {
  it('downloads via url, request, click; validates, dedups, extracts, and isolates failures', async (t) => {
    if (skip || !site) return t.skip();
    const root = await tmpDir('e2e-');
    const tmp = await tmpDir('e2e-tmp-');
    const config = fastConfig();
    const sb = site;
    const ctx: SiteContext = {
      site: 'e2e',
      browserContext: sb.context,
      newPage: () => sb.newPage(),
      logger: silentLogger,
      config,
      rateLimit: async () => undefined,
      signal: new AbortController().signal,
      dumpDebug: async () => undefined,
    };
    const src = `${base}/page`;
    const refs: DocumentRef[] = [
      {
        externalId: 'pdf',
        title: 'plain',
        sourcePageUrl: src,
        download: { kind: 'url', url: `${base}/doc.pdf` },
      },
      {
        externalId: 'dup',
        title: 'same content',
        sourcePageUrl: src,
        download: { kind: 'url', url: `${base}/doc.pdf?again=1` },
      },
      { externalId: 'flaky', sourcePageUrl: src, download: { kind: 'url', url: `${base}/flaky` } },
      {
        externalId: 'post',
        title: 'posted',
        sourcePageUrl: src,
        download: { kind: 'request', method: 'POST', url: `${base}/post`, body: 'q=1' },
      },
      {
        externalId: 'click',
        title: 'bundle',
        sourcePageUrl: src,
        download: {
          kind: 'click',
          open: async (p) => void (await p.goto(`${base}/page`)),
          trigger: async (p) => p.locator('#dl').click(),
        },
      },
      {
        externalId: 'html',
        sourcePageUrl: src,
        download: { kind: 'url', url: `${base}/fake.pdf` },
      },
      { externalId: 'gone', sourcePageUrl: src, download: { kind: 'url', url: `${base}/missing` } },
    ];
    const manifest = new Manifest(':memory:');
    const pipeline = new Pipeline({
      adapter: fakeAdapter(refs, { name: 'e2e' }),
      ctx,
      downloader: new Downloader({ tmpDir: tmp, config, logger: silentLogger }),
      storage: new LocalFsStorage(path.join(root, 'downloads')),
      manifest,
      logger: silentLogger,
      config: fastConfig({ concurrency: 1 }),
      tmpDir: tmp,
    });
    const s = await pipeline.run();
    expect(manifest.find('e2e', 'ext:pdf')?.status).toBe('downloaded');
    expect(manifest.find('e2e', 'ext:dup')?.status).toBe('duplicate');
    expect(manifest.find('e2e', 'ext:flaky')?.status).toBe('downloaded');
    expect(manifest.find('e2e', 'ext:post')?.status).toBe('downloaded');
    expect(manifest.find('e2e', 'ext:click')?.status).toBe('extracted');
    expect(manifest.find('e2e', 'ext:html')?.status).toBe('failed');
    expect(manifest.find('e2e', 'ext:html')?.error).toMatch(/HTML/);
    expect(manifest.find('e2e', 'ext:gone')?.status).toBe('failed');
    expect(manifest.find('e2e', 'ext:gone')?.error).toMatch(/404/);
    expect(s).toMatchObject({ discovered: 7, duplicates: 1, failed: 2, extractedFiles: 2 });
    expect(flakyHits).toBe(2);
  }, 60_000);
});
