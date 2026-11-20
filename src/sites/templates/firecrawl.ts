import { NonRetryableError } from '../../core/errors.js';
import type { DocumentRef } from '../../core/models.js';
import { classifyHttpStatus } from '../../utils/retry.js';
import type { FirecrawlSiteConfig } from '../configSchema.js';
import type { SiteAdapter, SiteContext } from '../types.js';

const DEFAULT_BASE_URL = 'https://api.firecrawl.dev';
const DEFAULT_DOC_PATTERN = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|txt)(?:$|\?)/i;

export interface FirecrawlAdapterDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  baseUrl?: string;
}

interface FirecrawlScrapeResponse {
  success?: boolean;
  data?: { links?: string[] };
  error?: string;
}

interface FirecrawlMapResponse {
  success?: boolean;
  links?: string[];
  error?: string;
}

function resolveApiKey(explicit?: string): string {
  const key = explicit ?? process.env.FIRECRAWL_API_KEY;
  if (!key) {
    throw new NonRetryableError(
      'Missing FIRECRAWL_API_KEY environment variable required by firecrawl template',
    );
  }
  return key;
}

async function fetchLinks(
  url: string,
  cfg: FirecrawlSiteConfig,
  opts: { fetchImpl: typeof fetch; apiKey: string; baseUrl: string; signal: AbortSignal },
): Promise<string[]> {
  const endpoint = cfg.mode === 'map' ? '/v1/map' : '/v1/scrape';
  const body =
    cfg.mode === 'map'
      ? { url, limit: cfg.limit }
      : {
          url,
          formats: ['links'],
          onlyMainContent: cfg.onlyMainContent,
          ...(cfg.waitForMs > 0 && { waitFor: cfg.waitForMs }),
        };

  const res = await opts.fetchImpl(`${opts.baseUrl.replace(/\/$/, '')}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    throw classifyHttpStatus(
      res.status,
      `Firecrawl ${endpoint} returned HTTP ${res.status} for ${url}`,
    );
  }

  const json = (await res.json()) as FirecrawlScrapeResponse & FirecrawlMapResponse;
  if (json.success === false) {
    throw new NonRetryableError(
      `Firecrawl ${endpoint} failed for ${url}: ${json.error ?? 'unknown error'}`,
    );
  }

  return cfg.mode === 'map' ? (json.links ?? []) : (json.data?.links ?? []);
}

function buildLinkPredicate(cfg: FirecrawlSiteConfig): (href: string) => boolean {
  const inc = cfg.includeLinks ? new RegExp(cfg.includeLinks, 'i') : DEFAULT_DOC_PATTERN;
  const exc = cfg.excludeLinks ? new RegExp(cfg.excludeLinks, 'i') : undefined;
  return (href: string) => {
    if (!inc.test(href)) return false;
    if (exc?.test(href)) return false;
    return true;
  };
}

/** Build a SiteAdapter that discovers document URLs via Firecrawl's `/v1/scrape` or `/v1/map` API. */
export function buildFirecrawlAdapter(
  cfg: FirecrawlSiteConfig,
  deps: FirecrawlAdapterDeps = {},
): SiteAdapter {
  const matches = buildLinkPredicate(cfg);

  return {
    name: cfg.name,
    config: cfg.config,

    async *discover(ctx: SiteContext): AsyncGenerator<DocumentRef> {
      const apiKey = resolveApiKey(deps.apiKey);
      const baseUrl = deps.baseUrl ?? process.env.FIRECRAWL_BASE_URL ?? DEFAULT_BASE_URL;
      const fetchImpl = deps.fetchImpl ?? fetch;
      const seen = new Set<string>();

      for (const startUrl of cfg.urls) {
        if (ctx.signal.aborted) return;
        await ctx.rateLimit();

        const links = await fetchLinks(startUrl, cfg, {
          fetchImpl,
          apiKey,
          baseUrl,
          signal: ctx.signal,
        });

        for (const raw of links) {
          if (ctx.signal.aborted) return;
          if (!raw || seen.has(raw) || !matches(raw)) continue;
          seen.add(raw);
          yield {
            externalId: raw,
            sourcePageUrl: startUrl,
            download: { kind: 'url', url: raw },
          };
        }
      }
    },
  };
}
