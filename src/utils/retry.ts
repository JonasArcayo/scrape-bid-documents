import pRetry from 'p-retry';
import { NonRetryableError, RetryableError, ScraperError } from '../core/errors.js';

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNABORTED',
  'ECONNREFUSED',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);
const NETWORK_MESSAGE =
  /(socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|net::ERR_(CONNECTION|TIMED_OUT|NETWORK|INTERNET|EMPTY_RESPONSE|HTTP2)|timeout .*exceeded)/i;

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(
  value: string | undefined | null,
  now = Date.now(),
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const when = Date.parse(v);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - now);
}

/**
 * Classify an HTTP status. Retryable: 408, 425, 429, 5xx. Everything else
 * (including 403/404) is permanent.
 */
export function classifyHttpStatus(
  status: number,
  retryAfterHeader?: string | null,
  context = '',
): RetryableError | NonRetryableError {
  const msg = `HTTP ${status}${context ? ` for ${context}` : ''}`;
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new RetryableError(msg, { status, retryAfterMs: parseRetryAfter(retryAfterHeader) });
  }
  return new NonRetryableError(msg, { status });
}

function codeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

/** Whether an error is a transient failure worth retrying. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  if (err instanceof ScraperError) return false;
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError') return true;
  const code = codeOf(err) ?? codeOf(err.cause);
  if (code && NETWORK_CODES.has(code)) return true;
  return NETWORK_MESSAGE.test(err.message);
}

export interface RetryOptions {
  retries?: number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
  factor?: number;
  /** Upper bound on honoring a server Retry-After. */
  maxRetryAfterMs?: number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; error: Error; delayMs: number }) => void;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/** Run `fn` with exponential backoff + jitter, retrying only transient errors. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  return pRetry(fn, {
    retries: opts.retries ?? 3,
    minTimeout: opts.minTimeoutMs ?? 1000,
    maxTimeout: opts.maxTimeoutMs ?? 30_000,
    factor: opts.factor ?? 2,
    randomize: true,
    signal: opts.signal,
    shouldRetry: ({ error }) => isRetryable(error),
    onFailedAttempt: async ({ error, attemptNumber, retryDelay }) => {
      let extra = 0;
      if (error instanceof RetryableError && error.retryAfterMs !== undefined) {
        const wanted = Math.min(error.retryAfterMs, opts.maxRetryAfterMs ?? 120_000);
        extra = Math.max(0, wanted - retryDelay);
      }
      opts.onRetry?.({ attempt: attemptNumber, error, delayMs: retryDelay + extra });
      await sleep(extra, opts.signal);
    },
  });
}
