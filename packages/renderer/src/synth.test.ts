import { describe, expect, it } from 'vitest';
import type { Note } from './score.js';
import { encodeWav16, renderScorePcm } from './synth.js';

const SR = 48_000;

/** One frame every 1/24s, the rate SPEC §6.3 plays at. */
function evenFrames(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i / 24);
}

function note(overrides: Partial<Note> = {}): Note {
  return { frame: 0, midi: 60, velocity: 0.8, duration: 1, voice: 'lead', ...overrides };
}

function peakOf(samples: Float32Array, from = 0, to = samples.length): number {
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]!));
  return peak;
}

describe('renderScorePcm', () => {
  it('is silence when there is nothing to play', () => {
    const pcm = renderScorePcm([], { sampleRate: SR, frameTimes: evenFrames(48) });
    expect(peakOf(pcm)).toBe(0);
  });

  it('covers the whole replay plus the tail the last note rings into', () => {
    const frames = evenFrames(48);
    const pcm = renderScorePcm([], { sampleRate: SR, frameTimes: frames, tailSeconds: 2 });
    expect(pcm.length).toBe(Math.ceil((frames.at(-1)! + 2) * SR));
  });

  it('makes room for a note on the very last frame', () => {
    // The closing note lands on the ending's own frames, and the last of those is the
    // last frame there is. A buffer that stopped at the frame list would drop it.
    const frames = evenFrames(48);
    const pcm = renderScorePcm([note({ frame: 47, duration: 3 })], {
      sampleRate: SR,
      frameTimes: frames,
    });
    expect(pcm.length).toBeGreaterThanOrEqual(Math.ceil((frames.at(-1)! + 3) * SR) - 1);
    expect(peakOf(pcm, 47 * 2_000, 47 * 2_000 + 4_800)).toBeGreaterThan(0.05);
  });

  it('sounds a note at its own frame and not before it', () => {
    // The whole point of scheduling against the frame list: a note belongs to a frame,
    // not to a wall-clock offset. Frame 24 is one second in at 24fps.
    const frames = evenFrames(96);
    const pcm = renderScorePcm([note({ frame: 24 })], { sampleRate: SR, frameTimes: frames });

    expect(peakOf(pcm, 0, SR - 100)).toBe(0);
    expect(peakOf(pcm, SR, SR + 4_800)).toBeGreaterThan(0.05);
  });

  it('follows the schedule it is given, not a fixed frame rate', () => {
    // SPEC §6.3 slows the climax to 0.3x, so frames are not evenly spaced in the
    // exported video. A note timed off 1/24s would drift out of step with the picture.
    const frames = [0, 1, 2, 3];
    const pcm = renderScorePcm([note({ frame: 3 })], { sampleRate: SR, frameTimes: frames });
    expect(peakOf(pcm, 0, 3 * SR - 100)).toBe(0);
    expect(peakOf(pcm, 3 * SR, 3 * SR + 4_800)).toBeGreaterThan(0.05);
  });

  it('plays a harder-struck note louder', () => {
    const frames = evenFrames(48);
    const soft = renderScorePcm([note({ velocity: 0.2 })], { sampleRate: SR, frameTimes: frames });
    const hard = renderScorePcm([note({ velocity: 1 })], { sampleRate: SR, frameTimes: frames });
    expect(peakOf(hard)).toBeGreaterThan(peakOf(soft));
  });

  it('decays rather than holding', () => {
    const frames = evenFrames(96);
    const pcm = renderScorePcm([note({ duration: 2 })], { sampleRate: SR, frameTimes: frames });
    const early = peakOf(pcm, 0, SR / 4);
    const late = peakOf(pcm, Math.floor(SR * 1.5), Math.floor(SR * 1.9));
    expect(late).toBeLessThan(early * 0.5);
  });

  it('never clips, however many notes land at once', () => {
    // A run of large candles puts several notes on the same frame. Summing them
    // without headroom is how an export comes out distorted.
    const frames = evenFrames(96);
    const stack: Note[] = Array.from({ length: 12 }, (_, i) =>
      note({ frame: 24, midi: 48 + i, velocity: 1, voice: i % 2 === 0 ? 'lead' : 'bass' }),
    );
    const pcm = renderScorePcm(stack, { sampleRate: SR, frameTimes: frames });
    expect(peakOf(pcm)).toBeLessThanOrEqual(1);
    expect(peakOf(pcm)).toBeGreaterThan(0.1);
  });

  it('skips a note whose frame is not in the schedule rather than throwing', () => {
    const frames = evenFrames(24);
    expect(() =>
      renderScorePcm([note({ frame: 900 })], { sampleRate: SR, frameTimes: frames }),
    ).not.toThrow();
  });

  it('produces nothing at all for an empty schedule', () => {
    expect(renderScorePcm([note()], { sampleRate: SR, frameTimes: [] }).length).toBe(0);
  });
});

describe('encodeWav16', () => {
  it('writes a container ffmpeg will accept', () => {
    const wav = encodeWav16(new Float32Array(480), 48_000);
    const text = (at: number): string => String.fromCharCode(...wav.slice(at, at + 4));
    expect(text(0)).toBe('RIFF');
    expect(text(8)).toBe('WAVE');
    expect(text(12)).toBe('fmt ');
    expect(text(36)).toBe('data');
    // 44-byte header plus two bytes a sample.
    expect(wav.length).toBe(44 + 480 * 2);
  });

  it('states its own sizes correctly', () => {
    const wav = encodeWav16(new Float32Array(100), 44_100);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint32(40, true)).toBe(200);
  });

  it('clamps out-of-range samples instead of wrapping them', () => {
    // A sample above 1 written without clamping wraps to a large negative number,
    // which is heard as a click rather than as loudness.
    const wav = encodeWav16(Float32Array.from([2, -2]), 48_000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getInt16(44, true)).toBe(32_767);
    expect(view.getInt16(46, true)).toBe(-32_768);
  });
});
