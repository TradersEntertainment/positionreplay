import { describe, expect, it } from 'vitest';
import {
  OUTRO_HOLD_FRAMES,
  easeOutCubic,
  outroLength,
  outroProgressAt,
  outroStart,
} from './outro.js';

describe('outroLength', () => {
  it('is exactly the frames buildFrames holds after the last bar', () => {
    // The one thing this file exists to guarantee: the card plays over the held
    // frames and never over the trade's own closing bars.
    expect(outroLength(1000)).toBe(OUTRO_HOLD_FRAMES);
    expect(outroStart(1000)).toBe(1000 - OUTRO_HOLD_FRAMES);
  });

  it('leaves at least one frame of chart in front of the card', () => {
    expect(outroStart(OUTRO_HOLD_FRAMES + 1)).toBe(1);
  });

  it('is absent on a frame list that cannot have come from buildFrames', () => {
    // A fixture or a trimmed clip shorter than the hold gets no ending, rather than
    // an ending drawn over its only frames.
    expect(outroLength(OUTRO_HOLD_FRAMES)).toBe(0);
    expect(outroLength(7)).toBe(0);
    expect(outroLength(0)).toBe(0);
  });
});

describe('outroProgressAt', () => {
  const total = 200;

  it('is absent before the outro starts', () => {
    expect(outroProgressAt(0, total)).toBeNull();
    expect(outroProgressAt(outroStart(total) - 1, total)).toBeNull();
  });

  it('starts at 0 on its first frame and reaches exactly 1 on the last', () => {
    expect(outroProgressAt(outroStart(total), total)).toBe(0);
    expect(outroProgressAt(total - 1, total)).toBe(1);
  });

  it('rises monotonically across the window', () => {
    const values: number[] = [];
    for (let i = outroStart(total); i < total; i++) {
      values.push(outroProgressAt(i, total)!);
    }
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });

  it('is absent everywhere on a replay too short for an outro', () => {
    expect(outroProgressAt(3, 5)).toBeNull();
    expect(outroProgressAt(4, 5)).toBeNull();
  });

  it('holds at 1 past the end rather than running past it', () => {
    // A still rendered at a clamped index must not scale the chart to nothing.
    expect(outroProgressAt(total + 10, total)).toBe(1);
  });
});

describe('easeOutCubic', () => {
  it('pins both ends', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it('front-loads the movement, so the pull-back settles rather than arrives', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});
