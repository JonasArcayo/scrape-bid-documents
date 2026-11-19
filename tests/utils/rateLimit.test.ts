import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createRateLimiter } from '../../src/utils/rateLimit.js';

describe('createRateLimiter', () => {
  it('spaces calls by a jittered delay within [min, max], serialized', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 2, max: 8 }),
        async (a, b, calls) => {
          const [min, max] = a <= b ? [a, b] : [b, a];
          let now = 0;
          const starts: number[] = [];
          const limit = createRateLimiter({
            minDelayMs: min,
            maxDelayMs: max,
            now: () => now,
            sleep: async (ms) => {
              now += ms;
            },
            random: () => Math.random(),
          });
          await Promise.all(
            Array.from({ length: calls }, () => limit().then(() => starts.push(now))),
          );
          expect(starts.length).toBe(calls);
          for (let i = 1; i < starts.length; i++) {
            const gap = (starts[i] as number) - (starts[i - 1] as number);
            expect(gap).toBeGreaterThanOrEqual(min);
            expect(gap).toBeLessThanOrEqual(max);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
