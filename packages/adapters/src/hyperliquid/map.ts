/**
 * Hyperliquid -> core normalization. SPEC.md §4.3.
 *
 * This file is the entire venue-shape boundary: everything above it speaks core
 * types only (CLAUDE.md: "Adapters never leak").
 */

import type { Candle, Fill, FillAction, FundingEvent, PriceSeries } from '@trade-replay/core';
import type { HlCandle, HlFill, HlFundingEntry } from './schemas.js';
import type { AdapterWarning } from '../types.js';

const PERP_SUFFIX = '-PERP';

/** Fees quoted in anything else cannot be summed into a USD total. SPEC §11 case 11. */
const USD_FEE_TOKENS = new Set(['USDC', 'USD']);

export interface InstrumentNames {
  instrument: string;
  displayName: string;
}

/**
 * Canonical instrument key for a Hyperliquid coin.
 *
 * SPEC §4.3: "HIP-3 markets need a dex prefix (`xyz:XYZ100`). Handle the prefix if
 * present in `coin`." The prefix is kept inside the key so the mapping stays
 * reversible — `fetchSeries` has to hand the venue back the exact coin string.
 */
export function instrumentKeyFor(coin: string): InstrumentNames {
  const separator = coin.indexOf(':');
  if (separator === -1) {
    return { instrument: `${coin}${PERP_SUFFIX}`, displayName: `${coin} PERP` };
  }
  const dex = coin.slice(0, separator);
  const symbol = coin.slice(separator + 1);
  return {
    instrument: `${coin}${PERP_SUFFIX}`,
    displayName: `${symbol} PERP (${dex})`,
  };
}

/** Inverse of {@link instrumentKeyFor}: the coin string the venue's API expects. */
export function coinForInstrument(instrument: string): string {
  return instrument.endsWith(PERP_SUFFIX)
    ? instrument.slice(0, -PERP_SUFFIX.length)
    : instrument;
}

/**
 * Map one venue fill into a core Fill.
 *
 * SPEC §4.3: side "A" = sell (ask), "B" = buy (bid). Inverting this produces a
 * perfectly plausible chart with every number wrong, so it is asserted in tests.
 */
export function mapFill(raw: HlFill, onWarning?: (warning: AdapterWarning) => void): Fill {
  const { instrument, displayName } = instrumentKeyFor(raw.coin);

  const feeToken = raw.feeToken ?? 'USDC';
  const feeIsUsd = USD_FEE_TOKENS.has(feeToken.toUpperCase());
  if (!feeIsUsd && raw.fee !== 0) {
    onWarning?.({
      kind: 'non_usd_fee',
      message:
        `Fee of ${raw.fee} ${feeToken} on ${displayName} is excluded from the PnL total — ` +
        `no FX source is available to value it in USD.`,
      detail: { feeToken, excludedFee: raw.fee, instrument, tid: raw.tid },
    });
  }

  return {
    id: `hl:${raw.tid}`,
    ts: raw.time,
    instrument,
    displayName,
    side: raw.side === 'B' ? 'buy' : 'sell',
    price: raw.px,
    size: Math.abs(raw.sz),
    fee: feeIsUsd ? raw.fee : 0,
    ...(raw.closedPnl === undefined ? {} : { closedPnl: raw.closedPnl }),
    ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    raw,
  };
}

/**
 * The actions a Hyperliquid `dir` string is consistent with.
 *
 * SPEC §4.3: "`dir` is a free lunch... Use it as a cross-check against our own
 * reconstruction, not as the source of truth — assert they agree in tests."
 *
 * `dir` cannot distinguish an opening fill from a scale-in (both read "Open Long"),
 * so this returns the set of actions the label permits. Returns null for a label we
 * do not recognise: an unknown string is not evidence of agreement OR disagreement,
 * and pretending otherwise would either fabricate a pass or raise a false alarm.
 */
export function actionForDir(dir: string | undefined): readonly FillAction[] | null {
  if (!dir) return null;
  const normalized = dir.trim().toLowerCase();

  if (normalized === 'open long' || normalized === 'open short') return ['open', 'scale_in'];
  if (normalized === 'close long' || normalized === 'close short') return ['close', 'reduce'];
  if (normalized === 'long > short' || normalized === 'short > long') return ['flip_out', 'flip_in'];

  return null;
}

/** Bars -> a core PriceSeries, sorted and deduped by open time. */
export function mapCandles(
  instrument: string,
  interval: string,
  raw: readonly HlCandle[],
): PriceSeries {
  const byTime = new Map<number, Candle>();
  for (const c of raw) {
    byTime.set(c.t, { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
  }
  const candles = [...byTime.values()].sort((a, b) => a.t - b.t);
  return { kind: 'ohlcv', instrument, interval, candles };
}

/**
 * Funding entries -> core FundingEvents.
 *
 * `delta.usdc` is already signed from the trader's point of view (negative = paid),
 * which is exactly FundingEvent.amount's convention, so there is no flip here.
 * Hyperliquid reports the account's actual charges, so these are not estimates —
 * unlike Polymarket Perps (SPEC §4.4.2).
 */
export function mapFunding(raw: readonly HlFundingEntry[]): FundingEvent[] {
  return raw.map((entry, index) => ({
    id: `hlf:${entry.hash ?? 'nohash'}:${entry.time}:${index}`,
    ts: entry.time,
    instrument: instrumentKeyFor(entry.delta.coin).instrument,
    amount: entry.delta.usdc,
    isEstimate: false,
    raw: entry,
  }));
}
