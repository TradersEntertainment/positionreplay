/**
 * Fill in the half of a manual position you did not type.
 *
 * People remember prices, not timestamps: "I bought at 86,000 and sold at 91,000". The
 * chart knows the rest, so this resolves whichever field is blank against the venue's
 * real candles.
 *
 * Pure, and over `Candle[]` rather than a fetch, so the rule is testable without a venue
 * and runs the same wherever it is called.
 *
 * The one design decision worth stating: rows are resolved **as a chain, backwards from
 * the last**, not one at a time. Resolving each row independently against "the most
 * recent time this price was touched" routinely puts the sell before the buy — in the
 * test fixture, 60's latest touch is genuinely after 100's only touch — and that is not a
 * position, it is a nonsense the §5 fold would happily reconstruct into a wrong number.
 * Going backwards, each blank date takes the latest bar touching its price *strictly
 * before* the row that follows it, so the chain is chronological by construction.
 *
 * The other one: when a price cannot be placed, this says so and points at the row that
 * could not be placed. Sliding to the nearest bar would produce a confident timestamp for
 * a trade that could not have happened, which is the fabrication CLAUDE.md's HUD rules
 * exist to prevent — the same rule, one layer earlier.
 */

import type { Candle } from './types.js';

/**
 * `YYYY-MM-DD HH:mm UTC`, for the reasons this returns.
 *
 * Minute precision and a space rather than a raw ISO string: the seconds and the `T` are
 * noise in a sentence a person reads, and this is the format the builder's own fields
 * use, so a reason and the row it is about do not disagree about how a time is written.
 */
function stamp(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export interface EstimateRow {
  /** Epoch ms, or null to be resolved from `price`. */
  ts: number | null;
  /** Or null to be resolved from `ts`. */
  price: number | null;
}

export interface ResolvedRow {
  ts: number;
  price: number;
  /** Which fields this function supplied. Empty when the row was already complete. */
  estimated: ('ts' | 'price')[];
}

export type EstimateOutcome =
  | { ok: true; rows: ResolvedRow[] }
  /**
   * `rowIndex` is into the array that was passed in. The reason deliberately does not
   * name a row: the caller filters blank rows out before calling, so its numbering and
   * this one differ, and a message saying "Row 1" about the form's row 3 is worse than
   * no number at all.
   */
  | { ok: false; rowIndex: number; reason: string };

/**
 * A bar "touches" a price when the price is inside its low–high range.
 *
 * Not when the close matches: a wick to 86,000 is the market having been at 86,000, and
 * that is what someone means when they say they filled there. Requiring the close would
 * miss the exact moments people remember — the spike and the flush.
 */
function touches(candle: Candle, price: number): boolean {
  return price >= candle.l && price <= candle.h;
}

export function estimateRows(
  rows: readonly EstimateRow[],
  candles: readonly Candle[],
): EstimateOutcome {
  if (rows.length === 0) return { ok: true, rows: [] };

  if (candles.length === 0) {
    return {
      ok: false,
      rowIndex: 0,
      reason: 'There are no candles for this market in the window, so nothing can be filled in.',
    };
  }

  // Sorted defensively: the caller supplies whatever a venue returned, and every search
  // below assumes ascending time.
  const bars = [...candles].sort((a, b) => a.t - b.t);
  const first = bars[0]!;
  const last = bars[bars.length - 1]!;

  const resolved: (ResolvedRow | undefined)[] = new Array(rows.length).fill(undefined);

  // Backwards: each blank date needs to know the row that follows it. `bound` is the
  // time the current row must land strictly before; there is none for the last row.
  let bound = Number.POSITIVE_INFINITY;

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const estimated: ('ts' | 'price')[] = [];

    let ts = row.ts;
    let price = row.price;

    if (ts === null && price === null) {
      return {
        ok: false,
        rowIndex: i,
        reason: 'this row needs a date or a price — with neither there is nothing to work from.',
      };
    }

    if (ts === null) {
      const found = latestTouchBefore(bars, price!, bound);
      if (found === null) {
        return {
          ok: false,
          rowIndex: i,
          reason:
            bound === Number.POSITIVE_INFINITY
              ? `this market was never at ${price!} in the window.`
              : `this market was never at ${price!} before ${stamp(bound)}, which is when ` +
                `the row below it lands.`,
        };
      }
      ts = found.t;
      estimated.push('ts');
    }

    if (price === null) {
      const bar = barAt(bars, ts);
      if (bar === null) {
        return {
          ok: false,
          rowIndex: i,
          reason:
            `${stamp(ts)} is outside the window this market has candles for ` +
            `(${stamp(first.t)} to ${stamp(last.t)}).`,
        };
      }
      price = bar.c;
      estimated.push('price');
    }

    resolved[i] = { ts, price, estimated };
    // A typed date is an anchor for the rows above it just as an estimated one is.
    bound = ts;
  }

  return { ok: true, rows: resolved as ResolvedRow[] };
}

/**
 * The latest bar touching `price` whose open time is strictly before `bound`.
 *
 * Linear from the end. The window is a couple of thousand bars and this runs on a button
 * press, so a scan is the right amount of machinery — and it reads as the rule it
 * implements, which a binary search over a non-monotonic predicate would not.
 */
function latestTouchBefore(
  bars: readonly Candle[],
  price: number,
  bound: number,
): Candle | null {
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i]!;
    if (bar.t >= bound) continue;
    if (touches(bar, price)) return bar;
  }
  return null;
}

/**
 * The bar containing `ts`, or null when it falls outside the window.
 *
 * Null rather than the nearest bar: clamping would price a trade against a month the
 * window never covered, and report it as though it had been looked up.
 */
function barAt(bars: readonly Candle[], ts: number): Candle | null {
  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  if (ts < first.t) return null;

  // The final bar's own length is unknown from a single candle, so it is bounded by the
  // spacing of the two before it. A replay whose last leg is minutes past the last bar
  // is normal; one a week past it is not.
  const step = bars.length > 1 ? last.t - bars[bars.length - 2]!.t : 0;
  if (ts > last.t + step) return null;

  let low = 0;
  let high = bars.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (bars[mid]!.t <= ts) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return bars[found]!;
}
