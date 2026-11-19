#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import { BrowserManager } from './core/browser.js';
import { loadConfig } from './core/config.js';
import { DebugDumper } from './core/debug.js';
import { Downloader } from './core/downloader.js';
import { createLogger } from './core/logger.js';
import { Manifest } from './core/manifest.js';
import { ALL_STATUSES, type SiteSummary } from './core/models.js';
import { Runner, type RunOptions } from './core/runner.js';
import { LocalFsStorage } from './core/storage.js';
import { loadRegistry, type AdapterRegistry } from './sites/registry.js';
import { installShutdown } from './utils/shutdown.js';

const collect = (v: string, prev: string[]): string[] => [...prev, v];

function printSummary(summaries: SiteSummary[], registry: AdapterRegistry): void {
  if (summaries.length === 0) return console.log('No sites were run.');
  console.table(
    summaries.map((s) => ({
      site: s.site,
      discovered: s.discovered,
      downloaded: s.downloaded,
      duplicates: s.duplicates,
      skipped: s.skipped,
      extracted: s.extractedFiles,
      failed: s.failed,
      failed_extract: s.failedExtract,
      needs_password: s.needsPassword,
      fatal: s.fatal ?? '',
      config: s.fatal ? (registry.getMeta(s.site)?.configPath ?? '') : '',
    })),
  );
}

async function execute(sites: string[], opts: RunOptions & { headed?: boolean }): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const registry = await loadRegistry();
  const unknown = sites.filter((s) => !registry.get(s));
  if (unknown.length > 0) {
    console.error(`Unknown site(s): ${unknown.join(', ')}. Run "scraper list".`);
    process.exitCode = 2;
    return;
  }
  const manifest = new Manifest(config.dbPath);
  const shutdown = installShutdown(logger);
  const debugDir = path.join(config.dataDir, 'debug');
  const browser = new BrowserManager({ sessionsDir: config.sessionsDir, debugDir, logger });
  const dumper = new DebugDumper(debugDir, logger);
  try {
    const runner = new Runner({
      registry,
      config,
      manifest,
      storage: new LocalFsStorage(path.join(config.dataDir, 'downloads')),
      logger,
      browser,
      dumper,
      signal: shutdown.signal,
      createDownloader: ({ tmpDir, config: siteConfig, logger: log, onPageFailure }) =>
        new Downloader({ tmpDir, config: siteConfig, logger: log, onPageFailure }),
    });
    const summaries = await runner.run(sites, {
      limit: opts.limit,
      retryFailed: opts.retryFailed,
      siteConcurrency: opts.siteConcurrency,
      overrides: opts.headed ? { headless: false } : undefined,
    });
    printSummary(summaries, registry);
    if (summaries.some((s) => s.fatal)) process.exitCode = 1;
  } finally {
    shutdown.dispose();
    await browser.shutdown();
    manifest.close();
  }
}

const program = new Command().name('scraper').description('Multi-site document scraper');

program
  .command('list')
  .description('List registered sites')
  .option('-t, --tag <tag>', 'filter by config tag')
  .action(async (o: { tag?: string }) => {
    const reg = await loadRegistry();
    const list = o.tag ? reg.listByTag(o.tag) : reg.list();
    for (const a of list) console.log(a.name);
  });

program
  .command('run')
  .description('Run one or more sites')
  .option('-s, --site <name>', 'site to run (repeatable)', collect, [] as string[])
  .option('-t, --tag <tag>', 'run all sites with this tag')
  .option('--all', 'run every registered site')
  .option('-c, --concurrency <n>', 'sites to run in parallel', (v) => Number.parseInt(v, 10))
  .option('--limit <n>', 'max documents to discover per site', (v) => Number.parseInt(v, 10))
  .option('--headed', 'show the browser window')
  .action(
    async (o: {
      site: string[];
      tag?: string;
      all?: boolean;
      concurrency?: number;
      limit?: number;
      headed?: boolean;
    }) => {
      const reg = await loadRegistry();
      const sites = o.all
        ? reg.list().map((a) => a.name)
        : o.tag
          ? reg.listByTag(o.tag).map((a) => a.name)
          : o.site;
      if (sites.length === 0) {
        console.error('Specify --site <name> (repeatable), --tag <tag>, or --all');
        process.exitCode = 2;
        return;
      }
      await execute(sites, {
        limit: o.limit,
        headed: o.headed,
        siteConcurrency: o.concurrency,
      });
    },
  );

program
  .command('stats')
  .description('Counts by status from the manifest')
  .option('-s, --site <name>', 'restrict to one site')
  .action((o: { site?: string }) => {
    const config = loadConfig();
    const manifest = new Manifest(config.dbPath);
    try {
      const stats = manifest.stats(o.site);
      console.table(ALL_STATUSES.map((status) => ({ status, count: stats[status] })));
    } finally {
      manifest.close();
    }
  });

program
  .command('retry-failed')
  .description('Re-attempt documents that previously failed')
  .requiredOption('-s, --site <name>', 'site (repeatable)', collect, [] as string[])
  .option('--headed', 'show the browser window')
  .action(async (o: { site: string[]; headed?: boolean }) => {
    if (o.site.length === 0) {
      console.error('Specify --site <name> (repeatable)');
      process.exitCode = 2;
      return;
    }
    await execute(o.site, { retryFailed: true, headed: o.headed });
  });

await program.parseAsync(process.argv);
