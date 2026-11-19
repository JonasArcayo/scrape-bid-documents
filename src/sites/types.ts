import type { BrowserContext, Page } from 'playwright';
import type { SiteConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { DocumentRef } from '../core/models.js';

/** Everything an adapter may use. Adapters must not write files or touch the manifest. */
export interface SiteContext {
  site: string;
  browserContext: BrowserContext;
  /** Open a fresh page in the site's context (shares cookies/session). Caller closes it. */
  newPage(): Promise<Page>;
  logger: Logger;
  config: SiteConfig;
  /** Await before each outbound navigation/request to stay polite (jittered). */
  rateLimit(): Promise<void>;
  /** Aborted on SIGINT: stop discovering new documents. */
  signal: AbortSignal;
  /**
   * Save a screenshot + HTML dump of `page` to data/debug/<site>/<timestamp>/.
   * Call before throwing on unexpected page state (helpers do this for SiteChangedError).
   */
  dumpDebug(page: Page, reason: string): Promise<string | undefined>;
}

/**
 * The only thing a new site implements: its navigation flow. Emit documents via
 * `discover`; the core handles downloading, validation, ZIPs, dedup and storage.
 */
export interface SiteAdapter {
  /** Unique registry name (used in CLI, storage paths and the manifest). */
  name: string;
  /** Per-site overrides: concurrency, delays, headless, blockResources, zip password... */
  config?: Partial<SiteConfig>;
  /** Perform login. Called when `isLoggedIn` is false, and again once on AuthError. */
  login?(ctx: SiteContext): Promise<void>;
  /** Cheap check that the restored session is still valid. */
  isLoggedIn?(ctx: SiteContext): Promise<boolean>;
  /** Yield documents lazily (generator) so downloads can overlap with discovery. */
  discover(ctx: SiteContext): AsyncGenerator<DocumentRef>;
}
