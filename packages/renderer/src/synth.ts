/**
 * The score, rendered offline into samples.
 *
 * `score.ts` decides what should be heard; apps/web/lib/audio.ts plays that through
 * WebAudio in the browser. This is the third case: a video rendered on the server, where
 * there is no audio context and no real time to schedule against. Without it the MP4 is
 * silent — which is exactly what shipped, because the WebM export records the live
 * player's graph and the MP4 is built from PNG frames by ffmpeg, so only one of the two
 * ever had sound.
 *
 * It lives beside score.ts and is pure for the same reason the renderer is: no DOM, no
 * async, nothing that needs a browser. The voice — which partials, how loud, how it
 * decays — is defined here and imported by the browser player, so the two cannot drift
 * into being different instruments.
 *
 * They are not sample-identical, and could not be: WebAudio's `triangle` is band-limited
 * by the implementation, and this one is a fixed additive table. Same shape, same
 * envelope, same level. SPEC §9's identity claim is about the picture.
 */

import type { Note } from './score.js';
import { midiToHz } from './score.js';

export interface VoicePartial {
  /** Multiple of the fundamental. */
  ratio: number;
  level: number;
  wave: 'sine' | 'triangle';
}

/**
 * The harmonics fade faster than the fundamental, which is what makes a struck string
 * sound struck instead of held.
 */
export const LEAD_PARTIALS: readonly VoicePartial[] = [
  { ratio: 1, level: 1, wave: 'triangle' },
  { ratio: 2, level: 0.28, wave: 'sine' },
  { ratio: 3, level: 0.12, wave: 'sine' },
];

export const BASS_PARTIALS: readonly VoicePartial[] = [
  { ratio: 1, level: 1, wave: 'sine' },
  { ratio: 2, level: 0.18, wave: 'sine' },
];

/**
 * A real string's upper partials sit slightly sharp of the exact multiple. A few cents
 * is inaudible as pitch and is most of why this reads as an instrument.
 */
export const DETUNE_CENTS_PER_RATIO = 4;

export const ATTACK_SECONDS = 0.004;

/** Where the exponential decay is cut. It cannot reach zero, so it reaches this. */
export const DECAY_FLOOR = 0.001;

/**
 * Master level. See apps/web/lib/audio.ts for how it was arrived at: at 0.22 a single
 * note landed near -30 dBFS, which is a perfectly good explanation for "no sound".
 */
export const MASTER_GAIN = 0.5;

/**
 * A limiter, so the notes can be loud without the overlaps clipping.
 *
 * Same settings as the browser's DynamicsCompressor. Up to three notes ring at once and
 * their tails sum; without this, a level loud enough for one note distorts on a run.
 */
export const LIMITER = {
  thresholdDb: -10,
  kneeDb: 6,
  ratio: 12,
  attackSeconds: 0.003,
  releaseSeconds: 0.15,
} as const;

/** The closing note is a bass note in everything but name. Only the score cares. */
export function isBassVoice(voice: Note['voice']): boolean {
  return voice !== 'lead';
}

export function voicePeak(note: Note): number {
  return note.velocity * (isBassVoice(note.voice) ? 0.9 : 0.7);
}

export function partialsFor(voice: Note['voice']): readonly VoicePartial[] {
  return isBassVoice(voice) ? BASS_PARTIALS : LEAD_PARTIALS;
}

/**
 * One cycle of a band-limited triangle.
 *
 * Odd harmonics at 1/n², alternating sign. Truncated at 21 so the highest note the
 * score can reach (about 880 Hz) keeps its harmonics under Nyquist at 44.1kHz — a naive
 * triangle aliases there, and aliasing on a sustained note is a metallic ring that
 * sounds like a bug rather than an instrument.
 */
const TABLE_SIZE = 2048;
const TRIANGLE_HARMONICS = 21;

const TRIANGLE_TABLE = ((): Float32Array => {
  const table = new Float32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) {
    const phase = (2 * Math.PI * i) / TABLE_SIZE;
    let value = 0;
    for (let k = 1; k <= TRIANGLE_HARMONICS; k += 2) {
      value += (((k - 1) / 2) % 2 === 0 ? 1 : -1) * (Math.sin(k * phase) / (k * k));
    }
    table[i] = (8 / Math.PI ** 2) * value;
  }
  return table;
})();

/** `phase` in turns, not radians. Linear interpolation between table entries. */
function triangleAt(turns: number): number {
  const pos = (turns - Math.floor(turns)) * TABLE_SIZE;
  const i = Math.floor(pos);
  const frac = pos - i;
  const a = TRIANGLE_TABLE[i]!;
  const b = TRIANGLE_TABLE[(i + 1) % TABLE_SIZE]!;
  return a + (b - a) * frac;
}

/**
 * The envelope at `t` seconds into a note, matching the browser's exactly: a linear
 * attack, then an exponential decay to a floor, then cut.
 *
 * A linear decay would sound like a fade-out rather than a struck string.
 */
export function envelopeAt(t: number, duration: number, peak: number): number {
  if (t < 0 || t >= duration || peak <= 0) return 0;
  if (t < ATTACK_SECONDS) return (peak * t) / ATTACK_SECONDS;

  const floor = Math.max(peak * DECAY_FLOOR, 0.0001);
  const span = Math.max(1e-6, duration - ATTACK_SECONDS);
  return peak * (floor / peak) ** ((t - ATTACK_SECONDS) / span);
}

export interface ScorePcmOptions {
  sampleRate: number;
  /**
   * The second each frame index sounds at.
   *
   * Passed in rather than derived from a frame rate because SPEC §6.3's climax slows
   * the last stretch to 0.3x and the closing card runs at full speed: frames are not
   * evenly spaced in the exported video, and a soundtrack timed off 1/24s would drift
   * out of step with the picture it is supposed to accompany.
   */
  frameTimes: readonly number[];
  /** Seconds after the last frame for the final note to ring into. */
  tailSeconds?: number;
}

/**
 * The whole soundtrack as mono float samples in [-1, 1].
 *
 * Additive, one note at a time into a shared buffer, then limited. Straightforward
 * rather than clever: a replay is a few hundred notes over ten seconds, which is a few
 * million samples — well under a second of work, and the render worker is already
 * spending far longer drawing PNGs.
 */
export function renderScorePcm(notes: readonly Note[], options: ScorePcmOptions): Float32Array {
  const { sampleRate, frameTimes } = options;
  if (frameTimes.length === 0) return new Float32Array(0);

  const lastFrameAt = frameTimes[frameTimes.length - 1]!;

  // Long enough for every note it was handed, not just for the frame list. A note on
  // the final frame has nowhere to ring otherwise, and it would be dropped in silence —
  // which on this replay is the closing note, the one the ending is built around.
  // Trailing samples past the picture cost nothing: ffmpeg's -shortest trims them.
  let end = lastFrameAt + (options.tailSeconds ?? 0);
  for (const note of notes) {
    const at = frameTimes[note.frame];
    if (at !== undefined) end = Math.max(end, at + note.duration);
  }

  const total = Math.max(1, Math.ceil(end * sampleRate));
  const out = new Float32Array(total);

  for (const note of notes) {
    const at = frameTimes[note.frame];
    // A note outside the schedule is dropped rather than clamped to frame 0: a
    // truncated timeline would otherwise stack its whole melody on the downbeat.
    if (at === undefined) continue;

    const start = Math.round(at * sampleRate);
    if (start >= total) continue;

    const peak = voicePeak(note);
    if (peak <= 0) continue;

    const partials = partialsFor(note.voice);
    const hz = midiToHz(note.midi);
    const count = Math.min(total - start, Math.ceil(note.duration * sampleRate));

    // Per-partial phase increment in turns per sample.
    const steps = partials.map((partial) => {
      const detune = partial.ratio === 1 ? 0 : DETUNE_CENTS_PER_RATIO * partial.ratio;
      return (hz * partial.ratio * 2 ** (detune / 1200)) / sampleRate;
    });

    for (let i = 0; i < count; i++) {
      const env = envelopeAt(i / sampleRate, note.duration, peak);
      if (env === 0) continue;

      let sample = 0;
      for (let p = 0; p < partials.length; p++) {
        const partial = partials[p]!;
        const turns = steps[p]! * i;
        sample +=
          partial.level *
          (partial.wave === 'triangle' ? triangleAt(turns) : Math.sin(2 * Math.PI * turns));
      }
      out[start + i]! += env * sample;
    }
  }

  for (let i = 0; i < total; i++) out[i]! *= MASTER_GAIN;
  limit(out, sampleRate);
  return out;
}

/** Soft-knee gain reduction in dB for a level in dB. Never positive. */
function kneeGainDb(levelDb: number): number {
  const over = levelDb - LIMITER.thresholdDb;
  if (over <= -LIMITER.kneeDb / 2) return 0;
  if (over >= LIMITER.kneeDb / 2) return over / LIMITER.ratio - over;
  const x = over + LIMITER.kneeDb / 2;
  return ((1 / LIMITER.ratio - 1) * x * x) / (2 * LIMITER.kneeDb);
}

/** Feed-forward peak limiter, in place, followed by a hard safety clamp. */
function limit(samples: Float32Array, sampleRate: number): void {
  const attack = Math.exp(-1 / (sampleRate * LIMITER.attackSeconds));
  const release = Math.exp(-1 / (sampleRate * LIMITER.releaseSeconds));
  let envelope = 0;

  for (let i = 0; i < samples.length; i++) {
    const level = Math.abs(samples[i]!);
    const coefficient = level > envelope ? attack : release;
    envelope = coefficient * envelope + (1 - coefficient) * level;

    const gain = 10 ** (kneeGainDb(20 * Math.log10(Math.max(envelope, 1e-9))) / 20);
    const value = samples[i]! * gain;
    // The limiter is not brick-wall — a fast transient can still cross 1 before the
    // envelope catches it, and a sample above 1 wraps when it is written as an integer.
    samples[i] = value > 1 ? 1 : value < -1 ? -1 : value;
  }
}

/**
 * A 16-bit mono WAV, for handing to ffmpeg.
 *
 * Written by hand rather than with a library: the header is eleven fields, and this
 * avoids a dependency in the render worker's Docker image for the sake of them.
 */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);

  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]!;
    const clamped = value > 1 ? 1 : value < -1 ? -1 : value;
    // Asymmetric on purpose: 16-bit signed runs -32768..32767, and scaling by 32768
    // would let +1.0 wrap to the most negative sample there is.
    view.setInt16(44 + i * 2, Math.round(clamped * (clamped < 0 ? 32_768 : 32_767)), true);
  }

  return bytes;
}
