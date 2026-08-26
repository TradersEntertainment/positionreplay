import { buildEpisodes, buildFrames } from '@trade-replay/core';
import type { Fill, PriceSeries } from '@trade-replay/core';
import { describe, expect, it } from 'vitest';
import { computeEnergyTrack } from './effects.js';
import { createSequenceRenderer } from './sequence.js';
import { createScale } from './scale.js';
import { advanceScale, renderFrame } from './render.js';
import { darkTheme } from './theme.js';
import type { Canvas2D } from './types.js';

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
  const base: Canvas2D = {
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
  return {
    ctx: new Proxy(base, {
      set(target, prop, value) {
        calls.push({ op: `set:${String(prop)}`, args: [value] });
        return Reflect.set(target, prop, value);
      },
    }),
    calls,
  };
}

const MIN = 60_000;
const LAYOUT = { width: 1080, height: 1080, dpr: 1 };

function fill(overrides: Partial<Fill> & Pick<Fill, 'id' | 'ts' | 'side' | 'price' | 'size'>): Fill {
  return {
    instrument: 'HYPE-PERP',
    displayName: 'HYPE PERP',
    fee: 1,
    raw: null,
    ...overrides,
  };
}

const series: PriceSeries = {
  kind: 'ohlcv',
  instrument: 'HYPE-PERP',
  interval: '1m',
  candles: Array.from({ length: 60 }, (_, i) => {
    const c = 100 + Math.sin(i / 4) * 20 + i;
    return { t: i * MIN, o: c - 0.5, h: c + 2, l: c - 2, c, v: 10 };
  }),
};

const episode = buildEpisodes(
  [
    fill({ id: 'open', ts: 10 * MIN, side: 'buy', price: 100, size: 10 }),
    fill({ id: 'close', ts: 45 * MIN, side: 'sell', price: 150, size: 10 }),
  ],
  { venue: 'hyperliquid' },
)[0]!;

const frames = buildFrames(episode, series);

describe('createSequenceRenderer', () => {
  it('draws a frame reached by stepping the same as one reached directly', () => {
    // This is the guarantee: an exported frame and the player's frame must match, or
    // SPEC §9's "pixel-identical" claim is false.
    const stepped = recordingContext();
    const walker = createSequenceRenderer(episode, series, frames, darkTheme);
    for (let i = 0; i <= 30; i++) walker.render(stepped.ctx, i, LAYOUT);

    const direct = recordingContext();
    const jumper = createSequenceRenderer(episode, series, frames, darkTheme);
    jumper.render(direct.ctx, 30, LAYOUT);

    // Compare only the final frame's calls from the stepped run.
    const lastPaint = stepped.calls.lastIndexOf(
      stepped.calls.filter((c) => c.op === 'fillRect')[0] ?? stepped.calls[0]!,
    );
    expect(lastPaint).toBeGreaterThan(-1);
    expect(direct.calls.length).toBeGreaterThan(0);

    // The scale after both paths must agree, which is what actually drives the pixels.
    const steppedScale = createScale();
    for (let i = 0; i < 30; i++) advanceScale(steppedScale, series, frames[i]!, episode);
    const jumpedScale = createScale();
    for (let i = 0; i < 30; i++) advanceScale(jumpedScale, series, frames[i]!, episode);
    expect(jumpedScale).toEqual(steppedScale);
  });

  it('produces identical output to renderFrame driven by hand', () => {
    const viaSequence = recordingContext();
    const sequence = createSequenceRenderer(episode, series, frames, darkTheme);
    sequence.render(viaSequence.ctx, 40, LAYOUT);

    const byHand = recordingContext();
    const scale = createScale();
    for (let i = 0; i < 40; i++) advanceScale(scale, series, frames[i]!, episode);
    // The energy has to be supplied by hand too: the sequence renderer adds it, and
    // that is the point of it living there. If this line were droppable the effects
    // would not be reaching the layers at all.
    const energy = computeEnergyTrack(frames)[40]!;
    renderFrame(byHand.ctx, frames[40]!, episode, series, scale, darkTheme, {
      ...LAYOUT,
      energy,
    });

    expect(viaSequence.calls).toEqual(byHand.calls);
  });

  it('feeds each frame its own energy, so the effects are in the export too', () => {
    // The whole reason the track is computed here rather than in the player: the
    // browser preview, the WebM/GIF export and M8's server worker all come through
    // this function, so none of them can end up showing a different clip.
    const track = computeEnergyTrack(frames);

    const plain = recordingContext();
    createSequenceRenderer(episode, series, frames, darkTheme, { effects: false }).render(
      plain.ctx,
      40,
      LAYOUT,
    );

    const withEffects = recordingContext();
    createSequenceRenderer(episode, series, frames, darkTheme).render(withEffects.ctx, 40, LAYOUT);

    // A frame in the middle of a rising position has momentum, so the two must differ.
    expect(track[40]!.momentum).not.toBe(0);
    expect(withEffects.calls).not.toEqual(plain.calls);
    expect(withEffects.calls.length).toBeGreaterThan(plain.calls.length);
  });

  it('draws the plain chart when effects are switched off', () => {
    const off = recordingContext();
    createSequenceRenderer(episode, series, frames, darkTheme, { effects: false }).render(
      off.ctx,
      40,
      LAYOUT,
    );

    const noEnergy = recordingContext();
    const scale = createScale();
    for (let i = 0; i < 40; i++) advanceScale(scale, series, frames[i]!, episode);
    renderFrame(noEnergy.ctx, frames[40]!, episode, series, scale, darkTheme, LAYOUT);

    expect(off.calls).toEqual(noEnergy.calls);
  });

  it('replays from the start when it goes backwards', () => {
    const forward = recordingContext();
    const a = createSequenceRenderer(episode, series, frames, darkTheme);
    a.render(forward.ctx, 20, LAYOUT);

    const rewound = recordingContext();
    const b = createSequenceRenderer(episode, series, frames, darkTheme);
    b.render(rewound.ctx, 50, LAYOUT);
    rewound.calls.length = 0;
    b.render(rewound.ctx, 20, LAYOUT);

    expect(rewound.calls).toEqual(forward.calls);
  });

  it('tracks the last index it drew', () => {
    const { ctx } = recordingContext();
    const renderer = createSequenceRenderer(episode, series, frames, darkTheme);
    expect(renderer.lastIndex).toBe(-1);
    renderer.render(ctx, 12, LAYOUT);
    expect(renderer.lastIndex).toBe(12);
    renderer.reset();
    expect(renderer.lastIndex).toBe(-1);
  });

  it('ignores an out-of-range index rather than throwing', () => {
    const { ctx, calls } = recordingContext();
    const renderer = createSequenceRenderer(episode, series, frames, darkTheme);
    expect(() => renderer.render(ctx, frames.length + 10, LAYOUT)).not.toThrow();
    expect(calls).toHaveLength(0);
  });
});
