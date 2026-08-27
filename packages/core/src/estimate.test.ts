import { describe, expect, it } from 'vitest';
import type { Candle } from './types.js';
import { estimateRows } from './estimate.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

/** `[low, high]` per bar, one bar an hour. Close sits in the middle unless given. */
function bars(spec: [low: number, high: number, close?: number][]): Candle[] {
  return spec.map(([l, h, c], i) => ({
    t: T0 + i * HOUR,
    o: l,
    h,
    l,
    c: c ?? (l + h) / 2,
    v: 1,
  }));
}

/** A market that rises to 100 and comes back down, touching 60 twice. */
const CANDLES = bars([
  [50, 60], // 0
  [58, 70], // 1
  [68, 80], // 2
  [78, 95], // 3
  [90, 100], // 4
  [80, 92], // 5
  [55, 65], // 6  <- 60 again, later
  [40, 52], // 7
]);

const at = (i: number): number => T0 + i * HOUR;

describe('estimateRows — a date with no price', () => {
  it('takes the close of the bar the date falls in', () => {
    const out = estimateRows([{ ts: at(2) + 900_000, price: null }], CANDLES);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows[0]!.price).toBe(74);
    expect(out.rows[0]!.ts).toBe(at(2) + 900_000);
    expect(out.rows[0]!.estimated).toEqual(['price']);
  });

  it('reports a date outside the window rather than clamping it', () => {
    // Clamping to the first or last bar would silently price a trade from a month the
    // window never covered.
    const out = estimateRows([{ ts: T0 - 5 * HOUR, price: null }], CANDLES);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rowIndex).toBe(0);
    expect(out.reason).toMatch(/outside/i);
  });
});

describe('estimateRows — a price with no date', () => {
  it('takes the most recent bar that touched the price', () => {
    // 60 is touched at bar 0 and again at bar 6. The answer is the later one.
    const out = estimateRows([{ ts: null, price: 60 }], CANDLES);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows[0]!.ts).toBe(at(6));
    expect(out.rows[0]!.estimated).toEqual(['ts']);
  });

  it('counts a wick, not just the close', () => {
    // 100 is the high of bar 4 and no bar closes there. "The market was at 100" is true
    // of a wick, which is what someone means when they say they sold at 100.
    const out = estimateRows([{ ts: null, price: 100 }], CANDLES);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows[0]!.ts).toBe(at(4));
  });

  it('says a price was never reached rather than sliding to the nearest', () => {
    // 500 is nowhere near this market. Filling in the closest bar would produce a
    // confident number for a trade that could not have happened.
    const out = estimateRows([{ ts: null, price: 500 }], CANDLES);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rowIndex).toBe(0);
    expect(out.reason).toMatch(/never/i);
    expect(out.reason).toContain('500');
  });
});

describe('estimateRows — the chain', () => {
  it('resolves backwards so the entry lands before the exit', () => {
    // The whole reason rows are not resolved independently: 60's most recent touch is
    // bar 6, which is AFTER 100's only touch at bar 4. Resolved one at a time, this
    // position sells before it buys.
    const out = estimateRows(
      [
        { ts: null, price: 60 },
        { ts: null, price: 100 },
      ],
      CANDLES,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows[1]!.ts).toBe(at(4));
    // Bar 1's range is [58, 70], so it touches 60 too — and it is the latest bar that
    // does while still landing before bar 4.
    expect(out.rows[0]!.ts).toBe(at(1));
    expect(out.rows[0]!.ts).toBeLessThan(out.rows[1]!.ts);
  });

  it('reports the row that cannot fit before the one after it', () => {
    // 45 exists only in bar 7 ([40, 52]), which is after 100's only touch at bar 4.
    // There is no valid chain, and the message has to name which row and why.
    const out = estimateRows(
      [
        { ts: null, price: 45 },
        { ts: null, price: 100 },
      ],
      CANDLES,
    );

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rowIndex).toBe(0);
    expect(out.reason).toMatch(/before/i);
  });

  it('anchors on a typed date and resolves the rest around it', () => {
    const out = estimateRows(
      [
        { ts: null, price: 60 },
        { ts: at(3), price: null },
      ],
      CANDLES,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The typed date is untouched and marked as not estimated.
    expect(out.rows[1]!.ts).toBe(at(3));
    expect(out.rows[1]!.estimated).toEqual(['price']);
    // 60's latest touch is bar 6, but that is after the anchor — so the answer is bar 1,
    // the latest bar touching 60 that still lands before it.
    expect(out.rows[0]!.ts).toBe(at(1));
  });

  it('leaves a fully typed row exactly as it was', () => {
    const out = estimateRows([{ ts: at(2), price: 12_345 }], CANDLES);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows[0]).toEqual({ ts: at(2), price: 12_345, estimated: [] });
  });

  it('handles a three-leg chain, each before the next', () => {
    const out = estimateRows(
      [
        { ts: null, price: 55 },
        { ts: null, price: 80 },
        { ts: null, price: 90 },
      ],
      CANDLES,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const times = out.rows.map((r) => r.ts);
    expect(times[0]!).toBeLessThan(times[1]!);
    expect(times[1]!).toBeLessThan(times[2]!);
  });
});

describe('estimateRows — nothing to work with', () => {
  it('reports an empty candle set instead of resolving to nothing', () => {
    const out = estimateRows([{ ts: null, price: 60 }], []);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/no candles/i);
  });

  it('reports a row with neither a date nor a price', () => {
    // Two unknowns and one equation. Saying so beats inventing a trade.
    const out = estimateRows([{ ts: null, price: null }], CANDLES);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rowIndex).toBe(0);
    expect(out.reason).toMatch(/date or a price/i);
  });

  it('returns no rows for no rows', () => {
    const out = estimateRows([], CANDLES);
    expect(out).toEqual({ ok: true, rows: [] });
  });

  it('does not mutate what it was given', () => {
    const rows = [{ ts: null, price: 60 }];
    const before = JSON.stringify(rows);
    estimateRows(rows, CANDLES);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
