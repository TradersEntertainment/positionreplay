import { describe, expect, it } from 'vitest';
import {
  BASE_FPS,
  CLIMAX_SPEED,
  CLIMAX_TAIL_RATIO,
  MAX_ADVANCE_MS,
  createPlaybackClock,
} from './playback.js';

const FRAMES = 200;

function clock(frameCount = FRAMES, climax = false) {
  return createPlaybackClock({ frameCount, climax });
}

/**
 * Advance `totalMs` the way a real loop does — in per-tick deltas.
 *
 * Handing the clock one big delta is the backgrounded-tab case, which MAX_ADVANCE_MS
 * deliberately clamps, so it is the wrong way to express "a second of playback".
 */
function run(c: ReturnType<typeof clock>, totalMs: number, tickMs = 1000 / 60): void {
  // Count the ticks rather than accumulating a float `elapsed`, which overshoots and
  // sneaks in an extra tick.
  const ticks = Math.round(totalMs / tickMs);
  for (let i = 0; i < ticks; i++) c.advance(tickMs);
}

describe('createPlaybackClock — basics', () => {
  it('starts paused on the first frame', () => {
    const c = clock();
    expect(c.state.frameIndex).toBe(0);
    expect(c.state.playing).toBe(false);
    expect(c.state.speed).toBe(1);
  });

  it('does not move while paused', () => {
    const c = clock();
    c.advance(5_000);
    expect(c.state.frameIndex).toBe(0);
  });

  it('play/pause/toggle flip the running state', () => {
    const c = clock();
    c.play();
    expect(c.state.playing).toBe(true);
    c.pause();
    expect(c.state.playing).toBe(false);
    c.toggle();
    expect(c.state.playing).toBe(true);
  });

  it('returns the new frame index from advance, for the render loop', () => {
    const c = clock();
    c.play();
    expect(c.advance(100)).toBe(c.state.frameIndex);
  });
});

describe('fixed timestep (SPEC §6.3)', () => {
  it('advances 24 frames per second at 1x', () => {
    const c = clock();
    c.play();
    run(c, 1_000);
    expect(c.state.frameIndex).toBe(BASE_FPS);
  });

  it('scales with speed', () => {
    for (const [speed, expected] of [
      [0.5, 12],
      [1, 24],
      [2, 48],
      [4, 96],
    ] as const) {
      const c = clock();
      c.setSpeed(speed);
      c.play();
      run(c, 1_000);
      expect(c.state.frameIndex, `at ${speed}x`).toBe(expected);
    }
  });

  it('carries the remainder instead of dropping it', () => {
    const c = clock();
    c.play();
    // Two 30ms ticks are 60ms — one whole frame at 41.67ms/frame, plus change.
    c.advance(30);
    expect(c.state.frameIndex).toBe(0);
    c.advance(30);
    expect(c.state.frameIndex).toBe(1);
  });

  it('is frame-rate independent: many small ticks equal one big one', () => {
    // This is the whole point of the accumulator. A 120Hz display and a 30Hz one
    // must reach the same frame after the same wall-clock time.
    const fast = clock();
    const slow = clock();
    fast.play();
    slow.play();

    for (let i = 0; i < 120; i++) fast.advance(1000 / 120);
    for (let i = 0; i < 30; i++) slow.advance(1000 / 30);

    expect(fast.state.frameIndex).toBe(slow.state.frameIndex);
    expect(fast.state.frameIndex).toBe(BASE_FPS);
  });

  it('reproduces a wall-clock sequence when driven by a fixed counter', () => {
    // SPEC §6.3: "Same clock math is reused by the exporter, just driven by a counter
    // instead of wall time." If these diverged, an exported MP4 would not match the
    // preview it was rendered from.
    const live = clock();
    const exporter = clock();
    live.play();
    exporter.play();

    for (let i = 0; i < 60; i++) live.advance(1000 / 60);
    for (let i = 0; i < 60; i++) exporter.advance(1000 / 60);

    expect(exporter.state.frameIndex).toBe(live.state.frameIndex);
    expect(exporter.state.accumulator).toBeCloseTo(live.state.accumulator, 12);
  });

  it('clamps a huge delta so a backgrounded tab does not skip the replay', () => {
    const c = clock();
    c.play();
    c.advance(60_000); // tab was hidden for a minute

    // Without a clamp this would jump straight to the end and the user would see
    // nothing between where they were and the final frame.
    expect(c.state.frameIndex).toBe(Math.floor(MAX_ADVANCE_MS / (1000 / BASE_FPS)));
    expect(c.state.playing).toBe(true);
  });
});

describe('bounds', () => {
  it('stops on the final frame instead of running past it', () => {
    const c = clock(50);
    c.play();
    run(c, 10_000);

    expect(c.state.frameIndex).toBe(49);
    expect(c.state.playing).toBe(false);
  });

  it('rewinds when play is pressed at the end', () => {
    const c = clock(50);
    c.seek(49);
    c.play();

    expect(c.state.frameIndex).toBe(0);
    expect(c.state.playing).toBe(true);
  });

  it('clamps seek at both ends', () => {
    const c = clock(50);
    c.seek(-10);
    expect(c.state.frameIndex).toBe(0);
    c.seek(999);
    expect(c.state.frameIndex).toBe(49);
  });

  it('rounds a fractional seek, since the scrubber produces one', () => {
    const c = clock(50);
    c.seek(12.7);
    expect(c.state.frameIndex).toBe(13);
  });

  it('drops the partial frame on seek', () => {
    const c = clock();
    c.play();
    c.advance(30); // most of a frame banked
    c.seek(100);
    // Inheriting that remainder would make the first frame after a seek short.
    expect(c.state.accumulator).toBe(0);
  });

  it('steps by whole frames for the arrow keys', () => {
    const c = clock();
    c.seek(50);
    c.step(1);
    expect(c.state.frameIndex).toBe(51);
    c.step(-10);
    expect(c.state.frameIndex).toBe(41);
  });

  it('pauses when stepped, so an arrow key does not fight the loop', () => {
    const c = clock();
    c.play();
    c.step(1);
    expect(c.state.playing).toBe(false);
  });

  it('survives a degenerate frame count', () => {
    const empty = clock(0);
    empty.play();
    expect(empty.advance(1_000)).toBe(0);

    const single = clock(1);
    single.play();
    run(single, 1_000);
    expect(single.state.frameIndex).toBe(0);
  });
});

describe('climax easing (SPEC §6.3)', () => {
  it('slows the last stretch of frames when enabled', () => {
    const eased = clock(100, true);
    const plain = clock(100, false);
    const start = Math.floor(100 * (1 - CLIMAX_TAIL_RATIO));

    for (const c of [eased, plain]) {
      c.seek(start);
      c.play();
      run(c, 1_000);
    }

    expect(eased.state.frameIndex).toBeLessThan(plain.state.frameIndex);
    // 0.3x through the tail: 1000ms buys 1000 / (1000 / (24 * 0.3)) frames.
    const tailFrames = Math.floor(1_000 / (1_000 / (BASE_FPS * CLIMAX_SPEED)));
    expect(eased.state.frameIndex).toBe(start + tailFrames);
  });

  it('does not slow frames before the tail', () => {
    const eased = clock(1_000, true);
    const plain = clock(1_000, false);
    for (const c of [eased, plain]) {
      c.play();
      run(c, 1_000);
    }
    expect(eased.state.frameIndex).toBe(plain.state.frameIndex);
  });

  it('is toggleable at runtime', () => {
    const c = clock(100, false);
    expect(c.state.climax).toBe(false);
    c.setClimax(true);
    expect(c.state.climax).toBe(true);
  });
});

describe('speed and reset', () => {
  it('keeps its position when the speed changes mid-playback', () => {
    const c = clock();
    c.play();
    run(c, 1_000);
    const at = c.state.frameIndex;
    c.setSpeed(4);
    expect(c.state.frameIndex).toBe(at);
    expect(c.state.playing).toBe(true);
  });

  it('drops the partial frame on a speed change', () => {
    const c = clock();
    c.play();
    c.advance(30);
    c.setSpeed(2);
    // Otherwise a remainder banked at 1x pays out at 2x, which stutters on the switch.
    expect(c.state.accumulator).toBe(0);
  });

  it('reset returns it to the start, paused', () => {
    const c = clock();
    c.play();
    run(c, 2_000);
    c.setSpeed(4);
    c.reset();

    expect(c.state.frameIndex).toBe(0);
    expect(c.state.playing).toBe(false);
    expect(c.state.accumulator).toBe(0);
    expect(c.state.speed).toBe(1);
  });

  it('adopts a new frame count when the interval changes', () => {
    const c = clock(200);
    c.seek(199);
    c.setFrameCount(50);
    // The interval override rebuilds the frames; the old index would be out of range.
    expect(c.state.frameCount).toBe(50);
    expect(c.state.frameIndex).toBe(49);
  });
});
