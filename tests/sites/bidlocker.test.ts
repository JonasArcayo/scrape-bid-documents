import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import {
  buildBidlockerAdapter,
  extractListing,
  parseDetailHref,
  prepareDetail,
} from '../../src/sites/templates/bidlocker.js';
import { SiteChangedError } from '../../src/core/errors.js';
import { silentLogger } from '../helpers/fakes.js';

const AGENCIES = [
  'oregonmetro',
  'lanecounty',
  'clackamascc',
  'psu_or',
  'lanecc',
  'trimet',
  'olws',
  'rusa',
  'homeforward',
  'tualatinoregon',
  'redmondoregon',
  'clackamascounty',
] as const;

const fixture = (n: string) =>
  fs.readFileSync(path.join(import.meta.dirname, '../fixtures/bidlocker', n), 'utf8');

describe('bidlocker template (pure)', () => {
  it('builds a named adapter with login/session hooks', () => {
    const adapter = buildBidlockerAdapter({
      name: 'bidlocker-trimet',
      enabled: true,
      tags: ['bidlocker'],
      template: 'bidlocker',
      agency: 'trimet',
    });
    expect(adapter.name).toBe('bidlocker-trimet');
    expect(typeof adapter.login).toBe('function');
    expect(typeof adapter.isLoggedIn).toBe('function');
  });

  it('parseDetailHref round-trips id and agency, rejects non-detail links', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...AGENCIES),
        fc.integer({ min: 1, max: 9_999_999 }),
        fc.stringMatching(/^[A-Za-z0-9_]{0,40}$/),
        (agency, id, slug) => {
          const p = parseDetailHref(`/a/${agency}/details/${id}_${slug}`);
          expect(p).toEqual({ agency, id: String(id) });
          expect(
            parseDetailHref(`https://bidlocker.us/a/${agency}/details/${id}_${slug}?x=1`)?.id,
          ).toBe(String(id));
        },
      ),
    );
    for (const bad of [
      '/a/trimet',
      '/a/trimet/ShowAll',
      '/Vendor/Setup/73',
      'https://evil.test/a/x/details/1_a',
      '',
    ]) {
      expect(parseDetailHref(bad)).toBeUndefined();
    }
  });
});

let browser: Browser | undefined;
beforeAll(async () => {
  try {
    browser = await chromium.launch();
  } catch {
    browser = undefined;
  }
});
afterAll(async () => {
  await browser?.close();
});

async function pageWith(html: string, url: string): Promise<Page> {
  if (!browser) throw new Error('no browser');
  const ctx = await browser.newContext();
  await ctx.route('**/*', (route) =>
    route.request().url() === url
      ? route.fulfill({ status: 200, contentType: 'text/html', body: html })
      : route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<html><body>stub</body></html>',
        }),
  );
  const page = await ctx.newPage();
  await page.goto(url);
  return page;
}

/** Minimal stateful stand-in for a logged-in detail page, mirroring the real toggle script. */
function detailHtml(o: { interested: boolean; register?: boolean; bundle?: boolean }): string {
  return `<html><body>
  <a id="toggle-interest" href="#">${o.interested ? 'interest expressed in this listing' : 'express interest'}</a>
  ${o.register ? '<a href="/Vendor/Setup/73" class="catch_redirect">Register with Agency</a>' : ''}
  ${o.bundle === false ? '' : `<a id="download-attachment-bundle" href="${o.interested ? '/bundle.zip' : '#'}" ${o.interested ? '' : 'disabled'}>Download All</a>`}
  <script>
    window.__clicks = 0;
    document.getElementById('toggle-interest').addEventListener('click', function (e) {
      e.preventDefault(); window.__clicks++;
      var on = /interest expressed/.test(this.textContent);
      this.textContent = on ? 'express interest' : 'interest expressed in this listing';
      var b = document.getElementById('download-attachment-bundle');
      if (b) { if (on) { b.setAttribute('disabled', ''); } else { b.removeAttribute('disabled'); b.setAttribute('href', '/bundle.zip'); } }
    });
  </script></body></html>`;
}

const deps = { rateLimit: async () => undefined, logger: silentLogger, bundleWaitMs: 300 };
const URL1 = 'https://bidlocker.us/a/trimet/details/1_t';

describe('bidlocker adapter (browser fixtures)', () => {
  it('extractListing finds every unique detail link on a real ShowAll page', async (t) => {
    if (!browser) return t.skip();
    const page = await pageWith(
      fixture('showall-oregonmetro.html'),
      'https://bidlocker.us/a/oregonmetro/ShowAll',
    );
    const items = await extractListing(page, 'oregonmetro');
    expect(items).toHaveLength(6);
    expect(new Set(items.map((i) => i.id)).size).toBe(6);
    expect(
      items.every((i) => i.url.startsWith('https://bidlocker.us/a/oregonmetro/details/')),
    ).toBe(true);
    expect(items[0]?.title).toMatch(/LED Wall/);
    await page.context().close();
  });

  it('an empty listing (0 RESULTS) yields nothing and is not a SiteChangedError', async (t) => {
    if (!browser) return t.skip();
    const page = await pageWith(
      fixture('showall-empty.html'),
      'https://bidlocker.us/a/clackamascc/ShowAll',
    );
    expect(await extractListing(page, 'clackamascc')).toEqual([]);
    await page.context().close();
  });

  it('a page with no results container and no count is a SiteChangedError', async (t) => {
    if (!browser) return t.skip();
    const page = await pageWith(
      '<html><body><h1>Maintenance</h1></body></html>',
      'https://bidlocker.us/a/x/ShowAll',
    );
    await expect(extractListing(page, 'x')).rejects.toBeInstanceOf(SiteChangedError);
    await page.context().close();
  });

  it('expresses interest exactly once and never toggles it back off', async (t) => {
    if (!browser) return t.skip();
    const page = await pageWith(detailHtml({ interested: false }), URL1);
    expect(await prepareDetail(page, URL1, deps)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(1);
    await page.context().close();

    const already = await pageWith(detailHtml({ interested: true }), URL1);
    expect(await prepareDetail(already, URL1, deps)).toBe(true);
    expect(await already.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(
      0,
    );
    await already.context().close();
  });

  it('handles missing optional steps: no toggle/register links, and no bundle at all', async (t) => {
    if (!browser) return t.skip();
    const noSteps = await pageWith(
      '<html><body><a id="download-attachment-bundle" href="/b.zip">Download All</a></body></html>',
      URL1,
    );
    expect(await prepareDetail(noSteps, URL1, deps)).toBe(true);
    await noSteps.context().close();

    const noBundle = await pageWith(detailHtml({ interested: false, bundle: false }), URL1);
    expect(await prepareDetail(noBundle, URL1, deps)).toBe(false);
    await noBundle.context().close();
  });

  it('follows the vendor-registration link when present, then returns to the detail page', async (t) => {
    if (!browser) return t.skip();
    const page = await pageWith(detailHtml({ interested: true, register: true }), URL1);
    expect(await prepareDetail(page, URL1, deps)).toBe(true);
    expect(page.url()).toBe(URL1);
    await page.context().close();
  });
});
