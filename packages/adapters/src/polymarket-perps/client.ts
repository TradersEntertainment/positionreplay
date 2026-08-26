/**
 * Polymarket Perps HTTP transport. SPEC.md §4.4.
 *
 * GET with query parameters, unlike Hyperliquid's single POST endpoint. The read paths
 * used here are all public (`security: []` in §4.4.1's table) — no key is ever sent,
 * which keeps this inside CLAUDE.md's read-only rule.
 */

import type { z } from 'zod';
import { createTokenBucket } from '../limiter.js';
import { HistoryTooOldError, HttpError, VenueUnreachableError } from '../types.js';
import type { AdapterContext, FetchLike, RateLimiter } from '../types.js';
import { withRetry } from '../withRetry.js';
import { PerpsContractError, parsePerps } from './schemas.js';

export const PM_PERPS_API_BASE = 'https://api.perpetuals.polymarket.com';

/**
 * SPEC §4.4.4: per-IP token bucket with per-endpoint weights. The exact budget is not
 * published, so this is deliberately conservative — being throttled is recoverable,
 * being IP-banned is not.
 */
export const PM_WEIGHTS = {
  capacity: 600,
  refillPerMinute: 600,
  /** §4.4.4: weight 10, dropping to 1 when served from its 2s cache. */
  positionFills: 10,
  instruments: 5,
  portfolio: 5,
  klines: 2,
  markHistory: 2,
  funding: 2,
} as const;

let sharedLimiter: RateLimiter | undefined;

function defaultLimiter(): RateLimiter {
  sharedLimiter ??= createTokenBucket({
    capacity: PM_WEIGHTS.capacity,
    refillPerMinute: PM_WEIGHTS.refillPerMinute,
  });
  return sharedLimiter;
}

/** SPEC §4.4.4: `Retry-After` carries whole seconds. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

export interface PerpsClient {
  get<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    schema: z.ZodType<T>,
    context: string,
    weight: number,
  ): Promise<T>;
}

export function createPerpsClient(
  ctx: AdapterContext = {},
  baseUrl = PM_PERPS_API_BASE,
): PerpsClient {
  const injected = ctx.fetch;
  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  const doFetch = injected ?? globalFetch;

  if (!doFetch) {
    throw new Error(
      'No fetch implementation available. Pass one via AdapterContext.fetch (this is also ' +
        'how the adapter is tested against recorded fixtures).',
    );
  }

  const limiter =
    ctx.limiter ??
    (ctx.now || ctx.sleep
      ? createTokenBucket({
          capacity: PM_WEIGHTS.capacity,
          refillPerMinute: PM_WEIGHTS.refillPerMinute,
          ...(ctx.now ? { now: ctx.now } : {}),
          ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
        })
      : defaultLimiter());

  return {
    async get<T>(
      path: string,
      params: Record<string, string | number | undefined>,
      schema: z.ZodType<T>,
      context: string,
      weight: number,
    ): Promise<T> {
      await limiter.take(weight);

      const query = Object.entries(params)
        .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
      const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;

      return withRetry(
        async () => {
          let response;
          try {
            response = await doFetch(url, {
              method: 'GET',
              headers: { Accept: 'application/json' },
              body: '',
            });
          } catch (error) {
            throw new VenueUnreachableError(baseUrl, error);
          }

          const text = await response.text();

          if (!response.ok) {
            // SPEC §4.4.1: 413 means the cycle predates the discovery bound. Retrying
            // or reporting it as a generic failure sends people looking for a bug.
            if (response.status === 413) {
              throw new HistoryTooOldError(`${url} returned 413.`);
            }
            throw new HttpError(
              response.status,
              url,
              // §4.4.4: the body's `error` field distinguishes ip_rate_limited from
              // action_rate_limited, which is the difference between waiting and
              // backing off entirely.
              text,
              parseRetryAfter(response.headers.get('retry-after')),
            );
          }

          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            throw new PerpsContractError(
              context,
              [{ path: '', message: 'response body was not valid JSON' }],
              text.slice(0, 500),
            );
          }

          return parsePerps(schema, json, context);
        },
        {
          ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
        },
      );
    },
  };
}
