import { describe, expect, it } from 'vitest';
import type { Frame } from '@trade-replay/core';
import { computeEnergyTrack, flashStrength, meterCells } from './effects.js';

function framesOf(pnls: number[], marks?: number[]): Frame[] {
  return pnls.map((totalPnl, i) => ({
    t: i * 60_000,
    visibleUpTo: i,
    markPrice: marks?.[i] ?? 100,
    netSize: 1,
    avgEntry: 100,
    realized: 0,
    unrealized: totalPnl,
    fees: 0,
    funding: 0,
    totalPnl,
    holdingValue: 100,
    bought: 100,
    sold: 0,
    newFills: [],
    isFinal: i === pnls.length - 1,
  }));
}

describe('computeEnergyTrack', () => {
  it('returns nothing for an empty replay', () => {
    expect(computeEnergyTrack([])).toEqual([]);
  });

  it('reads a rise as positive momentum and a fall as negative', () => {
    const track = computeEnergyTrack(framesOf([0, 10, 20, 30, 20, 10, 0]), 2);
    expect(track[3]?.momentum).toBeGreaterThan(0);
    expect(track[6]?.momentum).toBeLessThan(0);
  });

  it('normalises against the replay’s own largest move, not a dollar amount', () => {
    // The same shape at two scales must produce the same effects, or a small position
    // never reacts and a large one is permanently maxed out.
    const small = computeEnergyTrack(framesOf([0, 5, 10, 5, 0]), 2);
    const large = computeEnergyTrack(framesOf([0, 5000, 10_000, 5000, 0]), 2);
    expect(small.map((e) => e.momentum)).toEqual(large.map((e) => e.momentum));
  });

  it('keeps momentum inside -1..1', () => {
    const track = computeEnergyTrack(framesOf([0, 1, -900, 900, 0]), 2);
    for (const e of track) {
      expect(e.momentum).toBeGreaterThanOrEqual(-1);
      expect(e.momentum).toBeLessThanOrEqual(1);
    }
  });

  it('marks a new high only on the frame that sets it', () => {
    const track = computeEnergyTrack(framesOf([0, 10, 10, 20]), 2);
    expect(track.map((e) => e.newHigh)).toEqual([false, true, false, true]);
  });

  it('marks a new low the same way', () => {
    const track = computeEnergyTrack(framesOf([0, -10, -10, -20]), 2);
    expect(track.map((e) => e.newLow)).toEqual([false, true, false, true]);
  });

  it('never flags the first frame as an extreme — it has nothing to beat', () => {
    const first = computeEnergyTrack(framesOf([50, 60]), 2)[0]!;
    expect(first.newHigh).toBe(false);
    expect(first.newLow).toBe(false);
  });

  it('places level between the worst and best seen so far', () => {
    const track = computeEnergyTrack(framesOf([0, -10, 10]), 2);
    expect(track[2]?.level).toBe(1);
    expect(track[1]?.level).toBe(0);
  });

  it('sits a flat replay at mid level with no momentum', () => {
    // Dividing by a zero span would be NaN, and NaN reaches a colour and paints nothing.
    const track = computeEnergyTrack(framesOf([7, 7, 7, 7]), 2);
    for (const e of track) {
      expect(e.momentum).toBe(0);
      expect(e.level).toBe(0.5);
      expect(Number.isFinite(e.level)).toBe(true);
    }
  });

  it('counts frames since the last extreme, so a flash can decay', () => {
    const track = computeEnergyTrack(framesOf([0, 10, 10, 10, 10]), 2);
    expect(track[1]?.sinceExtreme).toBe(0);
    expect(track[4]?.sinceExtreme).toBe(3);
  });

  it('produces one entry per frame', () => {
    expect(computeEnergyTrack(framesOf([1, 2, 3, 4, 5]))).toHaveLength(5);
  });
});

describe('computeEnergyTrack — barMove', () => {
  /**
   * Flat PnL for exactly as many frames as there are marks.
   *
   * A shorter mark array does not mean "and then nothing happened" — the frames past it
   * fall back to the default price, which is itself a candle, and usually the biggest
   * one in the replay.
   */
  const flatFor = (marks: number[]): number[] => new Array(marks.length).fill(0);

  it('is zero on the first frame, which has no bar before it', () => {
    expect(computeEnergyTrack(framesOf(flatFor([100, 150, 120]), [100, 150, 120]))[0]!.barMove).toBe(0);
  });

  it('is signed by the candle direction', () => {
    const track = computeEnergyTrack(framesOf(flatFor([100, 130, 110]), [100, 130, 110]));
    expect(track[1]!.barMove).toBeGreaterThan(0);
    expect(track[2]!.barMove).toBeLessThan(0);
  });

  it('reaches 1 on the replay\'s largest candle and stays proportional below it', () => {
    // Scaled against the replay's own biggest bar, for the same reason momentum is: a
    // $40 candle is a whole day's range on one chart and a rounding error on another.
    const track = computeEnergyTrack(framesOf(flatFor([100, 110, 130, 230]), [100, 110, 130, 230]));
    expect(track[3]!.barMove).toBeCloseTo(1, 10);
    expect(track[2]!.barMove).toBeCloseTo(0.2, 10);
    expect(track[1]!.barMove).toBeCloseTo(0.1, 10);
  });

  it('is zero throughout a chart that never moves', () => {
    // No division by a zero largest bar, which would be NaN — and a NaN reaches an
    // alpha calculation and paints nothing at all.
    for (const e of computeEnergyTrack(framesOf(flatFor([1, 2, 3, 4, 5])))) {
      expect(e.barMove).toBe(0);
    }
  });

  it('is independent of PnL, so a flat position still reacts to the chart', () => {
    // The two channels answer different questions: `level` is where the money is,
    // `barMove` is what the market just did.
    const track = computeEnergyTrack(framesOf(flatFor([100, 100, 180]), [100, 100, 180]));
    expect(track[2]!.barMove).toBeCloseTo(1, 10);
    expect(track[2]!.level).toBe(0.5);
  });
});

describe('meterCells', () => {
  it('is empty at zero and full at one', () => {
    expect(meterCells(0, 4)).toEqual([0, 0, 0, 0]);
    expect(meterCells(1, 4)).toEqual([1, 1, 1, 1]);
  });

  it('fills left to right', () => {
    expect(meterCells(0.5, 4)).toEqual([1, 1, 0, 0]);
  });

  it('gives the boundary cell the remainder, so the meter reads as continuous', () => {
    const cells = meterCells(0.55, 4);
    expect(cells[2]).toBeCloseTo(0.2, 10);
    expect(cells[3]).toBe(0);
  });

  it('is always exactly the requested width, so the HUD does not reflow', () => {
    for (const level of [0, 0.13, 0.5, 0.87, 1]) {
      expect(meterCells(level, 10)).toHaveLength(10);
    }
  });

  it('clamps a level outside 0..1 rather than overflowing', () => {
    expect(meterCells(5, 3)).toEqual([1, 1, 1]);
    expect(meterCells(-5, 3)).toEqual([0, 0, 0]);
  });

  it('returns nothing for a zero width', () => {
    expect(meterCells(0.5, 0)).toEqual([]);
  });

  it('never returns a fraction a canvas cannot draw', () => {
    // A NaN level reached a fillRect width once and the meter simply vanished, which
    // is the failure mode this whole module has to avoid: silence, not a crash.
    for (const cell of meterCells(Number.NaN, 5)) {
      expect(Number.isFinite(cell)).toBe(true);
    }
  });
});

describe('flashStrength', () => {
  it('is strongest on the frame of the extreme', () => {
    expect(flashStrength(0)).toBe(1);
  });

  it('decays to nothing', () => {
    expect(flashStrength(8, 8)).toBe(0);
    expect(flashStrength(100)).toBe(0);
  });

  it('steps rather than fading — a terminal inverts or it does not', () => {
    const values = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => flashStrength(i, 8));
    expect(new Set(values).size).toBeLessThanOrEqual(4);
  });

  it('is zero when no extreme has happened', () => {
    expect(flashStrength(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
