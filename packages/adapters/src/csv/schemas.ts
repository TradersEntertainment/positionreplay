/**
 * Binance public market-data schemas. SPEC §4.6.
 *
 * CLAUDE.md: "Zod every external response." These shapes come from Binance's public
 * REST documentation and have **not** been checked against a live response — every
 * venue host is blocked at this environment's egress gateway. `pnpm capture:binance`
 * records real responses where the network is open, and `docs/VERIFYING-M1.md` lists
 * what that check must confirm. A contract mismatch therefore surfaces as a named
 * error here rather than as an undefined that reaches the PnL fold.
 */

import { z } from 'zod';

/**
 * One kline, as a positional array.
 *
 * Binance returns tuples, not objects, so the index *is* the field name:
 *   0 open time, 1 open, 2 high, 3 low, 4 close, 5 volume, 6 close time, …
 *
 * `.rest(z.unknown())` on purpose: Binance has appended trailing elements before, and
 * a strict tuple would reject an otherwise-fine response. The seven leading positions
 * are the contract; anything after them is ignored.
 */
export const BinanceKlineSchema = z
  .tuple([
    z.number(), // 0 open time (ms)
    z.string(), // 1 open
    z.string(), // 2 high
    z.string(), // 3 low
    z.string(), // 4 close
    z.string(), // 5 base-asset volume
    z.number(), // 6 close time (ms)
  ])
  .rest(z.unknown());

export type BinanceKline = z.infer<typeof BinanceKlineSchema>;

export const BinanceKlinesSchema = z.array(BinanceKlineSchema);

/** The subset of /api/v3/exchangeInfo needed to answer "is this symbol tradable?". */
export const BinanceSymbolSchema = z.object({
  symbol: z.string(),
  status: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
});

export const BinanceExchangeInfoSchema = z.object({
  symbols: z.array(BinanceSymbolSchema),
});

export type BinanceSymbolInfo = z.infer<typeof BinanceSymbolSchema>;

/** Binance's error envelope: `{"code":-1121,"msg":"Invalid symbol."}`. */
export const BinanceErrorSchema = z.object({
  code: z.number(),
  msg: z.string(),
});

/** -1121 is "Invalid symbol", which is a user-facing answer rather than a failure. */
export const BINANCE_INVALID_SYMBOL = -1121;

export class BinanceContractError extends Error {
  constructor(
    readonly context: string,
    readonly issues: readonly { path: string; message: string }[],
    readonly received: string,
  ) {
    super(
      `Binance response for ${context} did not match the expected shape:\n` +
        issues.map((i) => `  ${i.path || '(root)'}: ${i.message}`).join('\n') +
        `\n  Received: ${received}`,
    );
    this.name = 'BinanceContractError';
  }
}

/**
 * Parse or throw a diagnostic naming what actually arrived.
 *
 * The received keys are included because the useful question when a contract breaks
 * is "what did they rename it to", and a bare "expected string" never answers it.
 */
export function parseBinance<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const received = Array.isArray(value)
    ? `array of ${value.length}, first element ${JSON.stringify(value[0]).slice(0, 200)}`
    : value && typeof value === 'object'
      ? `object with keys [${Object.keys(value).join(', ')}]`
      : JSON.stringify(value).slice(0, 200);

  throw new BinanceContractError(
    context,
    result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    received,
  );
}
