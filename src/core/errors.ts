/** Base class for all scraper errors. */
export class ScraperError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A transient failure (timeout, network, 429, 5xx). Safe to retry. */
export class RetryableError extends ScraperError {
  /** Server-requested delay before the next attempt, in ms. */
  readonly retryAfterMs?: number;
  readonly status?: number;
  constructor(
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number; status?: number },
  ) {
    super(message, options);
    this.retryAfterMs = options?.retryAfterMs;
    this.status = options?.status;
  }
}

/** A permanent failure (404, 403, validation). Never retried. */
export class NonRetryableError extends ScraperError {
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.status = options?.status;
  }
}

/** Archive violated a safety limit (zip-slip, bomb, too deep). */
export class ZipSafetyError extends NonRetryableError {}

/** Session invalid: an HTML login/error page came back instead of a document. */
export class AuthError extends ScraperError {}

/** Expected page structure (selectors) vanished: the site changed. */
export class SiteChangedError extends NonRetryableError {}

/** Archive could not be parsed (truncated/corrupt). Not retryable. */
export class CorruptArchiveError extends NonRetryableError {}
