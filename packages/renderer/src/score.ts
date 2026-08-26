/**
 * The replay's soundtrack, as data.
 *
 * A list of notes with frame indices — no oscillators, no `AudioContext`, nothing that
 * needs a browser. The player turns this into sound (apps/web/lib/audio.ts); this file
 * only decides what should be heard and when.
 *
 * It lives beside effects.ts and follows the same rule for the same reason: it is
 * derived from the precomputed `Frame[]`, never from wall time. A replay scrubbed to
 * frame 90 plays the note that belongs to frame 90, and a clip recorded with audio
 * carries the same music the viewer heard. Deriving it from `Date.now()` would make the
 * sound a different performance every time, which is the one thing an export cannot
 * tolerate.
 *
 * Everything is pentatonic. That is the whole trick behind music generated from data
 * that never sounds wrong: within a pentatonic scale there are no minor seconds and no
 * tritone, so any sequence of degrees — including ones chosen by a PnL curve that
 * lurches — stays consonant. A diatonic mapping would produce a genuinely sour interval
 * the moment PnL jumped by the wrong amount.
 */

import type { PositionEpisode } from '@trade-replay/core';
import type { FrameEnergy } from './effects.js';

export interface Note {
  /** The frame this note sounds on. */
  frame: number;
  /** MIDI note number; 60 is middle C. */
  midi: number;
  /** 0..1. */
  velocity: number;
  /** Seconds the note rings for, before its own decay. */
  duration: number;
  /**
   * `lead` is the PnL melody, `bass` marks a fill.
   *
   * Two voices rather than one so the fills stay audible under a busy melody — they are
   * the events a viewer is actually trying to spot.
   */
  voice: 'lead' | 'bass';
}

/** Semitone offsets. Major for a winning replay, minor for a losing one. */
const MAJOR_PENTATONIC = [0, 2, 4, 7, 9];
const MINOR_PENTATONIC = [0, 3, 5, 7, 10];

/** C3. Low enough that two octaves up stays out of the piercing register. */
const ROOT_MIDI = 48;

/** Degrees the melody can reach: two octaves of the five-note scale. */
const DEGREES = 10;

/** Frames between melody notes. Eight at SPEC §6.3's 24fps is three notes a second. */
export const LEAD_EVERY = 8;

/**
 * How big a candle has to be to get its own note.
 *
 * Every frame reveals a bar, so an ungated note-per-candle is 24 notes a second — not
 * music, and it would make a large candle indistinguishable from a small one, which is
 * the opposite of the point. Above this the bar sounds, below it the bar is silent, and
 * the contrast is what makes a big move audible as a big move.
 */
export const BAR_NOTE_FLOOR = 0.3;

/**
 * Frames that must pass between two bar notes.
 *
 * A run of large candles would otherwise fire on consecutive frames and arrive as a
 * chord rather than as a run. Three frames caps it at eight notes a second, which is
 * fast enough to feel urgent and slow enough to still be a melody.
 */
export const BAR_NOTE_GAP = 3;

/** Turn a pentatonic degree into a MIDI note, wrapping octaves as it climbs. */
export function degreeToMidi(degree: number, scale: readonly number[]): number {
  const size = scale.length;
  const octave = Math.floor(degree / size);
  const step = ((degree % size) + size) % size;
  return ROOT_MIDI + octave * 12 + scale[step]!;
}

/**
 * The notes for one replay.
 *
 * `energy` comes from `computeEnergyTrack`, so the melody follows exactly the same
 * curve the on-screen meter and flashes do — the sound and the picture are two readings
 * of one number rather than two things that happen to move together.
 */
export function composeScore(
  frames: readonly { t: number; totalPnl: number }[],
  energy: readonly FrameEnergy[],
  episode: PositionEpisode,
): Note[] {
  if (frames.length === 0) return [];

  // One key for the whole piece, decided by how the trade ends. Switching mode partway
  // through would be the musical equivalent of the axis rescaling mid-replay.
  const finalPnl = frames[frames.length - 1]!.totalPnl;
  const scale = finalPnl >= 0 ? MAJOR_PENTATONIC : MINOR_PENTATONIC;

  const notes: Note[] = [];
  let lastBarNote = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < frames.length; i++) {
    const e = energy[i];
    if (!e) continue;

    // A new extreme always sounds, whenever it lands. Waiting for the next beat would
    // put the accent after the flash, and a note that arrives late reads as a mistake
    // rather than as an accent.
    const accent = (e.newHigh || e.newLow) && i > 0;

    // A candle big enough to see gets a note of its own, so the melody follows the
    // chart bar by bar instead of only marking the record highs and lows.
    const size = Math.abs(e.barMove);
    const bar = size >= BAR_NOTE_FLOOR && i - lastBarNote >= BAR_NOTE_GAP;
    if (bar) lastBarNote = i;

    if (!accent && !bar && i % LEAD_EVERY !== 0) continue;

    const degree = Math.round(e.level * (DEGREES - 1));
    notes.push({
      frame: i,
      // An accent is an octave up: the same note of the same scale, so it cannot clash.
      midi: degreeToMidi(degree, scale) + (accent ? 12 : 0),
      // The candle's own size is the loudest term when it is what fired the note. A
      // beat that nothing prompted stays quiet, so the two do not sound alike.
      velocity: clamp01(
        0.22 + Math.abs(e.momentum) * 0.3 + (bar ? size * 0.55 : 0) + (accent ? 0.15 : 0),
      ),
      duration: accent ? 1.8 : bar ? 0.9 : 1.2,
      voice: 'lead',
    });
  }

  // Fills get the root of the key, two octaves down: a marker, not a melody.
  for (const step of episode.steps) {
    const frame = frameAt(frames, step.fill.ts);
    if (frame === null) continue;
    notes.push({
      frame,
      midi: ROOT_MIDI - 12,
      velocity: 0.75,
      duration: 2.4,
      voice: 'bass',
    });
  }

  // Sorted so a player can walk the list once while scrubbing forwards.
  notes.sort((a, b) => a.frame - b.frame || a.midi - b.midi);
  return notes;
}

/**
 * The frame a timestamp falls on, or null if it is outside the replay.
 *
 * Outside means silent rather than clamped to frame 0: a fill before the first frame
 * would otherwise fire a bass note at the very start of every replay whose history was
 * truncated, which sounds like a downbeat that is not there.
 */
function frameAt(frames: readonly { t: number }[], ts: number): number | null {
  const first = frames[0]!.t;
  const last = frames[frames.length - 1]!.t;
  if (ts < first || ts > last) return null;

  let low = 0;
  let high = frames.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (frames[mid]!.t <= ts) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** MIDI note to hertz, A4 = 440. */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
