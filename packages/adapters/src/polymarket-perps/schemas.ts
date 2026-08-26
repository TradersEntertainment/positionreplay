/**
 * Zod schemas for every Polymarket Perps response. SPEC.md §4.4 and §14.
 *
 * Same discipline as the Hyperliquid schemas: fields that feed the PnL fold or the
 * chart are REQUIRED so a contract change crashes loudly; descriptive metadata is
 * optional so a harmless addition upstream does not take us down.
 *
 * Two shapes differ from Hyperliquid and are easy to get wrong:
 *  - klines and mark-history return TUPLE ARRAYS, not objects (§4.4.2);
 *  - prices and quantities are decimal strings, to be read against the instrument's
 *    own price_decimals / quantity_decimals (§4.4.3).
 */

import { z } from 'zod';

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v : Number(v)))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' });

const integer = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v : Number(v)))
  .refine((n) => Number.isSafeInteger(n), { message: 'expected an integer' });

/**
 * SPEC §4.4.2 `/v1/info/instruments`.
 *
 * "Fetch once at boot and cache a `symbol ↔ instrument_id` map. Every other Perps call
 * needs the integer id."
 */
export const PmInstrumentSchema = z.object({
  instrument_id: integer,
  symbol: z.string().min(1),
  quantity_decimals: integer,
  price_decimals: integer,
  category: z.string().optional(),
  base_asset: z.string().optional(),
  quote_asset: z.string().optional(),
  funding_interval: integer.optional(),
  max_leverage: numeric.optional(),
  isolated_only: z.boolean().optional(),
});

export type PmInstrument = z.infer<typeof PmInstrumentSchema>;

/** The endpoint has been seen wrapped in `{ data }` and bare; accept both. */
export const PmInstrumentsSchema = z.union([
  z.array(PmInstrumentSchema),
  z.object({ data: z.array(PmInstrumentSchema) }).transform((r) => r.data),
]);

/**
 * SPEC §4.4.2 klines: `{ data: [[ts, o, h, l, c, volume, trades], ...], more: bool }`.
 * Max 1000 per request; `more` drives continuation.
 */
export const PmKlinesSchema = z.object({
  data: z.array(z.tuple([integer, numeric, numeric, numeric, numeric, numeric, numeric])),
  more: z.boolean().optional(),
});

export type PmKlines = z.infer<typeof PmKlinesSchema>;

/**
 * SPEC §4.4.2 mark-history: `{ data: [[bucket_open_ms, last_mark_price], ...], more }`.
 *
 * "Only buckets containing at least one mark update are returned, so the series is
 * sparse: forward-fill before rendering."
 */
export const PmMarkHistorySchema = z.object({
  data: z.array(z.tuple([integer, numeric])),
  more: z.boolean().optional(),
});

export type PmMarkHistory = z.infer<typeof PmMarkHistorySchema>;

/**
 * SPEC §4.4.3 `AccountTradeData`.
 *
 * `previous_size` and `previous_entry_price` are required on purpose: they are the
 * oracle the §5 reconstruction is asserted against, and a response missing them means
 * that check is silently not happening.
 */
export const PmFillSchema = z.object({
  trade_id: z.union([z.string(), z.number()]).transform(String),
  instrument_id: integer,
  /** "long" | "short" — NOT buy/sell, and NOT open/close. See §4.4.3. */
  side: z.enum(['long', 'short']),
  price: numeric,
  quantity: numeric,
  fee: numeric,
  timestamp: integer,
  previous_size: numeric,
  previous_entry_price: numeric,
  pnl: numeric.optional(),
  taker: z.boolean().optional(),
  fee_asset: z.string().optional(),
  liquidation: z.boolean().optional(),
  adl: z.boolean().optional(),
  order_id: z.union([z.string(), z.number()]).transform(String).optional(),
  hash: z.string().optional(),
});

export type PmFill = z.infer<typeof PmFillSchema>;

export const PmFillsSchema = z.union([
  z.array(PmFillSchema),
  z.object({ data: z.array(PmFillSchema) }).transform((r) => r.data),
]);

/**
 * SPEC §4.4.2 `/v1/info/public-portfolio`: "Equity + **open** positions only".
 *
 * In option A this is the entry point: it names which instruments the account has open,
 * and therefore which cycles `position-fills` can still serve.
 */
export const PmPositionSchema = z.object({
  instrument_id: integer,
  size: numeric,
  entry_price: numeric.optional(),
});

export const PmPortfolioSchema = z.object({
  positions: z.array(PmPositionSchema).default([]),
  equity: numeric.optional(),
});

export type PmPortfolio = z.infer<typeof PmPortfolioSchema>;

/**
 * SPEC §4.4.2 funding: the RATE history, max 100 per request.
 *
 * Not the account's paid amount — that is authenticated-only, which is why
 * `episode.totalFunding` is unavailable rather than zero for this venue.
 */
export const PmFundingSchema = z.object({
  data: z.array(z.tuple([integer, numeric])),
  more: z.boolean().optional(),
});

/**
 * Raised when a Perps response does not match the schema.
 *
 * Names the offending paths AND the keys actually received: CLAUDE.md forbids guessing
 * at a venue's contract, so when an assumption here is wrong the failure has to say so
 * precisely. None of these shapes has been checked against a live response yet —
 * see docs/VERIFYING-M1.md.
 */
export class PerpsContractError extends Error {
  constructor(
    readonly context: string,
    readonly issues: readonly { path: string; message: string }[],
    readonly received: unknown,
  ) {
    const sample = Array.isArray(received) ? received[0] : received;
    const keys =
      sample && typeof sample === 'object'
        ? Object.keys(sample as object).join(', ')
        : typeof sample;
    super(
      `Polymarket Perps response did not match the expected shape for ${context}.\n` +
        issues.map((i) => `  - ${i.path || '(root)'}: ${i.message}`).join('\n') +
        `\n  keys received: ${keys}\n` +
        `  Verify against the live endpoint before adjusting the schema (CLAUDE.md).`,
    );
    this.name = 'PerpsContractError';
  }
}

export function parsePerps<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new PerpsContractError(
    context,
    result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    data,
  );
}
