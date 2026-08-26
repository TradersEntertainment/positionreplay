/**
 * Per-venue token bucket. SPEC.md §10 and §4.3.
 *
 * SPEC §15: with a single `web` replica this in-process bucket is correct. If replica
 * count ever goes above 1 it silently becomes N times more permissive and the venue
 * starts returning 429s that look like their problem and are ours — move it to Redis
 * at the same time as the Postgres migration.
 */

import type { RateLimiter } from './types.js';

export interface TokenBucketOptions {
  /** Maximum tokens held at once. */
  capacity: number;
  /** Tokens restored per minute. */
  refillPerMinute: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createTokenBucket(options: TokenBucketOptions): RateLimiter {
  const { capacity, refillPerMinute } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const refillPerMs = refillPerMinute / 60_000;

  let tokens = capacity;
  let lastRefill = now();
  /** Serializes waiters so two callers cannot both spend the last token. */
  let queue: Promise<void> = Promise.resolve();

  const refill = (): void => {
    const t = now();
    const elapsed = t - lastRefill;
    if (elapsed <= 0) return;
    tokens = Math.min(capacity, tokens + elapsed * refillPerMs);
    lastRefill = t;
  };

  const acquire = async (weight: number): Promise<void> => {
    if (weight > capacity) {
      throw new Error(
        `Request weight ${weight} exceeds the bucket capacity ${capacity}; it can never be served.`,
      );
    }
    refill();
    if (tokens < weight) {
      const deficit = weight - tokens;
      await sleep(Math.ceil(deficit / refillPerMs));
      refill();
    }
    tokens -= weight;
  };

  return {
    take(weight: number): Promise<void> {
      const next = queue.then(() => acquire(weight));
      // Keep the chain alive even if one waiter rejects.
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

/**
 * SPEC §4.3 request weights. `userFills*` and `userFunding` cost per 20 items
 * returned; `candleSnapshot` per 60.
 */
export const HL_WEIGHTS = {
  /** IP budget is roughly 1200 weight per minute. */
  capacity: 1200,
  refillPerMinute: 1200,
  perFillPage: (items: number) => Math.max(1, Math.ceil(items / 20)),
  perCandlePage: (items: number) => Math.max(1, Math.ceil(items / 60)),
  /** Charged before a response is seen, so assume a full page. */
  optimisticFillPage: 2000 / 20,
  optimisticCandlePage: 5000 / 60,
} as const;

/**
 * A limiter that never delays.
 *
 * For tests and for one-shot scripts where a single caller owns the whole IP budget
 * and queueing would only add wall-clock time. Never use this to serve user requests.
 */
export function createUnlimitedLimiter(): RateLimiter {
  return { take: async () => undefined };
}
