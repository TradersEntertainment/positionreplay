import { describe, expect, it } from 'vitest';
import type { PriceSeries } from '@trade-replay/core';
import {
  BOUNDS_PADDING,
  computeBounds,
  computeMetrics,
  createScale,
  indexToX,
  priceToY,
  stepScale,
  xDomainFor,
  xToIndex,
  yToPrice,
} from './scale.js';

function ohlcv(closes: number[]): PriceSeries {
  return {
    kind: 'ohlcv',
    instrument: 'X-PERP',
    interval: '1m',
    candles: closes.map((c, i) => ({ t: i * 60_000, o: c, h: c + 2, l: c - 2, c, v: 1 })),
  };
}

describe('computeBounds (SPEC §7.2)', () => {
  it('covers the visible high/low with padding', () => {
    const bounds = computeBounds(ohlcv([10, 20, 30]), 2, null);
    // highs reach 32, lows reach 8; 8% padding widens both ends.
    expect(bounds.min).toBeLessThan(8);
    expect(bounds.max).toBeGreaterThan(32);
  });

  it('only considers bars up to visibleUpTo', () => {
    const series = ohlcv([10, 11, 999]);
    const bounds = computeBounds(series, 1, null);
    expect(bounds.max).toBeLessThan(100);
  });

  it('includes the entry line so it is never off-screen', () => {
    const bounds = computeBounds(ohlcv([10, 11, 12]), 2, 500);
    expect(bounds.max).toBeGreaterThan(500);
  });

  it('ignores a null entry line', () => {
    const bounds = computeBounds(ohlcv([10, 11, 12]), 2, null);
    expect(bounds.max).toBeLessThan(50);
  });

  it('produces a non-degenerate range for a perfectly flat series', () => {
    const flat: PriceSeries = {
      kind: 'ohlcv',
      instrument: 'X-PERP',
      interval: '1m',
      candles: [{ t: 0, o: 100, h: 100, l: 100, c: 100, v: 1 }],
    };
    const bounds = computeBounds(flat, 0, null);
    expect(bounds.max).toBeGreaterThan(bounds.min);
  });

  it('handles a line series as well as candles', () => {
    const line: PriceSeries = {
      kind: 'line',
      instrument: 'X-PERP',
      interval: '1s',
      points: [
        { t: 0, p: 5 },
        { t: 1, p: 15 },
      ],
    };
    const bounds = computeBounds(line, 1, null);
    expect(bounds.min).toBeLessThan(5);
    expect(bounds.max).toBeGreaterThan(15);
  });
});

describe('stepScale — exponential smoothing (SPEC §7.2)', () => {
  it('snaps straight to the target on the first step, with no slide-in', () => {
    const scale = createScale();
    stepScale(scale, { min: 10, max: 20 });
    // A fresh scale easing up from 0 would swing the whole chart on frame 1.
    expect(scale.min).toBe(10);
    expect(scale.max).toBe(20);
  });

  it('moves a fraction of the way toward a new target, not all of it', () => {
    const scale = createScale();
    stepScale(scale, { min: 0, max: 100 });
    stepScale(scale, { min: 0, max: 200 }, 0.12);

    expect(scale.max).toBeCloseTo(100 + 100 * 0.12, 9);
  });

  it('converges on the target when it stops moving', () => {
    const scale = createScale();
    stepScale(scale, { min: 0, max: 100 });
    for (let i = 0; i < 200; i++) stepScale(scale, { min: 50, max: 150 }, 0.12);

    expect(scale.min).toBeCloseTo(50, 3);
    expect(scale.max).toBeCloseTo(150, 3);
  });

  it('is smooth: no single step jumps more than the easing factor allows', () => {
    const scale = createScale();
    stepScale(scale, { min: 0, max: 100 });
    const before = scale.max;
    stepScale(scale, { min: 0, max: 1_000_000 }, 0.12);

    expect(scale.max - before).toBeCloseTo((1_000_000 - before) * 0.12, 6);
  });
});

describe('projection', () => {
  const plot = { x0: 100, y0: 50, x1: 500, y1: 250, width: 400, height: 200 };

  it('maps the scale max to the top of the plot and min to the bottom', () => {
    const scale = createScale();
    stepScale(scale, { min: 0, max: 100 });

    expect(priceToY(100, scale, plot)).toBeCloseTo(50, 9);
    expect(priceToY(0, scale, plot)).toBeCloseTo(250, 9);
    expect(priceToY(50, scale, plot)).toBeCloseTo(150, 9);
  });

  it('does not divide by zero on a collapsed scale', () => {
    const scale = createScale();
    stepScale(scale, { min: 42, max: 42 });
    expect(Number.isFinite(priceToY(42, scale, plot))).toBe(true);
  });

  it('spreads indices across the plot width', () => {
    expect(indexToX(0, 10, plot)).toBeCloseTo(100, 9);
    expect(indexToX(10, 10, plot)).toBeCloseTo(500, 9);
    expect(indexToX(5, 10, plot)).toBeCloseTo(300, 9);
  });
});

describe('xDomainFor (SPEC §7.2 option b vs a)', () => {
  it('grows with the visible bars by default', () => {
    expect(xDomainFor('growing', 50, 200)).toBeLessThan(xDomainFor('growing', 150, 200));
  });

  it('keeps a floor so the first frames are not one giant bar', () => {
    expect(xDomainFor('growing', 0, 200)).toBeGreaterThan(1);
  });

  it('never grows past the full series', () => {
    expect(xDomainFor('growing', 199, 200)).toBeLessThanOrEqual(200);
  });

  it('uses the whole episode from frame 0 in fixed mode', () => {
    expect(xDomainFor('fixed', 0, 200)).toBe(200);
    expect(xDomainFor('fixed', 150, 200)).toBe(200);
  });
});

describe('computeMetrics — resolution independence (SPEC §9)', () => {
  it('scales every region with the canvas, with no hardcoded pixels', () => {
    const small = computeMetrics({ width: 1080, height: 1080, dpr: 1 });
    const large = computeMetrics({ width: 2160, height: 2160, dpr: 1 });

    expect(large.unit).toBeCloseTo(small.unit * 2, 6);
    expect(large.plot.width).toBeCloseTo(small.plot.width * 2, 6);
    expect(large.plot.height).toBeCloseTo(small.plot.height * 2, 6);
  });

  it('keeps the plot inside the canvas for both presets', () => {
    for (const [width, height] of [
      [1080, 1080],
      [1920, 1080],
    ] as const) {
      const m = computeMetrics({ width, height, dpr: 1 });
      expect(m.plot.x0).toBeGreaterThan(0);
      expect(m.plot.y0).toBeGreaterThan(0);
      expect(m.plot.x1).toBeLessThan(width);
      expect(m.plot.y1).toBeLessThan(height);
      expect(m.plot.width).toBeGreaterThan(0);
      expect(m.plot.height).toBeGreaterThan(0);
    }
  });

  it('leaves room on the right for the price axis', () => {
    const m = computeMetrics({ width: 1920, height: 1080, dpr: 1 });
    expect(1920 - m.plot.x1).toBeGreaterThanOrEqual(m.axisWidth);
  });
});

describe('computeBounds — fill prices outside the candle range', () => {
  const series: PriceSeries = {
    kind: 'ohlcv',
    instrument: 'BTC',
    interval: '1h',
    candles: Array.from({ length: 10 }, (_, i) => ({
      t: i * 3_600_000,
      o: 100,
      h: 101,
      l: 99,
      c: 100,
      v: 1,
    })),
  };

  it('widens to include a fill above every bar', () => {
    // A CSV whose symbol maps to a Binance pair that never traded this high still has
    // to show the marker. Off-screen, it would paint over the HUD instead.
    const bounds = computeBounds(series, 9, null, BOUNDS_PADDING, [140]);
    expect(bounds.max).toBeGreaterThan(140);
  });

  it('widens to include a fill below every bar', () => {
    const bounds = computeBounds(series, 9, null, BOUNDS_PADDING, [60]);
    expect(bounds.min).toBeLessThan(60);
  });

  it('ignores fill prices with no bars in range', () => {
    const bounds = computeBounds(series, 9, null, BOUNDS_PADDING, []);
    expect(bounds.max).toBeLessThan(110);
  });

  it('still honours the entry line alongside fill prices', () => {
    const bounds = computeBounds(series, 9, 200, BOUNDS_PADDING, [60]);
    expect(bounds.min).toBeLessThan(60);
    expect(bounds.max).toBeGreaterThan(200);
  });

  it('ignores a non-finite fill price rather than collapsing the axis', () => {
    const bounds = computeBounds(series, 9, null, BOUNDS_PADDING, [Number.NaN]);
    expect(Number.isFinite(bounds.min)).toBe(true);
    expect(Number.isFinite(bounds.max)).toBe(true);
  });
});

describe('yToPrice / xToIndex', () => {
  const plot = { x0: 40, y0: 20, x1: 440, y1: 320, width: 400, height: 300 };
  const scale = { min: 100, max: 200 };

  it('is the exact inverse of priceToY', () => {
    // The builder's chart and the replay renderer have to agree to the pixel, or a
    // click places a trade slightly off the candle it was aimed at.
    for (const price of [100, 123.45, 150, 199.99, 200]) {
      expect(yToPrice(priceToY(price, scale, plot), scale, plot)).toBeCloseTo(price, 9);
    }
  });

  it('is the exact inverse of indexToX', () => {
    for (const index of [0, 1, 17, 63.5, 100]) {
      expect(xToIndex(indexToX(index, 100, plot), 100, plot)).toBeCloseTo(index, 9);
    }
  });

  it('maps the plot edges to the ends of the scale', () => {
    expect(yToPrice(plot.y1, scale, plot)).toBeCloseTo(100, 9);
    expect(yToPrice(plot.y0, scale, plot)).toBeCloseTo(200, 9);
    expect(xToIndex(plot.x0, 50, plot)).toBeCloseTo(0, 9);
    expect(xToIndex(plot.x1, 50, plot)).toBeCloseTo(50, 9);
  });

  it('returns a fractional index rather than rounding', () => {
    // Whether a click between two bars belongs to the earlier or the nearer one is the
    // caller's decision; rounding here would make it silently.
    expect(xToIndex(indexToX(3.5, 10, plot), 10, plot)).toBeCloseTo(3.5, 9);
  });

  it('does not divide by a zero span or a zero-width plot', () => {
    expect(Number.isFinite(yToPrice(50, { min: 7, max: 7 }, plot))).toBe(true);
    expect(
      Number.isFinite(xToIndex(50, 10, { ...plot, width: 0, x1: plot.x0 })),
    ).toBe(true);
  });
});
