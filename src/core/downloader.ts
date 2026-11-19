import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Page } from 'playwright';
import type { SiteConfig } from './config.js';
import { detectFileType } from './archive.js';
import { AuthError, NonRetryableError, RetryableError } from './errors.js';
import type { Logger } from './logger.js';
import type { DownloadResult, DownloadSpec } from './models.js';
import type { SiteContext } from '../sites/types.js';
import { classifyHttpStatus } from '../utils/retry.js';

/** The subset of SiteContext the downloader needs. */
export type DownloadContext = Pick<SiteContext, 'browserContext' | 'newPage' | 'signal'>;

/** Anything that can execute a DownloadSpec (the pipeline depends on this, not the class). */
export interface DocumentDownloader {
  download(spec: DownloadSpec, ctx: DownloadContext): Promise<DownloadResult>;
}

/** Extract a filename from a Content-Disposition header (supports RFC 5987 `filename*`). */
export function parseContentDisposition(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star?.[2]) {
    try {
      return decodeURIComponent(star[2].trim());
    } catch {
      /* fall through to plain filename */
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  const v = (plain?.[1] ?? plain?.[2])?.trim();
  return v || undefined;
}

export interface SaveOptions {
  tmpDir: string;
  /** Expected byte length (only pass when the body is not content-encoded). */
  contentLength?: number;
  maxBytes: number;
}

/**
 * Stream `source` to `<tmp>/<id>.part`, hashing as it goes, validate (non-empty, length,
 * size cap, real type), then atomically rename to `<id>.dl`. Cleans up on any failure.
 * @throws RetryableError (empty/truncated), NonRetryableError (too large), AuthError (HTML)
 */
export async function saveValidated(
  source: AsyncIterable<Buffer | Uint8Array | string>,
  opts: SaveOptions,
): Promise<DownloadResult> {
  await fsp.mkdir(opts.tmpDir, { recursive: true });
  const id = randomUUID();
  const part = path.join(opts.tmpDir, `${id}.part`);
  const final = path.join(opts.tmpDir, `${id}.dl`);
  const hash = createHash('sha256');
  let size = 0;
  const fh = await fsp.open(part, 'w');
  try {
    try {
      for await (const raw of source) {
        const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw;
        size += chunk.length;
        if (size > opts.maxBytes) {
          throw new NonRetryableError(`File exceeds max size of ${opts.maxBytes} bytes`);
        }
        hash.update(chunk);
        await fh.write(chunk);
      }
    } finally {
      await fh.close();
    }
    if (size === 0) throw new RetryableError('Downloaded file is empty');
    if (opts.contentLength !== undefined && opts.contentLength !== size) {
      throw new RetryableError(
        `Content-Length mismatch: expected ${opts.contentLength}, got ${size}`,
      );
    }
    const detectedType = await detectFileType(part);
    if (detectedType.isHtml) {
      throw new AuthError(
        'Received an HTML page instead of a document (session expired or error page)',
      );
    }
    await fsp.rename(part, final);
    return { tmpPath: final, sha256: hash.digest('hex'), size, detectedType };
  } catch (err) {
    await fsp.rm(part, { force: true });
    throw err;
  }
}

export interface DownloaderDeps {
  tmpDir: string;
  config: SiteConfig;
  logger: Logger;
  /** Called with the live page when a click-download fails (before it is closed). */
  onPageFailure?: (page: Page, err: unknown) => Promise<void>;
}

/** Executes DownloadSpecs against a site's BrowserContext. Adapters never call this. */
export class Downloader implements DocumentDownloader {
  constructor(private readonly deps: DownloaderDeps) {}

  async download(spec: DownloadSpec, ctx: DownloadContext): Promise<DownloadResult> {
    switch (spec.kind) {
      case 'url':
        return this.viaRequest(ctx, 'GET', spec.url, spec.headers);
      case 'request':
        return this.viaRequest(ctx, spec.method, spec.url, spec.headers, spec.body);
      case 'click':
        return this.viaClick(ctx, spec);
    }
  }

  /** Uses context.request so cookies/session are shared. Body is buffered by Playwright. */
  private async viaRequest(
    ctx: DownloadContext,
    method: string,
    url: string,
    headers?: Record<string, string>,
    body?: string | Record<string, unknown>,
  ): Promise<DownloadResult> {
    const { config } = this.deps;
    const resp = await ctx.browserContext.request.fetch(url, {
      method,
      headers,
      data: body,
      timeout: config.downloadTimeoutMs,
      failOnStatusCode: false,
    });
    const h = resp.headers();
    if (resp.status() === 401) throw new AuthError(`HTTP 401 for ${url}`);
    if (!resp.ok()) throw classifyHttpStatus(resp.status(), h['retry-after'], url);
    const buf = await resp.body();
    const encoded = !!h['content-encoding'];
    const declared = Number(h['content-length']);
    const result = await saveValidated(Readable.from([buf]), {
      tmpDir: this.deps.tmpDir,
      maxBytes: config.maxFileSizeBytes,
      contentLength: !encoded && Number.isFinite(declared) ? declared : undefined,
    });
    return {
      ...result,
      suggestedName: parseContentDisposition(h['content-disposition']),
      finalUrl: resp.url(),
    };
  }

  private async viaClick(
    ctx: DownloadContext,
    spec: Extract<DownloadSpec, { kind: 'click' }>,
  ): Promise<DownloadResult> {
    const { config } = this.deps;
    const page = await ctx.newPage();
    try {
      await spec.open(page);
      const pending = page.waitForEvent('download', { timeout: config.downloadTimeoutMs });
      try {
        await spec.trigger(page);
      } catch (err) {
        pending.catch(() => undefined);
        throw err;
      }
      const download = await pending;
      const failure = await download.failure();
      if (failure) throw new RetryableError(`Browser download failed: ${failure}`);
      const stream = await download.createReadStream();
      const result = await saveValidated(stream, {
        tmpDir: this.deps.tmpDir,
        maxBytes: config.maxFileSizeBytes,
      });
      return { ...result, suggestedName: download.suggestedFilename(), finalUrl: download.url() };
    } catch (err) {
      await this.deps.onPageFailure?.(page, err).catch(() => undefined);
      throw err;
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}
