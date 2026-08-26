/**
 * Polymarket Perps -> core normalization. SPEC.md §4.4.
 *
 * The whole venue-shape boundary for this adapter. Everything above it speaks core
 * types only (CLAUDE.md: "Adapters never leak").
 */

import type { Candle, Fill, PricePoint, PriceSeries } from '@trade-replay/core';
import type { PmFill, PmInstrument } from './schemas.js';

/** SPEC §4.2 gives `"pm:1"` as the instrument key for Perps: the integer id, prefixed. */
const KEY_PREFIX = 'pm:';

export interface InstrumentNames {
  instrument: string;
  displayName: string;
}

export function instrumentKeyFor(instrument: PmInstrument): InstrumentNames {
  return {
    instrument: `${KEY_PREFIX}${instrument.instrument_id}`,
    displayName: instrument.symbol,
  };
}

/**
 * Inverse of {@link instrumentKeyFor}. Returns null for anything that is not a Perps
 * key — a Hyperliquid instrument reaching this adapter is a routing bug, not a number
 * to guess at.
 */
export function instrumentIdFor(instrument: string): number | null {
  if (!instrument.startsWith(KEY_PREFIX)) return null;
  const id = Number(instrument.slice(KEY_PREFIX.length));
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

/** Round to the instrument's own precision, so float noise never reaches the fold. */
function round(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, Math.min(15, decimals));
  return Math.round(value * factor) / factor;
}

/**
 * Map one venue trade into a core Fill. SPEC §4.4.3.
 *
 * `side` is "long"/"short", and the spec is emphatic that it does not mean open versus
 * close: "a `long` fill can be *closing* a short. Determine open vs. close from
 * `previous_size`, not from `side`." So this records only the trade's direction — buy or
 * sell — and the §5 fold works out what it did to the position. `previous_size` is kept
 * on `raw` as the oracle to assert that fold against.
 */
export function mapPerpsFill(raw: PmFill, instrument: PmInstrument): Fill {
  const { instrument: key, displayName } = instrumentKeyFor(instrument);

  return {
    id: `pm:${raw.trade_id}`,
    ts: raw.timestamp,
    instrument: key,
    displayName,
    side: raw.side === 'long' ? 'buy' : 'sell',
    price: round(raw.price, instrument.price_decimals),
    size: Math.abs(round(raw.quantity, instrument.quantity_decimals)),
    fee: raw.fee,
    ...(raw.pnl === undefined ? {} : { closedPnl: raw.pnl }),
    ...(raw.liquidation ? { liquidation: true } : {}),
    ...(raw.adl ? { adl: true } : {}),
    raw,
  };
}

/** SPEC §4.4.2 klines are `[ts, o, h, l, c, volume, trades]` tuples. */
export type PmKlineTuple = readonly [number, number, number, number, number, number, number];

export function mapKlines(
  instrument: string,
  interval: string,
  raw: readonly PmKlineTuple[],
): PriceSeries {
  const byBucket = new Map<number, Candle>();
  for (const [t, o, h, l, c, v] of raw) {
    byBucket.set(t, { t, o, h, l, c, v });
  }
  return {
    kind: 'ohlcv',
    instrument,
    interval,
    candles: [...byBucket.values()].sort((a, b) => a.t - b.t),
  };
}

/**
 * Points a forward-fill may generate.
 *
 * A 1s interval across a month is 2.6 million points. A replay never needs that many,
 * and materialising them would hang the tab before anything rendered.
 */
const MAX_FILLED_POINTS = 50_000;

/**
 * Expand a sparse mark series into an even one. SPEC §4.4.2.
 *
 * "Only buckets containing at least one mark update are returned, so the series is
 * sparse: forward-fill before rendering." A gap means the mark did not move, so the
 * previous value is carried forward — interpolating would invent price action.
 */
export function forwardFill(
  raw: readonly (readonly [number, number])[],
  intervalMs: number,
): PricePoint[] {
  if (raw.length === 0) return [];

  const sorted = [...raw].sort((a, b) => a[0] - b[0]);
  const step = Math.max(1, intervalMs);
  const out: PricePoint[] = [];

  for (const [index, [t, p]] of sorted.entries()) {
    out.push({ t, p });

    const next = sorted[index + 1];
    if (!next) break;

    for (let cursor = t + step; cursor < next[0]; cursor += step) {
      if (out.length >= MAX_FILLED_POINTS) break;
      out.push({ t: cursor, p });
    }

    if (out.length >= MAX_FILLED_POINTS) {
      // Keep the final observation so the series still ends where the data does.
      const last = sorted[sorted.length - 1]!;
      if (out[out.length - 1]!.t !== last[0]) out.push({ t: last[0], p: last[1] });
      break;
    }
  }

  return out;
}

/**
 * Mark history -> a line PriceSeries.
 *
 * SPEC §4.4.2 suggests making this the default over candles: "Mark price (not last trade
 * price) is what drives margin and liquidation, so for a PnL replay this is arguably the
 * *more correct* series."
 */
export function mapMarkHistory(
  instrument: string,
  interval: string,
  raw: readonly (readonly [number, number])[],
  intervalMs: number,
): PriceSeries {
  return { kind: 'line', instrument, interval, points: forwardFill(raw, intervalMs) };
}
