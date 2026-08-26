/**
 * Retry wrapper for every adapter call. SPEC.md §10.
 *
 * "Exponential backoff on 429/5xx, respect `Retry-After`, max 4 attempts."
 */

import { HttpError, VenueUnreachableError } from './types.js';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Adds ±20% randomness so parallel callers do not resynchronize. */
  jitter?: boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Only two things are worth trying again.
 *
 * 429/408/5xx are the venue's problem and may pass, and a transport failure (socket
 * hangup, DNS) may too. Everything else is terminal.
 *
 * This used to retry any Error lacking a `status`, on the theory that such errors were
 * network-level. They are not: a Zod contract mismatch, a 413 "history too old" and an
 * unusable instrument key all reach here that way, and each was being requested four
 * times before surfacing — four times the load on a venue that has already told us the
 * answer will not change.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 429 || error.status === 408 || error.status >= 500;
  }
  return error instanceof VenueUnreachableError;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const jitter = options.jitter ?? true;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryable(error)) throw error;

      // When the venue told us how long to wait, that number beats any guess we make.
      const serverHint = error instanceof HttpError ? error.retryAfterMs : undefined;
      let delay = serverHint ?? Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      if (serverHint === undefined && jitter) {
        delay = Math.round(delay * (0.8 + random() * 0.4));
      }

      options.onRetry?.(attempt, delay, error);
      await sleep(delay);
    }
  }

  throw lastError;
}
