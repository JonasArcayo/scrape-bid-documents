import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import pino from 'pino';
import { SiteConfigSchema, type SiteConfig } from '../../src/core/config.js';
import { saveValidated, type DocumentDownloader } from '../../src/core/downloader.js';
import type { DocumentRef, DownloadResult, DownloadSpec } from '../../src/core/models.js';
import type { SiteAdapter, SiteContext } from '../../src/sites/types.js';

export const silentLogger = pino({ level: 'silent' });

export const fastConfig = (over: Partial<SiteConfig> = {}): SiteConfig =>
  SiteConfigSchema.parse({
    retries: 2,
    retryMinTimeoutMs: 1,
    retryMaxTimeoutMs: 2,
    concurrency: 3,
    ...over,
  });

export async function tmpDir(prefix = 'pipe-'): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Behavior per call: bytes to return, or an Error to throw. */
export type Behavior = (call: number, spec: DownloadSpec) => Buffer | Error;

/** Downloader that serves bytes from a function (still runs real validation). */
export class FakeDownloader implements DocumentDownloader {
  readonly calls = new Map<string, number>();
  constructor(
    private readonly tmp: string,
    private readonly behaviors: Record<string, Behavior>,
  ) {}
  total(): number {
    return [...this.calls.values()].reduce((a, b) => a + b, 0);
  }
  async download(spec: DownloadSpec): Promise<DownloadResult> {
    const url = spec.kind === 'click' ? 'click' : spec.url;
    const n = (this.calls.get(url) ?? 0) + 1;
    this.calls.set(url, n);
    const b = this.behaviors[url];
    if (!b) throw new Error(`no behavior for ${url}`);
    const out = b(n, spec);
    if (out instanceof Error) throw out;
    return saveValidated(Readable.from([out]), { tmpDir: this.tmp, maxBytes: 1e8 });
  }
}

export const pdfBytes = (tag: string): Buffer => Buffer.from(`%PDF-1.7\n${tag}`);

export const urlRef = (url: string, extra: Partial<DocumentRef> = {}): DocumentRef => ({
  sourcePageUrl: 'https://example.test/list',
  download: { kind: 'url', url },
  ...extra,
});

/** Adapter that yields the given refs; optionally throws after them. */
export function fakeAdapter(
  refs: DocumentRef[],
  opts: { login?: () => Promise<void>; throwAfter?: Error; name?: string } = {},
): SiteAdapter {
  return {
    name: opts.name ?? 'fake',
    ...(opts.login && { login: opts.login }),
    async *discover() {
      for (const r of refs) yield r;
      if (opts.throwAfter) throw opts.throwAfter;
    },
  };
}

/** A SiteContext with no real browser (the fake downloader/adapter never touch it). */
export function fakeCtx(
  config: SiteConfig,
  signal: AbortSignal = new AbortController().signal,
): SiteContext {
  const partial: Pick<
    SiteContext,
    'site' | 'logger' | 'config' | 'rateLimit' | 'signal' | 'dumpDebug'
  > = {
    site: 'fake',
    logger: silentLogger,
    config,
    rateLimit: async () => undefined,
    signal,
    dumpDebug: async () => undefined,
  };
  return partial as SiteContext;
}
