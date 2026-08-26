/**
 * Hyperliquid HTTP transport. SPEC.md §4.3 and §10.
 *
 * `POST /info`, JSON body, no auth and no API key — this venue's read path is
 * entirely public (CLAUDE.md, read-only rule: nothing here ever needs a key).
 */

import type { z } from 'zod';
import { HL_WEIGHTS, createTokenBucket } from '../limiter.js';
import { HttpError, VenueUnreachableError } from '../types.js';
import type { AdapterContext, FetchLike, RateLimiter } from '../types.js';
import { withRetry } from '../withRetry.js';
import { VenueContractError, parseVenue } from './schemas.js';

export const HL_API_BASE = 'https://api.hyperliquid.xyz';

/** Shared across calls in-process so the whole adapter honours one IP budget. */
let sharedLimiter: RateLimiter | undefined;

function defaultLimiter(): RateLimiter {
  sharedLimiter ??= createTokenBucket({
    capacity: HL_WEIGHTS.capacity,
    refillPerMinute: HL_WEIGHTS.refillPerMinute,
  });
  return sharedLimiter;
}

/** `Retry-After` is expressed in whole seconds. SPEC §4.4.4. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

export interface HlClient {
  info<T>(body: unknown, schema: z.ZodType<T>, context: string, weight: number): Promise<T>;
}

export function createHlClient(ctx: AdapterContext = {}, baseUrl = HL_API_BASE): HlClient {
  const injected = ctx.fetch;
  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  const doFetch = injected ?? globalFetch;

  if (!doFetch) {
    throw new Error(
      'No fetch implementation available. Pass one via AdapterContext.fetch (this is also ' +
        'how the adapter is tested against recorded fixtures).',
    );
  }

  // A caller that injects its own clock wants an isolated budget: sharing the
  // process-wide bucket would let one caller's virtual time stall another's real one,
  // and would leak spent tokens between independent tests.
  const limiter =
    ctx.limiter ??
    (ctx.now || ctx.sleep
      ? createTokenBucket({
          capacity: HL_WEIGHTS.capacity,
          refillPerMinute: HL_WEIGHTS.refillPerMinute,
          ...(ctx.now ? { now: ctx.now } : {}),
          ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
        })
      : defaultLimiter());
  const url = `${baseUrl}/info`;

  return {
    async info<T>(body: unknown, schema: z.ZodType<T>, context: string, weight: number): Promise<T> {
      // Charged before the response is seen, so it assumes a full page. SPEC §4.3:
      // userFills*/userFunding cost per 20 items, candleSnapshot per 60.
      await limiter.take(weight);

      return withRetry(
        async () => {
          let response;
          try {
            response = await doFetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
          } catch (error) {
            throw new VenueUnreachableError(baseUrl, error);
          }

          const text = await response.text();
          if (!response.ok) {
            throw new HttpError(
              response.status,
              url,
              text,
              parseRetryAfter(response.headers.get('retry-after')),
            );
          }

          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            throw new VenueContractError(
              context,
              [{ path: '', message: 'response body was not valid JSON' }],
              text.slice(0, 500),
            );
          }

          return parseVenue(schema, json, context);
        },
        {
          ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
        },
      );
    },
  };
}
