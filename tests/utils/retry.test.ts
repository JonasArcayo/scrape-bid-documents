import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  classifyHttpStatus,
  isRetryable,
  parseRetryAfter,
  withRetry,
} from '../../src/utils/retry.js';
import {
  AuthError,
  NonRetryableError,
  RetryableError,
  ZipSafetyError,
} from '../../src/core/errors.js';

describe('classifyHttpStatus', () => {
  it('retries 408/425/429/5xx', () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504, 599]) {
      expect(classifyHttpStatus(s)).toBeInstanceOf(RetryableError);
    }
  });
  it('does not retry other 4xx (incl 403/404)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 400, max: 499 }), (s) => {
        fc.pre(![408, 425, 429].includes(s));
        expect(classifyHttpStatus(s)).toBeInstanceOf(NonRetryableError);
      }),
    );
  });
  it('carries Retry-After on 429', () => {
    const e = classifyHttpStatus(429, '7');
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as RetryableError).retryAfterMs).toBe(7000);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates; ignores garbage', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe('isRetryable', () => {
  it('classifies by error type', () => {
    expect(isRetryable(new RetryableError('x'))).toBe(true);
    expect(isRetryable(new NonRetryableError('x'))).toBe(false);
    expect(isRetryable(new ZipSafetyError('x'))).toBe(false);
    expect(isRetryable(new AuthError('x'))).toBe(false);
  });
  it('treats network/timeout-like errors as retryable', () => {
    const timeout = Object.assign(new Error('Timeout 30000ms exceeded'), { name: 'TimeoutError' });
    const econn = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(isRetryable(timeout)).toBe(true);
    expect(isRetryable(econn)).toBe(true);
    expect(isRetryable(new Error('something else'))).toBe(false);
  });
});

describe('withRetry', () => {
  const fast = { retries: 3, minTimeoutMs: 1, maxTimeoutMs: 2 };
  it('retries retryable errors then succeeds', async () => {
    let n = 0;
    const out = await withRetry(async () => {
      if (++n < 3) throw new RetryableError('flaky');
      return 'ok';
    }, fast);
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });
  it('does not retry non-retryable errors', async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw new NonRetryableError('404', { status: 404 });
      }, fast),
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(n).toBe(1);
  });
  it('gives up after the configured retries', async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw new RetryableError('always');
      }, fast),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(n).toBe(4);
  });
});
