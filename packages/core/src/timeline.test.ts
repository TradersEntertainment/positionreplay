import { describe, expect, it } from 'vitest';
import { buildEpisodes } from './episodes.js';
import { buildFrames, pickInterval, seriesRangeFor } from './timeline.js';
import type { IntervalSpec } from './timeline.js';
import { fill, funding } from './test-helpers.js';
import type { Candle, PriceSeries } from './types.js';

const HL = { venue: 'hyperliquid' } as const;
const MIN = 60_000;

/**
 * A venue-shaped interval table, defined locally.
 *
 * Core must not import one from an adapter, and it no longer ships one of its own —
 * `pickInterval` takes the table as an argument so this package never learns which
 * venues exist.
 */
const INTERVALS: readonly IntervalSpec[] = [
  { name: '1m', ms: 60_000 },
  { name: '3m', ms: 3 * 60_000 },
  { name: '5m', ms: 5 * 60_000 },
  { name: '15m', ms: 15 * 60_000 },
  { name: '30m', ms: 30 * 60_000 },
  { name: '1h', ms: 60 * 60_000 },
  { name: '2h', ms: 2 * 60 * 60_000 },
  { name: '4h', ms: 4 * 60 * 60_000 },
  { name: '8h', ms: 8 * 60 * 60_000 },
  { name: '12h', ms: 12 * 60 * 60_000 },
  { name: '1d', ms: 24 * 60 * 60_000 },
  { name: '3d', ms: 3 * 24 * 60 * 60_000 },
  { name: '1w', ms: 7 * 24 * 60 * 60_000 },
  { name: '1M', ms: 30 * 24 * 60 * 60_000 },
];
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Build an ohlcv series of `count` bars of `stepMs`, closing at `close(i)`. */
function ohlcv(from: number, stepMs: number, count: number, close: (i: number) => number): PriceSeries {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const c = close(i);
    candles.push({ t: from + i * stepMs, o: c, h: c + 1, l: c - 1, c, v: 10 });
  }
  return { kind: 'ohlcv', instrument: 'HYPE-PERP', interval: '1m', candles };
}

describe('pickInterval (SPEC §6.1)', () => {
  it('picks an interval landing near the target frame count', () => {
    // 200 hours: 1h gives ~230 bars over the padded window — closest to 200.
    const picked = pickInterval(200 * HOUR, INTERVALS);
    expect(picked.interval).toBe('1h');
  });

  it('falls back to coarse intervals for a months-long position (§11 case 5)', () => {
    const picked = pickInterval(120 * DAY, INTERVALS);
    // 1m over 120 days is 172,800 bars — far past the 5000 cap.
    expect(['4h', '8h', '12h', '1d']).toContain(picked.interval);
    expect(picked.count).toBeLessThanOrEqual(5000);
  });

  it('never exceeds the venue 5000-candle cap', () => {
    for (const duration of [MIN, HOUR, DAY, 30 * DAY, 365 * DAY]) {
      const picked = pickInterval(duration, INTERVALS);
      expect(picked.count, `duration ${duration}`).toBeLessThanOrEqual(5000);
    }
  });

  it('warns and uses the finest interval for a 90-second position (§11 case 6)', () => {
    const picked = pickInterval(90_000, INTERVALS);
    expect(picked.interval).toBe('1m');
    // 90s cannot produce 40 bars at 1m — this must be surfaced, not silently rendered.
    expect(picked.belowMinimum).toBe(true);
    expect(picked.warning).toMatch(/sub-minute|resolution/i);
  });

  it('does not warn when the interval comfortably clears the minimum', () => {
    const picked = pickInterval(200 * HOUR, INTERVALS);
    expect(picked.belowMinimum).toBe(false);
    expect(picked.warning).toBeUndefined();
  });

  it('honours an explicit override while still reporting the resulting count', () => {
    const picked = pickInterval(200 * HOUR, INTERVALS, { override: '1d' });
    expect(picked.interval).toBe('1d');
    expect(picked.count).toBeGreaterThan(0);
  });
});

describe('seriesRangeFor (SPEC §6.1 padding)', () => {
  it('pads 15% before the open and 5% after the close', () => {
    const range = seriesRangeFor({ openedAt: 1_000_000, closedAt: 1_100_000 }, 2_000_000);
    expect(range.from).toBe(1_000_000 - 15_000);
    expect(range.to).toBe(1_100_000 + 5_000);
  });

  it('uses now as the end for a still-open episode (§11 case 1)', () => {
    const now = 5_000_000;
    const range = seriesRangeFor({ openedAt: 4_000_000, closedAt: null }, now);
    expect(range.to).toBeGreaterThanOrEqual(now);
  });
});

describe('buildFrames (SPEC §6.2)', () => {
  const episode = buildEpisodes(
    [
      fill({ id: 'open', ts: 10 * MIN, side: 'buy', price: 100, size: 10, fee: 1 }),
      fill({ id: 'close', ts: 30 * MIN, side: 'sell', price: 120, size: 10, fee: 2 }),
    ],
    HL,
  )[0]!;

  const series = ohlcv(0, MIN, 40, (i) => 100 + i);

  it('emits one frame per bar, in order', () => {
    const frames = buildFrames(episode, series);
    expect(frames).toHaveLength(40);
    expect(frames.map((f) => f.t)).toEqual(series.kind === 'ohlcv' ? series.candles.map((c) => c.t) : []);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.t).toBeGreaterThan(frames[i - 1]!.t);
      expect(frames[i]!.visibleUpTo).toBe(i);
    }
    expect(frames.at(-1)!.isFinal).toBe(true);
    expect(frames[0]!.isFinal).toBe(false);
  });

  it('holds a flat position before the first fill', () => {
    const frames = buildFrames(episode, series);
    const before = frames[5]!;
    expect(before.netSize).toBe(0);
    expect(before.unrealized).toBe(0);
    expect(before.realized).toBe(0);
    expect(before.totalPnl).toBe(0);
    expect(before.newFills).toHaveLength(0);
  });

  it('opens the position on the bar containing the opening fill', () => {
    const frames = buildFrames(episode, series);
    const atOpen = frames[10]!;
    expect(atOpen.netSize).toBeCloseTo(10, 12);
    expect(atOpen.avgEntry).toBeCloseTo(100, 12);
    expect(atOpen.newFills.map((f) => f.id)).toEqual(['open']);
    expect(atOpen.fees).toBeCloseTo(1, 12);
  });

  it('tracks unrealized against the mark while the position is open', () => {
    const frames = buildFrames(episode, series);
    const mid = frames[20]!;
    // bar 20 closes at 120; entry 100; 10 long.
    expect(mid.markPrice).toBeCloseTo(120, 12);
    expect(mid.unrealized).toBeCloseTo(200, 12);
    expect(mid.holdingValue).toBeCloseTo(1_200, 12);
  });

  it('final frame PnL reconciles with the episode totals', () => {
    const frames = buildFrames(episode, series);
    const last = frames.at(-1)!;
    expect(last.netSize).toBe(0);
    expect(last.unrealized).toBe(0);
    expect(last.realized).toBeCloseTo(episode.realizedPnl, 9);
    expect(last.fees).toBeCloseTo(episode.totalFees, 9);
    expect(last.totalPnl).toBeCloseTo(episode.realizedPnl - episode.totalFees, 9);
  });

  it('inverts unrealized for a short position', () => {
    const shortEpisode = buildEpisodes(
      [
        fill({ ts: 10 * MIN, side: 'sell', price: 100, size: 10 }),
        fill({ ts: 30 * MIN, side: 'buy', price: 90, size: 10 }),
      ],
      HL,
    )[0]!;
    // Falling market: a short gains.
    const falling = ohlcv(0, MIN, 40, (i) => 100 - i * 0.5);
    const frames = buildFrames(shortEpisode, falling);
    const mid = frames[20]!;
    expect(mid.netSize).toBeCloseTo(-10, 12);
    expect(mid.markPrice).toBeCloseTo(90, 12);
    expect(mid.unrealized).toBeCloseTo(100, 12);
    expect(mid.holdingValue).toBeCloseTo(900, 12);
  });

  it('buckets two fills landing in the same bar into one frame (§11 case 4)', () => {
    const busy = buildEpisodes(
      [
        fill({ id: 'a', ts: 10 * MIN + 1_000, side: 'buy', price: 100, size: 5 }),
        fill({ id: 'b', ts: 10 * MIN + 2_000, side: 'buy', price: 110, size: 5 }),
        fill({ id: 'c', ts: 30 * MIN, side: 'sell', price: 130, size: 10 }),
      ],
      HL,
    )[0]!;
    const frames = buildFrames(busy, series);
    expect(frames[10]!.newFills.map((f) => f.id)).toEqual(['a', 'b']);
    expect(frames[10]!.avgEntry).toBeCloseTo(105, 12);
  });

  it('accrues funding with its sign and folds it into totalPnl', () => {
    const withFunding = buildEpisodes(
      [
        fill({ ts: 10 * MIN, side: 'buy', price: 100, size: 10 }),
        fill({ ts: 30 * MIN, side: 'sell', price: 120, size: 10 }),
      ],
      { ...HL, funding: [funding({ ts: 20 * MIN, amount: -25 })] },
    )[0]!;

    const frames = buildFrames(withFunding, series);
    expect(frames[15]!.funding).toBe(0);
    expect(frames[25]!.funding).toBeCloseTo(-25, 12);
    // Paid funding must reduce total PnL.
    expect(frames.at(-1)!.totalPnl).toBeCloseTo(200 - 25, 9);
  });

  it('never lets a fill go unaccounted for, even past the end of the series', () => {
    const shortSeries = ohlcv(0, MIN, 12, (i) => 100 + i);
    const frames = buildFrames(episode, shortSeries);
    // The closing fill at 30m is beyond the last bar; the final frame must still
    // reflect the episode's true end state rather than a stale open position.
    expect(frames.at(-1)!.isFinal).toBe(true);
    expect(frames.at(-1)!.realized).toBeCloseTo(episode.realizedPnl, 9);
    expect(frames.at(-1)!.netSize).toBe(0);
  });

  it('supports a line series as well as candles', () => {
    const line: PriceSeries = {
      kind: 'line',
      instrument: 'HYPE-PERP',
      interval: '1s',
      points: Array.from({ length: 40 }, (_, i) => ({ t: i * MIN, p: 100 + i })),
    };
    const frames = buildFrames(episode, line);
    expect(frames).toHaveLength(40);
    expect(frames[20]!.markPrice).toBeCloseTo(120, 12);
  });

  it('returns no frames for an empty series rather than throwing', () => {
    const empty: PriceSeries = { kind: 'ohlcv', instrument: 'HYPE-PERP', interval: '1m', candles: [] };
    expect(buildFrames(episode, empty)).toEqual([]);
  });
});
