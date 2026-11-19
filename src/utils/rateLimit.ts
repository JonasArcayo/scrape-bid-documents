export interface RateLimiterOptions {
  minDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Per-site limiter: callers are serialized and each call starts a uniformly-jittered
 * delay in [minDelayMs, maxDelayMs] after the previous one started.
 */
export function createRateLimiter(opts: RateLimiterOptions): () => Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  const lo = Math.min(opts.minDelayMs, opts.maxDelayMs);
  const hi = Math.max(opts.minDelayMs, opts.maxDelayMs);
  let chain: Promise<void> = Promise.resolve();
  let nextAt = 0;
  return () => {
    const turn = chain.then(async () => {
      const wait = nextAt - now();
      if (wait > 0) await sleep(wait, opts.signal);
      nextAt = now() + Math.round(lo + random() * (hi - lo));
    });
    chain = turn.catch(() => undefined);
    return turn;
  };
}
