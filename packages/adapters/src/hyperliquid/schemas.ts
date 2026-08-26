/**
 * Zod schemas for every Hyperliquid response. SPEC.md §4.3 and §14.
 *
 * "Every external response goes through a Zod schema. Venue APIs change without
 * warning and a silent `undefined` in the PnL fold produces a plausible-looking
 * wrong number, which is worse than a crash."
 *
 * Strictness is deliberate and split: fields that feed the PnL fold or the chart are
 * REQUIRED, so a contract change crashes loudly; descriptive metadata we never
 * compute on is optional, so a harmless addition upstream does not take us down.
 */

import { z } from 'zod';

/** Hyperliquid returns prices and sizes as decimal strings; some fields flip to numbers. */
const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v : Number(v)))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' });

/**
 * SPEC §4.3 fill fields: coin, px, sz, side ("A"=sell/ask, "B"=buy/bid), time,
 * startPosition, dir, closedPnl, fee, feeToken, hash, oid, tid, crossed.
 */
export const HlFillSchema = z.object({
  coin: z.string().min(1),
  px: numeric,
  sz: numeric,
  /** Strict on purpose: this single character decides buy vs sell. */
  side: z.enum(['A', 'B']),
  time: z.number().int(),
  tid: z.number(),
  fee: numeric,
  startPosition: numeric.optional(),
  dir: z.string().optional(),
  closedPnl: numeric.optional(),
  feeToken: z.string().optional(),
  hash: z.string().optional(),
  oid: z.number().optional(),
  crossed: z.boolean().optional(),
});

export type HlFill = z.infer<typeof HlFillSchema>;

export const HlFillsSchema = z.array(HlFillSchema);

/**
 * `candleSnapshot` bars.
 *
 * SPEC §4.3 documents the request but not the response shape; this is the published
 * Hyperliquid shape (t = bucket open, T = bucket close, s = symbol, i = interval,
 * n = trade count). Anything we actually draw is required so a mismatch surfaces at
 * the boundary rather than as a blank chart.
 */
export const HlCandleSchema = z.object({
  t: z.number().int(),
  o: numeric,
  h: numeric,
  l: numeric,
  c: numeric,
  v: numeric,
  T: z.number().int().optional(),
  s: z.string().optional(),
  i: z.string().optional(),
  n: z.number().optional(),
});

export type HlCandle = z.infer<typeof HlCandleSchema>;

export const HlCandlesSchema = z.array(HlCandleSchema);

/**
 * `userFunding` entries.
 *
 * `delta.usdc` is signed from the trader's point of view: negative = the trader paid.
 * That matches FundingEvent.amount in core (positive = received), so it maps across
 * with no sign flip — see the note in core/types.ts.
 */
export const HlFundingSchema = z.object({
  time: z.number().int(),
  hash: z.string().optional(),
  delta: z.object({
    type: z.string(),
    coin: z.string().min(1),
    usdc: numeric,
    szi: numeric.optional(),
    fundingRate: numeric.optional(),
  }),
});

export type HlFundingEntry = z.infer<typeof HlFundingSchema>;

export const HlFundingListSchema = z.array(HlFundingSchema);

/**
 * Raised when a venue response does not match the schema.
 *
 * The message names the offending paths AND the keys actually received, because
 * CLAUDE.md forbids guessing at a venue's API contract — when an assumption here is
 * wrong, the failure has to say so precisely rather than mysteriously.
 */
export class VenueContractError extends Error {
  constructor(
    readonly context: string,
    readonly issues: readonly { path: string; message: string }[],
    readonly received: unknown,
  ) {
    const sample = Array.isArray(received) ? received[0] : received;
    const keys =
      sample && typeof sample === 'object' ? Object.keys(sample as object).join(', ') : typeof sample;
    super(
      `Hyperliquid response did not match the expected shape for ${context}.\n` +
        issues.map((i) => `  - ${i.path || '(root)'}: ${i.message}`).join('\n') +
        `\n  keys received: ${keys}\n` +
        `  This usually means the venue changed its contract. Verify against the live ` +
        `endpoint before adjusting the schema (CLAUDE.md).`,
    );
    this.name = 'VenueContractError';
  }
}

/** Parse a venue payload, converting Zod failures into a diagnostic error. */
export function parseVenue<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new VenueContractError(
    context,
    result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    data,
  );
}
