import fsp from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import type { Page } from 'playwright';
import type { SiteBrowser } from './browser.js';
import { resolveSiteConfig, type GlobalConfig, type SiteConfig } from './config.js';
import type { DocumentDownloader } from './downloader.js';
import type { Logger } from './logger.js';
import type { Manifest } from './manifest.js';
import type { SiteSummary } from './models.js';
import { emptySummary, Pipeline } from './pipeline.js';
import type { StorageBackend } from './storage.js';
import type { AdapterRegistry } from '../sites/registry.js';
import type { SiteContext } from '../sites/types.js';
import { createRateLimiter } from '../utils/rateLimit.js';

export interface RunnerDeps {
  registry: Pick<AdapterRegistry, 'get'>;
  config: GlobalConfig;
  manifest: Manifest;
  storage: StorageBackend;
  logger: Logger;
  browser: { openSite(site: string, config: SiteConfig): Promise<SiteBrowser> };
  createDownloader: (a: {
    site: string;
    config: SiteConfig;
    tmpDir: string;
    logger: Logger;
    onPageFailure: (page: Page, err: unknown) => Promise<void>;
  }) => DocumentDownloader;
  dumper: { dump(site: string, page: Page, reason: string): Promise<string | undefined> };
  /** Aborted on SIGINT/SIGTERM. */
  signal: AbortSignal;
}

export interface RunOptions {
  limit?: number;
  /** Re-attempt only documents previously recorded as failed. */
  retryFailed?: boolean;
  /** Applied on top of adapter config (e.g. `{ headless: false }` from --headed). */
  overrides?: Partial<SiteConfig>;
  /** Number of sites to run in parallel (default: 1). */
  siteConcurrency?: number;
}

const errMsg = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Runs 1..N sites with bounded concurrency; a failing site never stops the rest. */
export class Runner {
  constructor(private readonly deps: RunnerDeps) {}

  async run(names: string[], opts: RunOptions = {}): Promise<SiteSummary[]> {
    const concurrency = Math.max(1, opts.siteConcurrency ?? 1);
    const gate = pLimit(concurrency);
    const results = await Promise.all(
      names.map((name) =>
        gate(async () => {
          if (this.deps.signal.aborted) {
            this.deps.logger.warn(
              { skippedFrom: name },
              'shutdown requested: not starting remaining sites',
            );
            return undefined;
          }
          return this.runSite(name, opts);
        }),
      ),
    );
    return results.filter((s): s is SiteSummary => s !== undefined);
  }

  private async runSite(name: string, opts: RunOptions): Promise<SiteSummary> {
    const { registry, config, manifest, storage, logger, browser, signal } = this.deps;
    const adapter = registry.get(name);
    if (!adapter) return { ...emptySummary(name), fatal: `Unknown site: ${name}` };

    const log = logger.child({ site: name });
    let siteBrowser: SiteBrowser | undefined;
    const tmpDir = path.join(config.dataDir, 'tmp', name);
    try {
      const cfg = resolveSiteConfig(resolveSiteConfig(config.site, adapter.config), opts.overrides);
      let retryKeys: Set<string> | undefined;
      if (opts.retryFailed) {
        retryKeys = new Set(manifest.listFailed(name).map((r) => r.key));
        if (retryKeys.size === 0) {
          log.info('no failed documents to retry');
          return emptySummary(name);
        }
      }

      siteBrowser = await browser.openSite(name, cfg);
      const open = new Set<Page>();
      const sb = siteBrowser;
      const ctx: SiteContext = {
        site: name,
        browserContext: sb.context,
        newPage: async () => {
          const page = await sb.newPage();
          open.add(page);
          page.once('close', () => open.delete(page));
          return page;
        },
        logger: log,
        config: cfg,
        rateLimit: createRateLimiter({
          minDelayMs: cfg.minDelayMs,
          maxDelayMs: cfg.maxDelayMs,
          signal,
        }),
        signal,
        dumpDebug: (page, reason) => this.deps.dumper.dump(name, page, reason),
      };

      if (adapter.login) {
        const loggedIn = adapter.isLoggedIn
          ? await adapter.isLoggedIn(ctx).catch(() => false)
          : false;
        if (!loggedIn) {
          log.info('logging in');
          await adapter.login(ctx);
          await sb.saveSession();
        } else {
          log.info('reusing saved session');
        }
      }

      const downloader = this.deps.createDownloader({
        site: name,
        config: cfg,
        tmpDir,
        logger: log,
        onPageFailure: async (page, err) =>
          void (await this.deps.dumper.dump(name, page, errMsg(err))),
      });
      const summary = await new Pipeline({
        adapter,
        ctx,
        downloader,
        storage,
        manifest,
        logger,
        config: cfg,
        tmpDir,
        limit: opts.limit,
        retryKeys,
      }).run();

      if (summary.fatal) {
        for (const page of open) await this.deps.dumper.dump(name, page, summary.fatal);
      }
      return summary;
    } catch (err) {
      log.error({ err }, 'site run failed');
      return { ...emptySummary(name), fatal: errMsg(err) };
    } finally {
      await siteBrowser
        ?.close()
        .catch((err: unknown) => log.warn({ err }, 'error closing site browser'));
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
