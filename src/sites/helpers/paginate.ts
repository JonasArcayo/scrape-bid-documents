import type { Page } from 'playwright';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Click a "next" control until it disappears/disables. Yields the 1-based page number after
 * each page is ready (the first page is yielded without clicking).
 */
export async function* clickNext(
  page: Page,
  opts: { nextSelector: string; maxPages?: number; settleMs?: number; signal?: AbortSignal },
): AsyncGenerator<number> {
  const max = opts.maxPages ?? 500;
  for (let n = 1; n <= max; n++) {
    yield n;
    if (opts.signal?.aborted) return;
    const next = page.locator(opts.nextSelector).first();
    if (
      !(await next.isVisible().catch(() => false)) ||
      !(await next.isEnabled().catch(() => false))
    )
      return;
    await next.click();
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await sleep(opts.settleMs ?? 300);
  }
}

/**
 * Navigate `?page=N`-style URLs. Yields N after each navigation; stops when `isEmpty`
 * says the page has no results (or maxPages is hit).
 */
export async function* urlPattern(
  page: Page,
  build: (n: number) => string,
  opts: {
    start?: number;
    maxPages?: number;
    isEmpty: (page: Page) => Promise<boolean>;
    signal?: AbortSignal;
  },
): AsyncGenerator<number> {
  const start = opts.start ?? 1;
  const max = opts.maxPages ?? 500;
  for (let n = start; n < start + max; n++) {
    if (opts.signal?.aborted) return;
    await page.goto(build(n), { waitUntil: 'domcontentloaded' });
    if (await opts.isEmpty(page)) return;
    yield n;
  }
}

/** Scroll to the bottom until the item count stops growing. Returns the final count. */
export async function infiniteScroll(
  page: Page,
  opts: { itemSelector: string; maxScrolls?: number; settleMs?: number; signal?: AbortSignal },
): Promise<number> {
  let last = -1;
  for (let i = 0; i < (opts.maxScrolls ?? 100); i++) {
    if (opts.signal?.aborted) break;
    const count = await page.locator(opts.itemSelector).count();
    if (count === last) return count;
    last = count;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(opts.settleMs ?? 800);
  }
  return page.locator(opts.itemSelector).count();
}

/** Click a "load more" button until it disappears or no new items appear. Returns the final count. */
export async function loadMoreButton(
  page: Page,
  opts: {
    buttonSelector: string;
    itemSelector: string;
    maxClicks?: number;
    settleMs?: number;
    signal?: AbortSignal;
  },
): Promise<number> {
  let last = await page.locator(opts.itemSelector).count();
  for (let i = 0; i < (opts.maxClicks ?? 100); i++) {
    if (opts.signal?.aborted) break;
    const btn = page.locator(opts.buttonSelector).first();
    if (!(await btn.isVisible().catch(() => false))) break;
    await btn.click();
    await sleep(opts.settleMs ?? 800);
    const count = await page.locator(opts.itemSelector).count();
    if (count === last) break;
    last = count;
  }
  return last;
}
