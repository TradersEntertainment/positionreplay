import { describe, expect, it } from 'vitest';
import { BASE_FPS, CLIMAX_SPEED } from '@trade-replay/core';
import { buildSchedule, climaxStart, ffconcatFor } from './schedule.js';

describe('climaxStart', () => {
  it('is the frame count when slow finish is off — nothing is slowed', () => {
    expect(climaxStart(200, false)).toBe(200);
  });

  it('is the last ~10% of frames', () => {
    expect(climaxStart(200, true)).toBe(180);
  });

  it('always slows at least one frame on a short replay', () => {
    expect(climaxStart(4, true)).toBe(3);
  });

  it('handles an empty timeline', () => {
    expect(climaxStart(0, true)).toBe(0);
  });

  it('measures the tail against the trade, not the ending hold', () => {
    // The held frames are the closing card. Counting them would push the slow-down
    // past the exit — the position would close at full speed and the card would crawl.
    expect(climaxStart(236, true, 36)).toBe(180);
    expect(climaxStart(236, false, 36)).toBe(200);
  });
});

describe('buildSchedule', () => {
  it('plays the ending hold at full speed, however long the climax is', () => {
    const { durations } = buildSchedule({
      frameCount: 136,
      fps: 30,
      slowFinish: true,
      holdFrames: 36,
    });
    const even = 1 / BASE_FPS;
    // The last 36 are the card: a fixed second and a half, not five.
    for (let i = 100; i < 136; i++) expect(durations[i]).toBeCloseTo(even, 10);
    // The 10% before them is still the climax.
    expect(durations[95]).toBeCloseTo(even / CLIMAX_SPEED, 10);
  });

  it('holds every frame equally at normal speed', () => {
    const { durations } = buildSchedule({ frameCount: 48, fps: 30, slowFinish: false });
    expect(new Set(durations).size).toBe(1);
    // SPEC §6.3's rate, not the video's: a frame lasts 1/24s regardless of the
    // container's fps, which is what makes the export the same length as the preview.
    expect(durations[0]).toBeCloseTo(1 / BASE_FPS, 6);
  });

  it('runs at SPEC §6.3’s 24 frames per second of replay time', () => {
    // 240 frames at 24fps is ten seconds of replay, whatever the video fps.
    const { durationSeconds } = buildSchedule({ frameCount: 240, fps: 60, slowFinish: false });
    expect(durationSeconds).toBeCloseTo(10, 1);
  });

  it('holds the climax frames longer, by the ratio SPEC gives', () => {
    const { durations } = buildSchedule({ frameCount: 200, fps: 60, slowFinish: true });
    const normal = durations[0]!;
    const slow = durations[199]!;
    expect(slow / normal).toBeCloseTo(1 / CLIMAX_SPEED, 1);
  });

  it('makes the video longer when slow finish is on', () => {
    const even = buildSchedule({ frameCount: 200, fps: 60, slowFinish: false });
    const slow = buildSchedule({ frameCount: 200, fps: 60, slowFinish: true });
    expect(slow.durationSeconds).toBeGreaterThan(even.durationSeconds);
  });

  it('scales with playback speed', () => {
    const oneX = buildSchedule({ frameCount: 240, fps: 60, slowFinish: false, speed: 1 });
    const twoX = buildSchedule({ frameCount: 240, fps: 60, slowFinish: false, speed: 2 });
    expect(twoX.durationSeconds).toBeCloseTo(oneX.durationSeconds / 2, 1);
  });

  it('never holds a frame for less than one video frame', () => {
    // At 4x on a 15fps video a frame would mathematically last a third of a frame;
    // dropping it entirely would lose part of the replay.
    const { durations } = buildSchedule({ frameCount: 20, fps: 15, slowFinish: false, speed: 4 });
    expect(Math.min(...durations)).toBeCloseTo(1 / 15, 6);
  });

  it('is empty for an empty timeline rather than throwing', () => {
    expect(buildSchedule({ frameCount: 0, fps: 30, slowFinish: true })).toEqual({
      durations: [],
      durationSeconds: 0,
    });
  });

  it('rejects a non-positive fps instead of dividing by zero', () => {
    expect(() => buildSchedule({ frameCount: 10, fps: 0, slowFinish: false })).toThrow(/fps/);
  });

  it('uses the same base rate as the player', () => {
    expect(BASE_FPS).toBe(24);
  });
});

describe('ffconcatFor', () => {
  it('lists every frame with its duration', () => {
    const text = ffconcatFor(['a.png', 'b.png'], [0.05, 0.1]);
    expect(text).toContain("file 'a.png'");
    expect(text).toContain('duration 0.050000');
    expect(text).toContain('duration 0.100000');
  });

  it('repeats the last frame, because concat ignores its duration', () => {
    const text = ffconcatFor(['a.png', 'b.png'], [0.05, 0.1]);
    expect(text.match(/file 'b.png'/g)).toHaveLength(2);
  });

  it('starts with the ffconcat header ffmpeg expects', () => {
    expect(ffconcatFor(['a.png'], [0.05]).startsWith('ffconcat version 1.0\n')).toBe(true);
  });

  it('refuses to write a playlist with no frames', () => {
    expect(() => ffconcatFor([], [])).toThrow(/No frames/);
  });
});

describe('the schedule the worker actually writes', () => {
  it('is the length the player would have played', () => {
    // 193 frames is the fixture episode verify:m8 renders. At SPEC §6.3's 24fps that
    // is 8.04 seconds, and the exported MP4 measures 8.07 — the check that catches an
    // exporter running at the container's frame rate instead of the replay's.
    const { durationSeconds } = buildSchedule({ frameCount: 193, fps: 30, slowFinish: false });
    expect(durationSeconds).toBeCloseTo(193 / 24, 2);
  });

  it('produces a playlist ffmpeg can read for a real replay length', () => {
    const { durations } = buildSchedule({ frameCount: 193, fps: 30, slowFinish: true });
    const files = durations.map((_, i) => `frame-${String(i).padStart(5, '0')}.png`);
    const text = ffconcatFor(files, durations);

    // One `file` line per frame, plus the repeated last one.
    expect(text.match(/^file /gm)).toHaveLength(194);
    expect(text.match(/^duration /gm)).toHaveLength(193);
    // Nothing unquoted: a bare path with a space would silently truncate the playlist.
    expect(text.match(/^file [^']/m)).toBeNull();
  });
});
