import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { SiteConfig } from './config.js';
import { FINGERPRINT_INJECT_SCRIPT, getRandomHeaders, getRandomViewport } from './fingerprint.js';
import type { Logger } from './logger.js';

export interface SiteBrowser {
  context: BrowserContext;
  newPage(): Promise<Page>;
  /** Persist cookies/localStorage to sessions/<site>.json (mode 0600). */
  saveSession(): Promise<void>;
  /** Save session, stop tracing (if on), close the context. */
  close(): Promise<void>;
}

export interface BrowserManagerOptions {
  sessionsDir: string;
  debugDir: string;
  logger: Logger;
}

/** Owns the Chromium process; hands out one isolated BrowserContext per site run. */
export class BrowserManager {
  private readonly browsers = new Map<boolean, Browser>();
  constructor(private readonly opts: BrowserManagerOptions) {}

  private sessionPath(site: string): string {
    return path.join(this.opts.sessionsDir, `${site.replace(/[^a-z0-9_-]/gi, '_')}.json`);
  }

  private async getBrowser(headless: boolean): Promise<Browser> {
    let b = this.browsers.get(headless);
    if (!b) this.browsers.set(headless, (b = await chromium.launch({ headless })));
    return b;
  }

  /** Open a context for `site`, restoring its saved storageState when present. */
  async openSite(site: string, config: SiteConfig): Promise<SiteBrowser> {
    const browser = await this.getBrowser(config.headless);
    const sessionFile = this.sessionPath(site);
    const hasSession = await fsp.access(sessionFile).then(
      () => true,
      () => false,
    );
    const headers = config.fingerprint ? getRandomHeaders() : undefined;
    const viewport = config.fingerprint ? getRandomViewport() : undefined;
    const context = await browser.newContext({
      acceptDownloads: true,
      ...(hasSession && { storageState: sessionFile }),
      ...(headers && {
        userAgent: headers['User-Agent'],
        extraHTTPHeaders: { 'Accept-Language': headers['Accept-Language'] },
      }),
      ...(viewport && { viewport }),
    });
    if (config.fingerprint) {
      await context.addInitScript(FINGERPRINT_INJECT_SCRIPT);
    }
    context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    context.setDefaultTimeout(config.navigationTimeoutMs);
    if (hasSession) this.opts.logger.info({ site }, 'restored saved session');

    if (config.blockResources.length > 0) {
      const blocked = new Set<string>(config.blockResources);
      await context.route('**/*', (route) =>
        blocked.has(route.request().resourceType()) ? route.abort() : route.continue(),
      );
    }
    if (config.trace) await context.tracing.start({ screenshots: true, snapshots: true });

    const saveSession = async () => {
      await fsp.mkdir(this.opts.sessionsDir, { recursive: true });
      const state = await context.storageState();
      await fsp.writeFile(sessionFile, JSON.stringify(state), { mode: 0o600 });
    };
    return {
      context,
      newPage: () => context.newPage(),
      saveSession,
      close: async () => {
        await saveSession().catch((err: unknown) =>
          this.opts.logger.warn({ site, err }, 'failed to save session'),
        );
        if (config.trace) {
          const dir = path.join(this.opts.debugDir, site);
          await fsp.mkdir(dir, { recursive: true });
          await context.tracing
            .stop({ path: path.join(dir, `trace-${Date.now()}.zip`) })
            .catch(() => undefined);
        }
        await context.close().catch(() => undefined);
      },
    };
  }

  /** Close the browser process. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.browsers.values()].map((b) => b.close().catch(() => undefined)));
    this.browsers.clear();
  }
}
