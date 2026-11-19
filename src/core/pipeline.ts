import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { extractArchive, detectFileType, type ExtractResult } from './archive.js';
import type { SiteConfig } from './config.js';
import type { DocumentDownloader } from './downloader.js';
import { AuthError, CorruptArchiveError, ZipSafetyError } from './errors.js';
import type { Logger } from './logger.js';
import type { Manifest } from './manifest.js';
import type { DocumentRef, DownloadResult, SiteSummary } from './models.js';
import type { StorageBackend } from './storage.js';
import type { SiteAdapter, SiteContext } from '../sites/types.js';
import { sanitizeFilename, withHashSuffix } from '../utils/sanitize.js';
import { withRetry } from '../utils/retry.js';

const GENERIC_EXT = new Set([
  'aspx',
  'php',
  'ashx',
  'jsp',
  'do',
  'html',
  'htm',
  'bin',
  'tmp',
  'dl',
  'cgi',
]);

/** Stable identity for a document: adapter's externalId, else derived from the request. */
export function deriveKey(ref: DocumentRef): string {
  if (ref.externalId) return `ext:${ref.externalId}`;
  const d = ref.download;
  switch (d.kind) {
    case 'url':
      return `url:${d.url}`;
    case 'request': {
      const body =
        d.body === undefined ? '' : createHash('sha1').update(JSON.stringify(d.body)).digest('hex');
      return `req:${d.method} ${d.url} ${body}`;
    }
    case 'click':
      return `click:${ref.sourcePageUrl}|${ref.title ?? ''}`;
  }
}

function ensureExt(name: string, ext: string): string {
  if (ext === 'bin') return name;
  const i = name.lastIndexOf('.');
  const existing = i > 0 ? name.slice(i + 1).toLowerCase() : '';
  if (existing === ext) return name;
  if (GENERIC_EXT.has(existing)) return `${name.slice(0, i)}.${ext}`;
  return `${name}.${ext}`;
}

/** Storage key layout: `<site>/<yyyy-mm>/<sanitized-name>.<ext>`. */
export function buildStorageKey(o: {
  site: string;
  date: Date;
  baseName: string;
  ext: string;
}): string {
  const month = o.date.toISOString().slice(0, 7);
  const name = sanitizeFilename(ensureExt(sanitizeFilename(o.baseName), o.ext));
  return `${sanitizeFilename(o.site)}/${month}/${name}`;
}

function specUrl(ref: DocumentRef): string | null {
  return ref.download.kind === 'click' ? null : ref.download.url;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const errMsg = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** A zeroed per-site summary. */
export function emptySummary(site: string): SiteSummary {
  return {
    site,
    discovered: 0,
    downloaded: 0,
    duplicates: 0,
    skipped: 0,
    extractedFiles: 0,
    failed: 0,
    failedExtract: 0,
    needsPassword: 0,
  };
}

/** All collaborators are injected: the pipeline has no knowledge of browsers or disks. */
export interface PipelineDeps {
  adapter: SiteAdapter;
  ctx: SiteContext;
  downloader: DocumentDownloader;
  storage: StorageBackend;
  manifest: Manifest;
  logger: Logger;
  config: SiteConfig;
  /** Scratch directory for in-progress downloads and extraction. */
  tmpDir: string;
  /** Stop after discovering this many documents. */
  limit?: number;
  /** Only (re)process documents with these keys (retry-failed mode). */
  retryKeys?: Set<string>;
  now?: () => Date;
  /** Called after a document fails (e.g. to dump debug info). */
  onFailure?: (ref: DocumentRef, err: unknown) => Promise<void>;
}

/** discover -> download -> post-process, for one site. Never throws; returns a summary. */
export class Pipeline {
  private readonly summary: SiteSummary;
  private loginEpoch = 0;
  private loginInFlight?: Promise<void>;
  private readonly site: string;

  constructor(private readonly deps: PipelineDeps) {
    this.site = deps.adapter.name;
    this.summary = emptySummary(this.site);
  }

  async run(): Promise<SiteSummary> {
    const { adapter, ctx, config, limit, retryKeys, logger } = this.deps;
    const gate = pLimit(config.concurrency);
    const tasks = new Set<Promise<void>>();
    const seen = new Set<string>();
    try {
      for await (const ref of adapter.discover(ctx)) {
        if (ctx.signal.aborted) break;
        const key = deriveKey(ref);
        if (retryKeys) {
          if (!retryKeys.has(key)) continue;
          seen.add(key);
        }
        if (limit !== undefined && this.summary.discovered >= limit) break;
        this.summary.discovered++;
        const task: Promise<void> = gate(() => this.process(ref, key)).finally(() =>
          tasks.delete(task),
        );
        tasks.add(task);
        if (retryKeys && seen.size >= retryKeys.size) break;
        while (tasks.size >= config.concurrency * 3) await Promise.race(tasks);
      }
    } catch (err) {
      this.summary.fatal = errMsg(err);
      logger.error({ err, site: this.site }, 'discovery aborted');
    }
    await Promise.allSettled(tasks);
    return this.summary;
  }

  private async process(ref: DocumentRef, key: string): Promise<void> {
    const { manifest, logger } = this.deps;
    const log = logger.child({ site: this.site, docId: key });
    if (!this.deps.retryKeys && manifest.shouldSkip(this.site, key)) {
      this.summary.skipped++;
      return;
    }
    let result: DownloadResult | undefined;
    let rowId: number | undefined;
    try {
      const row = manifest.upsert(this.site, key, {
        url: specUrl(ref),
        title: ref.title ?? null,
        sourcePageUrl: ref.sourcePageUrl,
      });
      rowId = row.id;
      result = await this.fetch(ref);
      await this.store(ref, row.id, key, result, log);
    } catch (err) {
      this.summary.failed++;
      log.error({ err }, 'document failed');
      if (rowId !== undefined) manifest.markStatus(rowId, 'failed', errMsg(err));
      await this.deps.onFailure?.(ref, err).catch(() => undefined);
    } finally {
      if (result) await fsp.rm(result.tmpPath, { force: true });
    }
  }

  private async fetch(ref: DocumentRef): Promise<DownloadResult> {
    const { downloader, ctx, config, adapter } = this.deps;
    const attempt = () =>
      withRetry(
        async () => {
          await ctx.rateLimit();
          return downloader.download(ref.download, ctx);
        },
        {
          retries: config.retries,
          minTimeoutMs: config.retryMinTimeoutMs,
          maxTimeoutMs: config.retryMaxTimeoutMs,
          onRetry: ({ attempt: n, error, delayMs }) =>
            this.deps.logger.warn(
              { site: this.site, attempt: n, delayMs, err: errMsg(error) },
              'retrying',
            ),
        },
      );
    const epoch = this.loginEpoch;
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof AuthError) || !adapter.login) throw err;
      this.deps.logger.warn(
        { site: this.site },
        'session looks expired: re-login once, then retry',
      );
      await this.relogin(epoch);
      return attempt();
    }
  }

  /** Serialize re-login across concurrent documents; skip if someone already re-logged since `epoch`. */
  private relogin(epoch: number): Promise<void> {
    const { adapter, ctx } = this.deps;
    if (epoch !== this.loginEpoch) return this.loginInFlight ?? Promise.resolve();
    if (!this.loginInFlight && adapter.login) {
      this.loginInFlight = adapter
        .login(ctx)
        .then(() => {
          this.loginEpoch++;
        })
        .finally(() => {
          this.loginInFlight = undefined;
        });
    }
    return this.loginInFlight ?? Promise.resolve();
  }

  private async store(
    ref: DocumentRef,
    rowId: number,
    key: string,
    result: DownloadResult,
    log: Logger,
  ): Promise<void> {
    const { manifest, storage, config, tmpDir } = this.deps;
    const { duplicateOf: existing } = manifest.claimSha(rowId, result.sha256);
    if (existing) {
      manifest.markStatus(rowId, 'duplicate', `duplicate of #${existing.id}`);
      this.summary.duplicates++;
      log.info({ of: existing.id }, 'duplicate content, skipped');
      return;
    }

    // Extract before `put` (which moves the file); original is kept either way.
    let extraction: ExtractResult | undefined;
    let extractError: string | undefined;
    const extractDir = path.join(tmpDir, `extract-${randomUUID()}`);
    try {
      if (result.detectedType.isZip) {
        try {
          extraction = await extractArchive(result.tmpPath, extractDir, { limits: config.zip });
        } catch (err) {
          if (err instanceof ZipSafetyError || err instanceof CorruptArchiveError)
            extractError = errMsg(err);
          else throw err;
        }
      }

      const ext = result.detectedType.ext;
      const baseName =
        ref.title ?? result.suggestedName ?? this.nameFromUrl(ref) ?? ref.externalId ?? 'document';
      const date = (this.deps.now ?? (() => new Date()))();
      let storageKey = buildStorageKey({ site: this.site, date, baseName, ext });
      if (await storage.exists(storageKey)) {
        storageKey = buildStorageKey({
          site: this.site,
          date,
          baseName: withHashSuffix(sanitizeFilename(baseName), result.sha256),
          ext,
        });
      }
      await storage.put(result.tmpPath, storageKey);
      manifest.recordDownload(rowId, {
        sha256: result.sha256,
        size: result.size,
        type: ext,
        storageKey,
      });
      this.summary.downloaded++;

      if (!result.detectedType.isZip) return;
      if (extractError !== undefined || !extraction) {
        manifest.markStatus(rowId, 'failed_extract', extractError);
        this.summary.failedExtract++;
        log.warn({ error: extractError }, 'zip extraction failed; original kept');
        return;
      }
      const prefix = `${storageKey.replace(/\.[^./]+$/, '')}_extracted`;
      for (const f of extraction.files) {
        await this.storeChild(rowId, key, prefix, f.relPath, f.absPath, f.size);
      }
      for (const skipped of extraction.skippedEntries)
        log.warn({ skipped }, 'skipped unsafe zip entry');
      for (const nested of extraction.nestedSkipped)
        log.warn({ nested }, 'nested archive not extracted');
      if (extraction.outcome === 'needs_password') {
        manifest.markStatus(
          rowId,
          'needs_password',
          `encrypted entries: ${extraction.encryptedEntries.join(', ')}`,
        );
        this.summary.needsPassword++;
      } else {
        manifest.markStatus(rowId, 'extracted');
      }
    } finally {
      await fsp.rm(extractDir, { recursive: true, force: true });
    }
  }

  private async storeChild(
    parentId: number,
    parentKey: string,
    prefix: string,
    relPath: string,
    absPath: string,
    size: number,
  ): Promise<void> {
    const { manifest, storage } = this.deps;
    const sha256 = await sha256File(absPath);
    const detected = await detectFileType(absPath);
    const fileExt = path.extname(relPath).slice(1).toLowerCase();
    const type = detected.ext === 'bin' ? fileExt || 'bin' : detected.ext;
    const childKey = `${parentKey}::${relPath}`;
    const storageKey = `${prefix}/${relPath}`;
    const child0 = manifest.insertChild(parentId, this.site, childKey, {
      sha256: null,
      size,
      type,
      storageKey,
    });
    const { duplicateOf: dup } = manifest.claimSha(child0.id, sha256);
    if (dup) {
      manifest.markStatus(child0.id, 'duplicate', `duplicate of #${dup.id}`);
      return;
    }
    await storage.put(absPath, storageKey);
    manifest.insertChild(parentId, this.site, childKey, { sha256, size, type, storageKey });
    this.summary.extractedFiles++;
  }

  private nameFromUrl(ref: DocumentRef): string | undefined {
    const u = specUrl(ref);
    if (!u) return undefined;
    try {
      const seg = decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() ?? '');
      return seg || undefined;
    } catch {
      return undefined;
    }
  }
}
