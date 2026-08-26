import { buildEpisodes, buildFrames } from '@trade-replay/core';
import type { Fill, FundingEvent, PositionEpisode, PriceSeries } from '@trade-replay/core';
import { describe, expect, it } from 'vitest';
import { advanceScale, renderFrame } from './render.js';
import { computeMetrics, createScale } from './scale.js';
import { darkTheme, lightTheme } from './theme.js';
import type { Canvas2D } from './types.js';

/**
 * A context that records every call instead of drawing.
 *
 * Asserting on the call log is how a pure renderer gets tested: SPEC §7 promises
 * "same args -> same pixels", and identical call sequences are the checkable form of
 * that promise.
 */
interface Call {
  op: string;
  args: unknown[];
}

function recordingContext(): { ctx: Canvas2D; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (op: string) =>
    (...args: unknown[]): void => {
      calls.push({ op, args });
    };

  const ctx: Canvas2D = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    rect: record('rect'),
    arc: record('arc'),
    clip: record('clip'),
    fill: record('fill'),
    stroke: record('stroke'),
    fillRect: record('fillRect'),
    setLineDash: record('setLineDash'),
    fillText: record('fillText'),
    measureText: (text: string) => ({ width: text.length * 6 }),
  };

  // Capture style assignments too — colour is part of the output.
  return {
    ctx: new Proxy(ctx, {
      set(target, prop, value) {
        calls.push({ op: `set:${String(prop)}`, args: [value] });
        return Reflect.set(target, prop, value);
      },
    }),
    calls,
  };
}

const HL = { venue: 'hyperliquid' } as const;
const MIN = 60_000;

function makeSeries(count: number, price: (i: number) => number): PriceSeries {
  return {
    kind: 'ohlcv',
    instrument: 'HYPE-PERP',
    interval: '1m',
    candles: Array.from({ length: count }, (_, i) => {
      const c = price(i);
      return { t: i * MIN, o: c - 0.5, h: c + 1, l: c - 1, c, v: 10 };
    }),
  };
}

function fill(overrides: Partial<Fill> & Pick<Fill, 'id' | 'ts' | 'side' | 'price' | 'size'>): Fill {
  return {
    instrument: 'HYPE-PERP',
    displayName: 'HYPE PERP',
    fee: 1,
    raw: null,
    ...overrides,
  };
}

function scenario(funding: FundingEvent[] = []): {
  episode: PositionEpisode;
  series: PriceSeries;
  frames: ReturnType<typeof buildFrames>;
} {
  const episode = buildEpisodes(
    [
      fill({ id: 'open', ts: 10 * MIN, side: 'buy', price: 100, size: 10 }),
      fill({ id: 'close', ts: 40 * MIN, side: 'sell', price: 130, size: 10 }),
    ],
    { ...HL, funding },
  )[0]!;
  const series = makeSeries(50, (i) => 100 + i);
  return { episode, series, frames: buildFrames(episode, series) };
}

const LAYOUT = { width: 1080, height: 1080, dpr: 1 };

function texts(calls: Call[]): string[] {
  return calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
}

describe('renderFrame — purity (SPEC §7, CLAUDE.md)', () => {
  it('runs with no DOM present at all', () => {
    // vitest's node environment has no document/window. If renderFrame ever reached
    // for one, this would throw — and M8's server render worker would be impossible.
    expect(globalThis).not.toHaveProperty('document');
    const { episode, series, frames } = scenario();
    const { ctx } = recordingContext();

    expect(() => {
      renderFrame(ctx, frames.at(-1)!, episode, series, createScale(), darkTheme, LAYOUT);
    }).not.toThrow();
  });

  it('is deterministic: same args produce the same call sequence', () => {
    const { episode, series, frames } = scenario();

    const first = recordingContext();
    renderFrame(first.ctx, frames[30]!, episode, series, createScale(), darkTheme, LAYOUT);

    const second = recordingContext();
    renderFrame(second.ctx, frames[30]!, episode, series, createScale(), darkTheme, LAYOUT);

    expect(second.calls).toEqual(first.calls);
  });

  it('mutates only the scale it was handed', () => {
    const { episode, series, frames } = scenario();
    const scale = createScale();
    const frameBefore = structuredClone(frames[20]!);
    const episodeBefore = structuredClone(episode);

    renderFrame(recordingContext().ctx, frames[20]!, episode, series, scale, darkTheme, LAYOUT);

    expect(frames[20]).toEqual(frameBefore);
    expect(episode).toEqual(episodeBefore);
    expect(scale.initialized).toBe(true);
  });

  it('renders every frame index without throwing', () => {
    const { episode, series, frames } = scenario();
    const scale = createScale();
    for (const frame of frames) {
      expect(() =>
        renderFrame(recordingContext().ctx, frame, episode, series, scale, darkTheme, LAYOUT),
      ).not.toThrow();
    }
  });
});

describe('renderFrame — layers (SPEC §7.1)', () => {
  it('paints the background across the whole canvas first', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames[10]!, episode, series, createScale(), darkTheme, LAYOUT);

    const firstRect = calls.find((c) => c.op === 'fillRect');
    expect(firstRect!.args).toEqual([0, 0, 1080, 1080]);
  });

  it('draws the entry line dashed once the position is open', () => {
    const { episode, series, frames } = scenario();

    const before = recordingContext();
    renderFrame(before.ctx, frames[5]!, episode, series, createScale(), darkTheme, LAYOUT);
    const after = recordingContext();
    renderFrame(after.ctx, frames[20]!, episode, series, createScale(), darkTheme, LAYOUT);

    const dashes = (calls: Call[]) =>
      calls.filter((c) => c.op === 'setLineDash' && (c.args[0] as number[]).length > 0);

    // No position yet at frame 5, so no entry line to draw.
    expect(dashes(before.calls)).toHaveLength(0);
    expect(dashes(after.calls).length).toBeGreaterThan(0);
  });

  it('shows markers only once their bar is visible', () => {
    const { episode, series, frames } = scenario();

    const early = recordingContext();
    renderFrame(early.ctx, frames[5]!, episode, series, createScale(), darkTheme, LAYOUT);
    const late = recordingContext();
    renderFrame(late.ctx, frames[45]!, episode, series, createScale(), darkTheme, LAYOUT);

    expect(texts(early.calls).some((t) => t.includes('OPEN'))).toBe(false);
    expect(texts(late.calls).some((t) => t.includes('OPEN BUY'))).toBe(true);
    expect(texts(late.calls).some((t) => t.includes('CLOSE SELL'))).toBe(true);
  });

  it('fades a new marker in rather than popping it', () => {
    const { episode, series, frames } = scenario();

    const atFill = recordingContext();
    renderFrame(atFill.ctx, frames[10]!, episode, series, createScale(), darkTheme, LAYOUT);
    const settled = recordingContext();
    renderFrame(settled.ctx, frames[25]!, episode, series, createScale(), darkTheme, LAYOUT);

    const alphas = (calls: Call[]) =>
      calls.filter((c) => c.op === 'set:globalAlpha').map((c) => c.args[0] as number);

    expect(Math.min(...alphas(atFill.calls))).toBeLessThan(1);
    // Fifteen bars later the marker is fully opaque.
    expect(alphas(settled.calls).filter((a) => a > 0 && a < 0.5)).toHaveLength(0);
  });

  it('draws the watermark only when the host supplies one', () => {
    const { episode, series, frames } = scenario();

    const without = recordingContext();
    renderFrame(without.ctx, frames[20]!, episode, series, createScale(), darkTheme, LAYOUT);
    const with_ = recordingContext();
    renderFrame(with_.ctx, frames[20]!, episode, series, createScale(), darkTheme, {
      ...LAYOUT,
      watermark: 'trade-replay',
    });

    expect(texts(without.calls)).not.toContain('trade-replay');
    expect(texts(with_.calls)).toContain('trade-replay');
  });
});

/** CLAUDE.md: "No fabricated numbers in the HUD." */
describe('renderFrame — HUD honesty', () => {
  it('never invents a leverage figure', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames[20]!, episode, series, createScale(), darkTheme, LAYOUT);

    // Hyperliquid does not expose historical leverage (SPEC §4.3). Absent means absent.
    expect(texts(calls).some((t) => /\d+x/.test(t))).toBe(false);
  });

  it('shows leverage when the host supplies it as an overlay', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames[20]!, episode, series, createScale(), darkTheme, {
      ...LAYOUT,
      leverage: 5,
    });

    expect(texts(calls).some((t) => t.includes('5x'))).toBe(true);
  });

  it('labels funding as an estimate when any event is estimated', () => {
    const estimated = scenario([
      { id: 'f1', ts: 20 * MIN, instrument: 'HYPE-PERP', amount: -3, isEstimate: true, raw: null },
    ]);
    const actual = scenario([
      { id: 'f1', ts: 20 * MIN, instrument: 'HYPE-PERP', amount: -3, isEstimate: false, raw: null },
    ]);

    const a = recordingContext();
    renderFrame(a.ctx, estimated.frames[30]!, estimated.episode, estimated.series, createScale(), darkTheme, LAYOUT);
    const b = recordingContext();
    renderFrame(b.ctx, actual.frames[30]!, actual.episode, actual.series, createScale(), darkTheme, LAYOUT);

    expect(texts(a.calls)).toContain('FUNDING (EST)');
    expect(texts(b.calls)).toContain('FUNDING');
    expect(texts(b.calls)).not.toContain('FUNDING (EST)');
  });

  it('burns notices into the image, not just the surrounding UI', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames[20]!, episode, series, createScale(), darkTheme, {
      ...LAYOUT,
      notices: ['Fill history unavailable before 2024-01-01'],
    });

    // An export is a screenshot someone posts as fact; a caveat that lived only in the
    // web page would not travel with the image.
    expect(texts(calls).some((t) => t.includes('Fill history unavailable'))).toBe(true);
  });

  it('paints a zero PnL neutral, not green', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    // Frame 5 is before the position opens: everything is exactly zero.
    renderFrame(ctx, frames[5]!, episode, series, createScale(), darkTheme, LAYOUT);

    const beforeText = (needle: string): string | undefined => {
      const index = calls.findIndex((c) => c.op === 'fillText' && c.args[0] === needle);
      if (index === -1) return undefined;
      for (let i = index; i >= 0; i--) {
        if (calls[i]!.op === 'set:fillStyle') return String(calls[i]!.args[0]);
      }
      return undefined;
    };

    expect(beforeText('$0.00')).toBe(darkTheme.hudText);
    expect(beforeText('$0.00')).not.toBe(darkTheme.pnlUp);
  });

  it('says PENDING during the lead-in, not a zero-size position', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    // SPEC §6.1 pads 15% of context before the entry, so the replay opens on frames
    // where the position does not exist yet.
    renderFrame(ctx, frames[3]!, episode, series, createScale(), darkTheme, LAYOUT);

    expect(texts(calls).some((t) => t.includes('LONG PENDING'))).toBe(true);
    expect(texts(calls).some((t) => /LONG 0\.00/.test(t))).toBe(false);
  });

  it('says CLOSED rather than reporting a zero-size position', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames.at(-1)!, episode, series, createScale(), darkTheme, LAYOUT);

    expect(texts(calls).some((t) => t.includes('LONG CLOSED'))).toBe(true);
    expect(texts(calls).some((t) => /LONG 0\.00/.test(t))).toBe(false);
  });

  it('truncates the address instead of overflowing the HUD', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames[20]!, episode, series, createScale(), darkTheme, {
      ...LAYOUT,
      address: '0x393d0b87ed38fc779fd9611144ae649ba6082109',
    });

    expect(texts(calls).some((t) => t.includes('0x393d…2109'))).toBe(true);
  });
});

describe('renderFrame — theme and geometry', () => {
  it('draws no colour outside the active theme', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames[30]!, episode, series, createScale(), darkTheme, LAYOUT);

    const palette = new Set<string>(Object.values(darkTheme));
    const used = calls
      .filter((c) => c.op === 'set:fillStyle' || c.op === 'set:strokeStyle')
      .map((c) => String(c.args[0]));

    for (const color of used) expect(palette, `unthemed colour ${color}`).toContain(color);
  });

  it('swaps to a light theme with no code change', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames[30]!, episode, series, createScale(), lightTheme, LAYOUT);

    const backgrounds = calls.filter((c) => c.op === 'set:fillStyle').map((c) => c.args[0]);
    expect(backgrounds).toContain(lightTheme.background);
    expect(backgrounds).not.toContain(darkTheme.background);
  });

  it('adapts to both export presets (SPEC §9)', () => {
    const { episode, series, frames } = scenario();
    for (const [width, height] of [
      [1080, 1080],
      [1920, 1080],
    ] as const) {
      const { ctx, calls } = recordingContext();
      renderFrame(ctx, frames[30]!, episode, series, createScale(), darkTheme, {
        width,
        height,
        dpr: 1,
      });

      const background = calls.find((c) => c.op === 'fillRect')!;
      expect(background.args).toEqual([0, 0, width, height]);
      // Nothing should be drawn outside the canvas.
      for (const call of calls.filter((c) => c.op === 'fillText')) {
        expect(Number(call.args[1])).toBeLessThanOrEqual(width);
        expect(Number(call.args[2])).toBeLessThanOrEqual(height);
      }
    }
  });

  it('never overprints one x-axis label on the next', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    // Early frames show a narrow window with a growing x-domain, which is where the
    // tick step rounds down and produces more labels than there is room for.
    renderFrame(ctx, frames[6]!, episode, series, createScale(), darkTheme, LAYOUT);

    // Axis labels are the fillText calls sitting below the plot area.
    const axisLabels = calls
      .filter((c) => c.op === 'fillText' && Number(c.args[2]) > LAYOUT.height * 0.75)
      .map((c) => ({ text: String(c.args[0]), x: Number(c.args[1]) }))
      .filter((entry) => /\d/.test(entry.text) && entry.text.includes(':'))
      .sort((a, b) => a.x - b.x);

    for (let i = 1; i < axisLabels.length; i++) {
      const previous = axisLabels[i - 1]!;
      const current = axisLabels[i]!;
      // recordingContext measures 6px per character.
      const previousRight = previous.x - (previous.text.length * 6) / 2 + previous.text.length * 6;
      expect(current.x, `"${previous.text}" then "${current.text}"`).toBeGreaterThan(previousRight);
    }
  });

  it('renders a line series as well as candles', () => {
    const { episode } = scenario();
    const line: PriceSeries = {
      kind: 'line',
      instrument: 'HYPE-PERP',
      interval: '1s',
      points: Array.from({ length: 50 }, (_, i) => ({ t: i * MIN, p: 100 + i })),
    };
    const frames = buildFrames(episode, line);
    const { ctx, calls } = recordingContext();

    expect(() =>
      renderFrame(ctx, frames.at(-1)!, episode, line, createScale(), darkTheme, LAYOUT),
    ).not.toThrow();
    expect(calls.filter((c) => c.op === 'set:fillStyle').map((c) => c.args[0])).toContain(
      darkTheme.lineFill,
    );
  });

  it('handles an empty series without drawing garbage', () => {
    const { episode } = scenario();
    const empty: PriceSeries = { kind: 'ohlcv', instrument: 'HYPE-PERP', interval: '1m', candles: [] };
    const frames = buildFrames(episode, empty);
    expect(frames).toHaveLength(0);
  });
});

/** SPEC §4.4.3: forced exits must not look like ordinary closes. */
describe('renderFrame — liquidation and ADL', () => {
  function forcedScenario(flag: 'liquidation' | 'adl') {
    const episode = buildEpisodes(
      [
        fill({ id: 'open', ts: 10 * MIN, side: 'buy', price: 100, size: 10 }),
        fill({ id: 'out', ts: 40 * MIN, side: 'sell', price: 60, size: 10, [flag]: true }),
      ],
      HL,
    )[0]!;
    const series = makeSeries(50, (i) => 100 - i);
    return { episode, series, frames: buildFrames(episode, series) };
  }

  it('labels a liquidation as such, not as a close', () => {
    const { episode, series, frames } = forcedScenario('liquidation');
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames.at(-1)!, episode, series, createScale(), darkTheme, LAYOUT);

    expect(texts(calls).some((t) => t.includes('LIQUIDATED'))).toBe(true);
    expect(texts(calls).some((t) => t.startsWith('CLOSE '))).toBe(false);
  });

  it('labels an ADL distinctly from a liquidation', () => {
    const { episode, series, frames } = forcedScenario('adl');
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames.at(-1)!, episode, series, createScale(), darkTheme, LAYOUT);

    expect(texts(calls).some((t) => t.includes('ADL'))).toBe(true);
  });

  it('draws a forced exit in the venue-liquidation colour', () => {
    const { episode, series, frames } = forcedScenario('liquidation');
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames.at(-1)!, episode, series, createScale(), darkTheme, LAYOUT);

    const used = calls.filter((c) => c.op === 'set:fillStyle').map((c) => c.args[0]);
    expect(used).toContain(darkTheme.markerLiquidation);
  });

  it('draws an ordinary close without it', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames.at(-1)!, episode, series, createScale(), darkTheme, LAYOUT);

    const used = calls.filter((c) => c.op === 'set:fillStyle').map((c) => c.args[0]);
    expect(used).not.toContain(darkTheme.markerLiquidation);
  });
});

/** CLAUDE.md: show an unavailable value as unavailable, never as a number. */
describe('renderFrame — funding unavailable', () => {
  it('shows a dash rather than $0.00 when the venue cannot tell us', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames[30]!, episode, series, createScale(), darkTheme, {
      ...LAYOUT,
      fundingUnavailable: true,
    });

    // Other cells legitimately read $0.00 at this frame, so check the FUNDING cell
    // itself: the stats bar draws each label and its value at the same x.
    const drawn = calls
      .filter((c) => c.op === 'fillText')
      .map((c) => ({ text: String(c.args[0]), x: Number(c.args[1]), y: Number(c.args[2]) }));

    const label = drawn.find((d) => d.text === 'FUNDING');
    expect(label).toBeDefined();

    const value = drawn.find((d) => d.x === label!.x && d.y > label!.y);
    // $0.00 here would assert that no funding was paid.
    expect(value?.text).toBe('—');
  });

  it('still prints a real funding figure when the venue does report one', () => {
    const withFunding = scenario([
      { id: 'f1', ts: 20 * MIN, instrument: 'HYPE-PERP', amount: -3, isEstimate: false, raw: null },
    ]);
    const { ctx, calls } = recordingContext();
    renderFrame(
      ctx,
      withFunding.frames[30]!,
      withFunding.episode,
      withFunding.series,
      createScale(),
      darkTheme,
      LAYOUT,
    );

    expect(texts(calls)).toContain('-$3.00');
    expect(texts(calls)).not.toContain('—');
  });
});

describe('renderFrame — notices stay readable', () => {
  const LONG =
    'Only positions that are open right now can be replayed. Polymarket Perps serves just ' +
    'the current open cycle publicly, so a position that has already closed is unreachable ' +
    'and cannot be replayed at all.';

  it('never lets a notice run past the plot width', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames[30]!, episode, series, createScale(), darkTheme, {
      ...LAYOUT,
      notices: [LONG],
    });

    // recordingContext measures 6px per character at any size.
    const notice = calls
      .filter((c) => c.op === 'fillText')
      .map((c) => String(c.args[0]))
      .find((t) => t.startsWith('! '));

    expect(notice).toBeDefined();
    expect(notice!.endsWith('…')).toBe(true);
    expect(notice!.length * 6).toBeLessThanOrEqual(LAYOUT.width);
  });

  it('leaves a short notice untouched', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames[30]!, episode, series, createScale(), darkTheme, {
      ...LAYOUT,
      notices: ['SYNTHETIC DATA'],
    });

    expect(texts(calls)).toContain('! SYNTHETIC DATA');
  });

  it('says how many notices it could not fit, rather than dropping them silently', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames[30]!, episode, series, createScale(), darkTheme, {
      ...LAYOUT,
      notices: Array.from({ length: 12 }, (_, i) => `warning number ${i}`),
    });

    const notices = texts(calls).filter((t) => t.startsWith('! '));
    expect(notices.length).toBeLessThan(12);
    expect(notices.at(-1)).toMatch(/\(\+\d+ more\)/);
  });

  it('keeps notices clear of the stats values', () => {
    const { episode, series, frames } = scenario();
    const { ctx, calls } = recordingContext();
    renderFrame(ctx, frames[30]!, episode, series, createScale(), darkTheme, {
      ...LAYOUT,
      notices: [LONG, 'second', 'third'],
    });

    const drawn = calls
      .filter((c) => c.op === 'fillText')
      .map((c) => ({ text: String(c.args[0]), y: Number(c.args[2]) }));

    const boughtValue = drawn.find((d) => d.text.startsWith('$') && d.text.includes(','));
    const firstNotice = drawn.find((d) => d.text.startsWith('! '));

    expect(firstNotice).toBeDefined();
    if (boughtValue) expect(firstNotice!.y).toBeGreaterThan(boughtValue.y);
  });
});

describe('markers whose price is outside the candle range', () => {
  /**
   * A CSV maps its symbol to a Binance spot pair, and nothing guarantees that pair's
   * range contains the prices the user actually filled at. Before this was handled,
   * the marker's label was drawn past the plot and printed over the HUD.
   */
  function offRangeScenario(): ReturnType<typeof scenario> {
    const episode = buildEpisodes(
      [
        fill({ id: 'open', ts: 10 * MIN, side: 'buy', price: 60, size: 10 }),
        fill({ id: 'close', ts: 40 * MIN, side: 'sell', price: 400, size: 10 }),
      ],
      HL,
    )[0]!;
    // Bars sit between 100 and 149; both fills are well outside that.
    const series = makeSeries(50, (i) => 100 + i);
    return { episode, series, frames: buildFrames(episode, series) };
  }

  it('widens the axis so an off-range fill is still on the chart', () => {
    const { episode, series, frames } = offRangeScenario();
    const scale = createScale();
    for (const frame of frames) advanceScale(scale, series, frame, episode);

    // The bars alone top out at 149; the closing fill at 400 drags the axis far past
    // that. It does not arrive exactly at 400 because §7.2's easing is still closing
    // the gap when the replay ends — the clamp in markers.ts covers those frames.
    expect(scale.min).toBeLessThan(60);
    expect(scale.max).toBeGreaterThan(300);
  });

  it('does not widen for a fill that has not happened yet', () => {
    // Revealing the closing price through the axis would spoil the replay.
    const { episode, series, frames } = offRangeScenario();
    const scale = createScale();
    advanceScale(scale, series, frames[0]!, episode);
    expect(scale.max).toBeLessThan(400);
  });

  it('keeps every marker label inside the plot', () => {
    const { episode, series, frames } = offRangeScenario();
    const { ctx, calls } = recordingContext();
    const scale = createScale();

    // Frame 11 is right after the open: the scale has only started easing toward the
    // widened target, so this is the frame where a label used to escape the plot.
    for (let i = 0; i <= 11; i++) advanceScale(scale, series, frames[i]!, episode);
    renderFrame(ctx, frames[11]!, episode, series, scale, darkTheme, LAYOUT);

    const metrics = computeMetrics(LAYOUT);
    const labelYs = calls
      .filter((c) => c.op === 'fillText' && /^(OPEN|ADD|TRIM|CLOSE|FLIP)/.test(String(c.args[0])))
      .map((c) => Number(c.args[2]));

    expect(labelYs.length).toBeGreaterThan(0);
    for (const y of labelYs) {
      expect(y).toBeGreaterThanOrEqual(metrics.plot.y0);
      expect(y).toBeLessThanOrEqual(metrics.plot.y1);
    }
  });
});
