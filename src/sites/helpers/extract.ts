import type { Locator, Page } from 'playwright';
import { SiteChangedError } from '../../core/errors.js';

export interface ExtractedLink {
  /** Absolute URL. */
  href: string;
  text: string;
}

/**
 * Assert a selector is present; otherwise throw SiteChangedError with a clear message.
 * Use for selectors the flow cannot continue without (NOT for optional steps).
 */
export async function requireSelector(
  page: Page,
  selector: string,
  what: string,
  opts: {
    timeoutMs?: number;
    /** Pass `ctx.dumpDebug` to save a screenshot + HTML when the selector is missing. */
    dump?: (page: Page, reason: string) => Promise<unknown>;
  } = {},
): Promise<Locator> {
  const loc = page.locator(selector).first();
  try {
    await loc.waitFor({ state: 'attached', timeout: opts.timeoutMs ?? 10_000 });
  } catch {
    await opts.dump?.(page, `missing ${what} (${selector})`).catch(() => undefined);
    throw new SiteChangedError(
      `Expected ${what} (selector "${selector}") not found on ${page.url()}: the site layout may have changed`,
    );
  }
  return loc;
}

/** True if the selector becomes visible within the timeout (for optional steps). */
export async function isVisible(page: Page, selector: string, timeoutMs = 3000): Promise<boolean> {
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** Collect absolute hrefs + text from anchors matched by `linkSelector` inside table rows. */
export async function extractLinksFromTable(
  page: Page,
  opts: { rowSelector: string; linkSelector: string },
): Promise<ExtractedLink[]> {
  return page.$$eval(
    opts.rowSelector,
    (rows, linkSel) =>
      rows.flatMap((row) =>
        Array.from(row.querySelectorAll<HTMLElement>(linkSel)).flatMap((el) => {
          const href =
            el instanceof HTMLAnchorElement
              ? el.href
              : el instanceof HTMLInputElement
                ? el.value
                : '';
          return href ? [{ href, text: (el.textContent ?? '').trim() }] : [];
        }),
      ),
    opts.linkSelector,
  );
}

/** Collect absolute hrefs + text from every element matched by a locator. */
export async function extractByLocator(locator: Locator): Promise<ExtractedLink[]> {
  return locator.evaluateAll((els) =>
    els.flatMap((el) => {
      const a = el instanceof HTMLAnchorElement ? el : el.closest('a');
      return a ? [{ href: a.href, text: (a.textContent ?? '').trim() }] : [];
    }),
  );
}
