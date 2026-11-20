import { describe, expect, it, vi } from 'vitest';
import { NonRetryableError, RetryableError } from '../../src/core/errors.js';
import { JsonSiteConfigSchema } from '../../src/sites/configSchema.js';
import { buildFirecrawlAdapter } from '../../src/sites/templates/firecrawl.js';
import type { SiteContext } from '../../src/sites/types.js';
import { fastConfig, silentLogger } from '../helpers/fakes.js';

function makeCtx(signal = new AbortController().signal): SiteContext {
  return {
    site: 'fc-test',
    browserContext: {} as SiteContext['browserContext'],
    newPage: async () => {
      throw new Error('firecrawl template should not open a browser page');
    },
    logger: silentLogger,
    config: fastConfig(),
    rateLimit: async () => undefined,
    signal,
    dumpDebug: async () => undefined,
  };
}

describe('firecrawl template', () => {
  it('scrape mode filters document links, deduplicates, and yields url DownloadSpecs', async () => {
    const cfg = JsonSiteConfigSchema.parse({
      name: 'fc-scrape',
      template: 'firecrawl',
      urls: ['https://example.gov/bids'],
    });
    if (cfg.template !== 'firecrawl') throw new Error('unexpected template');

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            links: [
              'https://example.gov/about',
              'https://example.gov/docs/rfp.pdf',
              'https://example.gov/docs/rfp.pdf',
              'https://example.gov/docs/bundle.zip?v=1',
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const adapter = buildFirecrawlAdapter(cfg, {
      fetchImpl,
      apiKey: 'fc-key',
      baseUrl: 'https://api.firecrawl.dev/',
    });

    const refs = [];
    for await (const ref of adapter.discover(makeCtx())) refs.push(ref);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.firecrawl.dev/v1/scrape',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(refs).toEqual([
      {
        externalId: 'https://example.gov/docs/rfp.pdf',
        sourcePageUrl: 'https://example.gov/bids',
        download: { kind: 'url', url: 'https://example.gov/docs/rfp.pdf' },
      },
      {
        externalId: 'https://example.gov/docs/bundle.zip?v=1',
        sourcePageUrl: 'https://example.gov/bids',
        download: { kind: 'url', url: 'https://example.gov/docs/bundle.zip?v=1' },
      },
    ]);
  });

  it('map mode supports custom includeLinks and excludeLinks', async () => {
    const cfg = JsonSiteConfigSchema.parse({
      name: 'fc-map',
      template: 'firecrawl',
      urls: ['https://example.gov'],
      mode: 'map',
      limit: 50,
      includeLinks: '/bids/',
      excludeLinks: 'archive',
    });
    if (cfg.template !== 'firecrawl') throw new Error('unexpected template');

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          links: [
            'https://example.gov/bids/2026/a.pdf',
            'https://example.gov/bids/archive/old.pdf',
            'https://example.gov/news/item',
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = buildFirecrawlAdapter(cfg, { fetchImpl, apiKey: 'fc-key' });
    const refs = [];
    for await (const ref of adapter.discover(makeCtx())) refs.push(ref);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.firecrawl.dev/v1/map',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(refs.map((r) => r.externalId)).toEqual(['https://example.gov/bids/2026/a.pdf']);
  });

  it('throws NonRetryableError when FIRECRAWL_API_KEY is missing or auth fails', async () => {
    const prev = process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    try {
      const cfg = JsonSiteConfigSchema.parse({
        name: 'fc-missing-key',
        template: 'firecrawl',
        urls: ['https://example.gov/bids'],
      });
      if (cfg.template !== 'firecrawl') throw new Error('unexpected template');

      const noKey = buildFirecrawlAdapter(cfg);
      await expect(noKey.discover(makeCtx()).next()).rejects.toThrow(NonRetryableError);

      const badAuth = buildFirecrawlAdapter(cfg, {
        apiKey: 'bad',
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('denied', { status: 401 })),
      });
      await expect(badAuth.discover(makeCtx()).next()).rejects.toThrow(NonRetryableError);
    } finally {
      if (prev !== undefined) process.env.FIRECRAWL_API_KEY = prev;
    }
  });

  it('throws RetryableError on 429/5xx responses', async () => {
    const cfg = JsonSiteConfigSchema.parse({
      name: 'fc-retry',
      template: 'firecrawl',
      urls: ['https://example.gov/bids'],
    });
    if (cfg.template !== 'firecrawl') throw new Error('unexpected template');

    const adapter = buildFirecrawlAdapter(cfg, {
      apiKey: 'fc-key',
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('busy', { status: 429 })),
    });
    await expect(adapter.discover(makeCtx()).next()).rejects.toThrow(RetryableError);
  });
});
