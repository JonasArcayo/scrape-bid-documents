import type { Page } from 'playwright';
import { SiteChangedError } from '../../core/errors.js';
import type { DocumentRef } from '../../core/models.js';
import { toSelectorList, type GenericTemplateConfig, type SelectorInput } from '../configSchema.js';
import { extractByLocator, extractLinksFromTable, type ExtractedLink } from '../helpers/extract.js';
import { clickNext } from '../helpers/paginate.js';
import { buildFirecrawlAdapter, type FirecrawlAdapterDeps } from './firecrawl.js';
import type { SiteAdapter, SiteContext } from '../types.js';

/**
 * Try selectors in order until one attaches. Logs a warning when falling back to a
 * secondary selector; dumps debug artifacts and throws SiteChangedError if all fail.
 */
async function resolveSelector(
  page: Page,
  input: SelectorInput,
  what: string,
  ctx: SiteContext,
  timeoutMs = 10_000,
): Promise<string> {
  const candidates = toSelectorList(input);
  for (let i = 0; i < candidates.length; i++) {
    const sel = candidates[i]!;
    try {
      await page.locator(sel).first().waitFor({ state: 'attached', timeout: timeoutMs });
      if (i > 0) {
        ctx.logger.warn(
          { primary: candidates[0], matched: sel, url: page.url() },
          `fallback selector matched for ${what}`,
        );
      }
      return sel;
    } catch {
      // try next fallback selector
    }
  }
  await ctx.dumpDebug(page, `missing ${what} (${candidates.join(' | ')})`).catch(() => undefined);
  throw new SiteChangedError(
    `Expected ${what} (selectors: ${candidates.join(', ')}) not found on ${page.url()}`,
  );
}

async function resolveOptionalSelector(
  page: Page,
  input: SelectorInput | undefined,
): Promise<string | undefined> {
  if (!input) return undefined;
  for (const sel of toSelectorList(input)) {
    if ((await page.locator(sel).count()) > 0) return sel;
  }
  return toSelectorList(input)[0];
}

function buildUrlPredicate(filter?: GenericTemplateConfig['urlFilter']): (href: string) => boolean {
  const inc = filter?.include ? new RegExp(filter.include) : undefined;
  const exc = filter?.exclude ? new RegExp(filter.exclude) : undefined;
  return (href: string) => {
    if (inc && !inc.test(href)) return false;
    if (exc && exc.test(href)) return false;
    return true;
  };
}

async function* discoverTableDetail(
  cfg: Extract<GenericTemplateConfig, { template: 'table-detail' }>,
  ctx: SiteContext,
  matchesFilter: (href: string) => boolean,
): AsyncGenerator<DocumentRef> {
  const listPage = await ctx.newPage();
  const detailPage = await ctx.newPage();
  const seenDetails = new Set<string>();

  try {
    for (const startUrl of cfg.urls) {
      if (ctx.signal.aborted) return;
      await ctx.rateLimit();
      await listPage.goto(startUrl, { waitUntil: 'domcontentloaded' });

      if (cfg.selectors.ready) {
        await resolveSelector(listPage, cfg.selectors.ready, 'page ready marker', ctx);
      }

      const nextSel = await resolveOptionalSelector(listPage, cfg.selectors.nextPage);
      const pages = nextSel
        ? clickNext(listPage, {
            nextSelector: nextSel,
            maxPages: cfg.maxPages,
            settleMs: cfg.pageSettleMs,
            signal: ctx.signal,
          })
        : (async function* () {
            yield 1;
          })();

      for await (const pageNo of pages) {
        if (ctx.signal.aborted) return;
        const detailLinkSel = toSelectorList(cfg.selectors.detailLink)[0]!;
        let detailLinks: ExtractedLink[];
        if (cfg.selectors.row) {
          const rowSel = await resolveSelector(listPage, cfg.selectors.row, 'table row', ctx);
          detailLinks = await extractLinksFromTable(listPage, {
            rowSelector: rowSel,
            linkSelector: detailLinkSel,
          });
        } else {
          const sel = await resolveSelector(listPage, cfg.selectors.detailLink, 'detail link', ctx);
          detailLinks = await extractByLocator(listPage.locator(sel));
        }

        if (detailLinks.length === 0 && pageNo === 1) {
          ctx.logger.warn({ url: listPage.url() }, 'no detail links found on first page');
        }

        for (const detail of detailLinks) {
          if (ctx.signal.aborted) return;
          if (!detail.href || seenDetails.has(detail.href)) continue;
          seenDetails.add(detail.href);

          await ctx.rateLimit();
          await detailPage.goto(detail.href, { waitUntil: 'domcontentloaded' });

          let targetUrl = detail.href;
          if (cfg.selectors.hopLink) {
            const hopSel = await resolveOptionalSelector(detailPage, cfg.selectors.hopLink);
            const hops = hopSel ? await extractByLocator(detailPage.locator(hopSel)) : [];
            if (!hops[0]?.href) continue;
            targetUrl = hops[0].href;
            await ctx.rateLimit();
            await detailPage.goto(targetUrl, { waitUntil: 'domcontentloaded' });
          }

          if (cfg.selectors.detailReady) {
            await resolveSelector(
              detailPage,
              cfg.selectors.detailReady,
              'detail ready marker',
              ctx,
              20_000,
            );
          }

          const docLinkSel = await resolveOptionalSelector(detailPage, cfg.selectors.docLink);
          if (!docLinkSel) continue;

          if (cfg.downloadMode === 'click') {
            const count = await detailPage.locator(docLinkSel).count();
            for (let i = 0; i < count; i++) {
              const loc = detailPage.locator(docLinkSel).nth(i);
              const href = (await loc.getAttribute('href').catch(() => null)) ?? '';
              const label = ((await loc.textContent().catch(() => null)) ?? '').trim();
              if (href && !matchesFilter(href)) continue;
              const idx = i;
              yield {
                externalId: `${targetUrl}#${idx}:${href || label}`,
                title: (label && label !== 'Download' ? label : detail.text) || undefined,
                sourcePageUrl: targetUrl,
                download: {
                  kind: 'click',
                  open: async (p) => {
                    await p.goto(targetUrl, { waitUntil: 'domcontentloaded' });
                    if (cfg.selectors.detailReady) {
                      await resolveSelector(
                        p,
                        cfg.selectors.detailReady,
                        'detail ready marker',
                        ctx,
                        20_000,
                      );
                    }
                  },
                  trigger: async (p) => {
                    await p.locator(docLinkSel).nth(idx).click();
                  },
                },
              };
            }
          } else {
            const docs = await extractByLocator(detailPage.locator(docLinkSel));
            for (const doc of docs) {
              if (!matchesFilter(doc.href)) continue;
              yield {
                externalId: doc.href,
                title: doc.text || detail.text || undefined,
                sourcePageUrl: targetUrl,
                download: { kind: 'url', url: doc.href },
              };
            }
          }
        }
      }
    }
  } finally {
    await detailPage.close().catch(() => undefined);
    await listPage.close().catch(() => undefined);
  }
}

async function* discoverSingleHop(
  cfg: Extract<GenericTemplateConfig, { template: 'link-list' | 'table-links' }>,
  ctx: SiteContext,
  matchesFilter: (href: string) => boolean,
): AsyncGenerator<DocumentRef> {
  const page = await ctx.newPage();
  try {
    for (const startUrl of cfg.urls) {
      if (ctx.signal.aborted) return;
      await ctx.rateLimit();
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

      if (cfg.selectors.ready) {
        await resolveSelector(page, cfg.selectors.ready, 'page ready marker', ctx);
      }

      const nextSel = await resolveOptionalSelector(page, cfg.selectors.nextPage);
      const pages = nextSel
        ? clickNext(page, { nextSelector: nextSel, maxPages: cfg.maxPages, signal: ctx.signal })
        : (async function* () {
            yield 1;
          })();

      for await (const pageNo of pages) {
        if (ctx.signal.aborted) return;

        let links: ExtractedLink[];
        if (cfg.template === 'table-links') {
          const rowSel = await resolveSelector(page, cfg.selectors.row, 'table row', ctx);
          const linkSel = toSelectorList(cfg.selectors.link)[0]!;
          links = await extractLinksFromTable(page, {
            rowSelector: rowSel,
            linkSelector: linkSel,
          });
        } else {
          const linkSel = await resolveSelector(page, cfg.selectors.link, 'document link', ctx);
          links = await extractByLocator(page.locator(linkSel));
        }

        if (links.length === 0 && pageNo === 1) {
          ctx.logger.warn({ url: page.url() }, 'no matching links found on first page');
        }

        for (const link of links) {
          if (!matchesFilter(link.href)) continue;
          yield {
            externalId: link.href,
            title: link.text || undefined,
            sourcePageUrl: page.url(),
            download: { kind: 'url', url: link.href },
          };
        }
      }
    }
  } finally {
    await page.close();
  }
}

/** Build a reusable SiteAdapter from a declarative JSON config. */
export function buildTemplateAdapter(
  cfg: GenericTemplateConfig,
  deps: { firecrawl?: FirecrawlAdapterDeps } = {},
): SiteAdapter {
  const matchesFilter = buildUrlPredicate(cfg.urlFilter);

  if (cfg.template === 'table-detail') {
    return {
      name: cfg.name,
      config: cfg.config,
      discover: (ctx) => discoverTableDetail(cfg, ctx, matchesFilter),
    };
  }

  return {
    name: cfg.name,
    config: cfg.config,

    async *discover(ctx: SiteContext): AsyncGenerator<DocumentRef> {
      try {
        yield* discoverSingleHop(cfg, ctx, matchesFilter);
      } catch (err) {
        const hasKey = Boolean(deps.firecrawl?.apiKey ?? process.env.FIRECRAWL_API_KEY);
        if (!(err instanceof SiteChangedError) || !cfg.firecrawlFallback || !hasKey) {
          throw err;
        }
        ctx.logger.warn(
          { site: cfg.name, err: err.message },
          'Playwright selectors failed; falling back to Firecrawl',
        );
        const fallback = buildFirecrawlAdapter(
          {
            name: cfg.name,
            enabled: cfg.enabled,
            tags: cfg.tags,
            template: 'firecrawl',
            urls: cfg.urls,
            mode: 'scrape',
            includeLinks: cfg.urlFilter?.include,
            excludeLinks: cfg.urlFilter?.exclude,
            limit: 100,
            onlyMainContent: true,
            waitForMs: 0,
            config: cfg.config,
          },
          deps.firecrawl,
        );
        yield* fallback.discover(ctx);
      }
    },
  };
}
