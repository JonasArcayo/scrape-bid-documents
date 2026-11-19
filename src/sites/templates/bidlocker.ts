/**
 * bidlocker.us template: Keycloak SSO login + ShowAll listing + optional interest toggle
 * + optional vendor registration + ZIP bundle download.
 */
import type { Page } from 'playwright';
import { AuthError, NonRetryableError, SiteChangedError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { DocumentRef } from '../../core/models.js';
import type { BidlockerSiteConfig } from '../configSchema.js';
import { formLogin, requireEnv } from '../helpers/auth.js';
import { requireSelector } from '../helpers/extract.js';
import type { SiteAdapter, SiteContext } from '../types.js';

const BASE = 'https://bidlocker.us';
const LOGIN_LINK = 'a[href="/Account/Login"]';
const BUNDLE_ENABLED = 'a#download-attachment-bundle:not([disabled])';

/** Match /a/<agency>/details/<id>_<slug> on bidlocker.us (relative or absolute). */
export function parseDetailHref(href: string): { agency: string; id: string } | undefined {
  if (!href) return undefined;
  let u: URL;
  try {
    u = new URL(href, BASE);
  } catch {
    return undefined;
  }
  if (u.hostname !== 'bidlocker.us' && u.hostname !== 'www.bidlocker.us') return undefined;
  const m = /^\/a\/([A-Za-z0-9_]+)\/details\/(\d+)_/.exec(u.pathname);
  return m ? { agency: m[1] as string, id: m[2] as string } : undefined;
}

export interface ListingItem {
  id: string;
  url: string;
  title: string;
}

/**
 * Step 1: collect unique detail links from a ShowAll page. Returns [] for a genuinely empty
 * listing ("0 RESULTS"); throws SiteChangedError if there are no links and no zero-count.
 */
export async function extractListing(page: Page, agency: string): Promise<ListingItem[]> {
  const anchors = await page.$$eval(
    '.results span[class^="title"] a, .results span[class^="link"] a',
    (as) =>
      as.map((a) => ({
        href: (a as HTMLAnchorElement).href,
        text: (a.textContent ?? '').trim(),
        titleAttr: a.getAttribute('title') ?? '',
      })),
  );
  const byId = new Map<string, ListingItem>();
  for (const a of anchors) {
    const parsed = parseDetailHref(a.href);
    if (!parsed || parsed.agency.toLowerCase() !== agency.toLowerCase()) continue;
    const fallback = a.titleAttr.replace(/^View details for\s*/i, '');
    const text = /^view details$/i.test(a.text) || a.text === '' ? fallback : a.text;
    const existing = byId.get(parsed.id);
    if (!existing || (existing.title === '' && text !== '')) {
      byId.set(parsed.id, { id: parsed.id, url: a.href, title: text });
    }
  }
  if (byId.size > 0) return [...byId.values()];

  const count = await page
    .locator('.search-results .count')
    .first()
    .textContent({ timeout: 2000 })
    .catch(() => null);
  if (count && /^\s*0\s+RESULT/i.test(count)) return [];
  throw new SiteChangedError(
    `No listing links and no "0 RESULTS" marker for agency "${agency}" on ${page.url()}: layout may have changed`,
  );
}

export interface PrepareDeps {
  rateLimit: () => Promise<void>;
  logger: Pick<Logger, 'info' | 'warn' | 'debug'>;
  /** Called after each navigation; may log in again or throw AuthError if the session expired. */
  ensureSession?: (page: Page, url: string) => Promise<void>;
  /** How long to wait for the bundle button to enable after steps 2/3 (default 5000). */
  bundleWaitMs?: number;
}

/**
 * Steps 2-4 preparation on a detail page. Returns true when the bundle download link is
 * enabled (ready to click), false when the listing has no downloadable bundle.
 */
export async function prepareDetail(page: Page, url: string, deps: PrepareDeps): Promise<boolean> {
  const log = deps.logger;
  const waitMs = deps.bundleWaitMs ?? 5000;
  let registeredOnce = false;
  for (let pass = 1; pass <= 2; pass++) {
    await deps.rateLimit();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await deps.ensureSession?.(page, url);
    let acted = false;

    const toggle = page.locator('a#toggle-interest').first();
    if ((await toggle.count()) > 0) {
      const text = (await toggle.textContent()) ?? '';
      if (/interest expressed/i.test(text)) {
        log.debug({ url }, 'interest already expressed');
      } else if (/express interest/i.test(text)) {
        await toggle.click();
        acted = true;
        await page
          .waitForFunction(
            () =>
              /interest expressed/i.test(
                document.querySelector('#toggle-interest')?.textContent ?? '',
              ),
            undefined,
            { timeout: 10_000 },
          )
          .catch(() => log.warn({ url }, 'interest toggle did not confirm; continuing'));
      } else {
        log.warn({ url, text: text.trim() }, 'unrecognised interest control text; not clicking');
      }
    }

    const register = page.locator('a[href^="/Vendor/Setup/"]').first();
    if (!registeredOnce && (await register.isVisible().catch(() => false))) {
      registeredOnce = true;
      acted = true;
      log.info({ url }, 'registering as vendor for this agency');
      await Promise.all([page.waitForLoadState('domcontentloaded'), register.click()]);
      log.info({ landedOn: page.url() }, 'vendor registration link followed');
      await deps.rateLimit();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    const bundle = page.locator(BUNDLE_ENABLED).first();
    if ((await bundle.count()) > 0) return true;
    if (acted) {
      const ready = await bundle.waitFor({ state: 'attached', timeout: waitMs }).then(
        () => true,
        () => false,
      );
      if (ready) return true;
    }
    if (!acted) break;
  }
  return false;
}

function adapterDeps(
  ctx: SiteContext,
  onLoggedOut: (page: Page, url: string) => Promise<void>,
): PrepareDeps {
  return {
    rateLimit: () => ctx.rateLimit(),
    logger: ctx.logger,
    ensureSession: async (page, url) => {
      if ((await page.locator(LOGIN_LINK).count()) > 0) await onLoggedOut(page, url);
    },
  };
}

async function login(ctx: SiteContext): Promise<void> {
  const username = requireEnv('BIDLOCKER_USER');
  const password = requireEnv('BIDLOCKER_PASS');
  const page = await ctx.newPage();
  try {
    await ctx.rateLimit();
    await formLogin(page, {
      loginUrl: `${BASE}/Account/Login`,
      usernameSelector: '#username',
      passwordSelector: '#password',
      submitSelector: '#kc-login',
      username,
      password,
      loginUrlPattern: /auth\.bidlocker\.us/,
    });
  } catch (err) {
    await ctx.dumpDebug(page, 'login failed');
    throw err;
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function isLoggedIn(ctx: SiteContext): Promise<boolean> {
  const page = await ctx.newPage();
  try {
    await ctx.rateLimit();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    return (
      !/auth\.bidlocker\.us/.test(page.url()) && (await page.locator(LOGIN_LINK).count()) === 0
    );
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Build a BidLocker SiteAdapter for a single agency from a declarative JSON config. */
export function buildBidlockerAdapter(cfg: BidlockerSiteConfig): SiteAdapter {
  const { agency } = cfg;
  return {
    name: cfg.name,
    config: { concurrency: 2, minDelayMs: 1000, maxDelayMs: 2500, ...cfg.config },
    login,
    isLoggedIn,
    async *discover(ctx: SiteContext): AsyncGenerator<DocumentRef> {
      const log = ctx.logger.child({ agency });
      const page = await ctx.newPage();
      try {
        await ctx.rateLimit();
        await page.goto(`${BASE}/a/${agency}/ShowAll`, { waitUntil: 'domcontentloaded' });
        await requireSelector(page, '.search-results', 'results area', {
          dump: (p, r) => ctx.dumpDebug(p, r),
        });
        const items = await extractListing(page, agency);
        if (items.length === 0) {
          log.info('empty listing, nothing to do');
          return;
        }
        log.info({ count: items.length }, 'listing found');

        for (const item of items) {
          if (ctx.signal.aborted) return;
          let ready: boolean;
          try {
            ready = await prepareDetail(
              page,
              item.url,
              adapterDeps(ctx, async (p, url) => {
                ctx.logger.warn('session expired during discovery: logging in again');
                await login(ctx);
                await p.goto(url, { waitUntil: 'domcontentloaded' });
              }),
            );
          } catch (err) {
            if (err instanceof AuthError) throw err;
            log.warn(
              { err: String(err), url: item.url },
              'could not prepare detail page; skipping',
            );
            await ctx.dumpDebug(page, `prepareDetail failed: ${String(err)}`);
            continue;
          }
          if (!ready) {
            log.info({ url: item.url }, 'no downloadable attachment bundle; skipping');
            continue;
          }
          yield {
            externalId: `${agency}:${item.id}`,
            title: `${agency} - ${item.title}`,
            sourcePageUrl: item.url,
            download: {
              kind: 'click',
              open: async (p) => {
                const ok = await prepareDetail(
                  p,
                  item.url,
                  adapterDeps(ctx, async () => {
                    throw new AuthError(`Logged out while opening ${item.url}`);
                  }),
                );
                if (!ok)
                  throw new NonRetryableError(`Attachment bundle not available at ${item.url}`);
              },
              trigger: async (p) => {
                await p.locator(BUNDLE_ENABLED).first().click();
              },
            },
            extra: { agency, listingId: item.id },
          };
        }
      } finally {
        await page.close().catch(() => undefined);
      }
    },
  };
}
