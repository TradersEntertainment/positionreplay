import { buildEpisodes } from '@trade-replay/core';
import type { Fill, Frame } from '@trade-replay/core';
import { describe, expect, it } from 'vitest';
import { computeEnergyTrack } from './effects.js';
import {
  BAR_NOTE_FLOOR,
  BAR_NOTE_GAP,
  LEAD_EVERY,
  composeScore,
  degreeToMidi,
  midiToHz,
} from './score.js';

const MIN = 60_000;

/**
 * `marks` drives the per-candle channel; leaving it out means a flat chart, which is
 * how most of these tests isolate the beat from the bar reaction.
 */
function framesOf(pnls: number[], marks?: number[]): Frame[] {
  return pnls.map((totalPnl, i) => ({
    t: i * MIN,
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
    bought: 0,
    sold: 0,
    newFills: [],
    isFinal: i === pnls.length - 1,
  }));
}

function fill(id: string, ts: number, side: 'buy' | 'sell', size: number): Fill {
  return {
    id,
    ts,
    side,
    price: 100,
    size,
    instrument: 'X-PERP',
    displayName: 'X PERP',
    fee: 0,
    raw: null,
  };
}

const episode = buildEpisodes(
  [fill('open', 2 * MIN, 'buy', 10), fill('close', 8 * MIN, 'sell', 10)],
  { venue: 'hyperliquid' },
)[0]!;

/** A rising then falling curve, long enough for several beats. */
const rising = framesOf(Array.from({ length: 40 }, (_, i) => i * 10));

function scoreOf(frames: Frame[]) {
  return composeScore(frames, computeEnergyTrack(frames), episode);
}

describe('composeScore', () => {
  it('returns nothing for a replay with no frames', () => {
    expect(composeScore([], [], episode)).toEqual([]);
  });

  it('plays the melody on the beat', () => {
    const lead = scoreOf(rising).filter((n) => n.voice === 'lead');
    expect(lead.length).toBeGreaterThan(0);
    // Every rising frame is a new high, so this replay accents constantly. What must
    // hold is that the beats themselves are all present.
    for (let i = 0; i < rising.length; i += LEAD_EVERY) {
      expect(lead.some((n) => n.frame === i)).toBe(true);
    }
  });

  it('stays in one key, chosen by how the trade ends', () => {
    const winner = scoreOf(framesOf(Array.from({ length: 30 }, (_, i) => i)));
    const loser = scoreOf(framesOf(Array.from({ length: 30 }, (_, i) => -i)));

    // Degree 1 of the scale is the tell: 2 semitones in major, 3 in minor.
    const pitches = (notes: ReturnType<typeof scoreOf>): Set<number> =>
      new Set(notes.filter((n) => n.voice === 'lead').map((n) => n.midi % 12));

    expect(pitches(winner)).not.toEqual(pitches(loser));
  });

  it('never leaves the pentatonic scale, so no sequence can sound sour', () => {
    // The point of the whole design: a PnL curve that lurches cannot produce a minor
    // second, because those intervals are not in the set of available notes.
    const jagged = framesOf([0, 900, -400, 12, 880, -890, 5, 300, -20, 640, 0, 100, 700]);
    const allowed = new Set([0, 2, 4, 7, 9]);
    for (const note of scoreOf(jagged)) {
      expect(allowed.has(((note.midi - 48) % 12 + 12) % 12)).toBe(true);
    }
  });

  it('marks every fill inside the replay with a bass note', () => {
    const bass = scoreOf(rising).filter((n) => n.voice === 'bass');
    expect(bass).toHaveLength(episode.steps.length);
    for (const note of bass) {
      expect(note.frame).toBeGreaterThanOrEqual(0);
      expect(note.frame).toBeLessThan(rising.length);
    }
  });

  it('drops a fill that falls outside the frames rather than snapping it to the start', () => {
    // A truncated history would otherwise open every replay with a downbeat that does
    // not correspond to anything on screen.
    const late = framesOf(Array.from({ length: 40 }, (_, i) => i)).map((f) => ({
      ...f,
      t: f.t + 1000 * MIN,
    }));
    expect(composeScore(late, computeEnergyTrack(late), episode).filter((n) => n.voice === 'bass'))
      .toHaveLength(0);
  });

  it('is sorted by frame, so a player can walk it once', () => {
    const notes = scoreOf(rising);
    for (let i = 1; i < notes.length; i++) {
      expect(notes[i]!.frame).toBeGreaterThanOrEqual(notes[i - 1]!.frame);
    }
  });

  it('keeps velocity inside 0..1 even when momentum is extreme', () => {
    const violent = framesOf([0, 0, 0, 0, 100_000, 0, 0, 0, -100_000, 0, 0, 0, 50_000]);
    for (const note of scoreOf(violent)) {
      expect(note.velocity).toBeGreaterThan(0);
      expect(note.velocity).toBeLessThanOrEqual(1);
    }
  });

  it('is the same score every time it is composed', () => {
    // The reason it is derived from frames and not from wall time: a recorded clip has
    // to carry the music the viewer heard.
    expect(scoreOf(rising)).toEqual(scoreOf(rising));
  });

  it('says nothing for a flat replay beyond its beats', () => {
    const flat = framesOf(new Array(30).fill(100));
    const notes = scoreOf(flat).filter((n) => n.voice === 'lead');
    // No extremes after the first frame, so no accents — only the steady beat.
    expect(notes.every((n) => n.frame % LEAD_EVERY === 0)).toBe(true);
  });
});

describe('composeScore — the per-candle voice', () => {
  /** Flat PnL throughout, so only the candles can be firing anything. */
  const flatPnl = new Array(30).fill(0);

  it('sounds a note for a candle big enough to see', () => {
    // One large bar in an otherwise still chart.
    const marks = new Array(30).fill(100);
    marks[15] = 140;
    const notes = composeScore(
      framesOf(flatPnl, marks),
      computeEnergyTrack(framesOf(flatPnl, marks)),
      episode,
    );

    expect(notes.some((n) => n.frame === 15 && n.voice === 'lead')).toBe(true);
  });

  it('leaves a small candle silent, which is what makes a big one loud', () => {
    const marks = new Array(30).fill(100);
    marks[15] = 140;
    // Frame 9 moves a twentieth as far and is not on a beat.
    marks[9] = 102;
    const frames = framesOf(flatPnl, marks);
    const notes = composeScore(frames, computeEnergyTrack(frames), episode);

    expect(computeEnergyTrack(frames)[9]!.barMove).toBeLessThan(BAR_NOTE_FLOOR);
    expect(notes.some((n) => n.frame === 9)).toBe(false);
  });

  it('plays a bigger candle louder than a smaller one', () => {
    const marks = new Array(30).fill(100);
    marks[9] = 130; // 30 up
    marks[19] = 200; // 70 up — the replay's largest, so barMove is 1
    const frames = framesOf(flatPnl, marks);
    const notes = composeScore(frames, computeEnergyTrack(frames), episode);

    const small = notes.find((n) => n.frame === 9 && n.voice === 'lead');
    const large = notes.find((n) => n.frame === 19 && n.voice === 'lead');
    expect(small).toBeDefined();
    expect(large).toBeDefined();
    expect(large!.velocity).toBeGreaterThan(small!.velocity);
  });

  it('will not fire two bar notes closer together than the gap', () => {
    // A run of violent candles must arrive as a run, not as one chord.
    const marks = Array.from({ length: 30 }, (_, i) => 100 + i * 30);
    const frames = framesOf(flatPnl, marks);
    const barNotes = composeScore(frames, computeEnergyTrack(frames), episode)
      .filter((n) => n.voice === 'lead')
      .map((n) => n.frame)
      // Beat notes are allowed to land anywhere; only the bar notes are rate-limited.
      .filter((f) => f % LEAD_EVERY !== 0);

    for (let i = 1; i < barNotes.length; i++) {
      expect(barNotes[i]! - barNotes[i - 1]!).toBeGreaterThanOrEqual(BAR_NOTE_GAP);
    }
  });

  it('stays pentatonic however busy the candles get', () => {
    const marks = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 50 + i * 7);
    const pnls = Array.from({ length: 40 }, (_, i) => Math.cos(i) * 900);
    const frames = framesOf(pnls, marks);
    // The key follows how the trade ends, so the expected set is derived rather than
    // written down — hardcoding one made this test pass or fail on the sign of cos(39).
    const allowed = new Set(
      frames[frames.length - 1]!.totalPnl >= 0 ? [0, 2, 4, 7, 9] : [0, 3, 5, 7, 10],
    );
    const notes = composeScore(frames, computeEnergyTrack(frames), episode);
    expect(notes.length).toBeGreaterThan(20);
    for (const note of notes) {
      expect(allowed.has((((note.midi - 48) % 12) + 12) % 12)).toBe(true);
    }
  });
});

describe('degreeToMidi', () => {
  it('climbs through octaves rather than stopping at the top of the scale', () => {
    const scale = [0, 2, 4, 7, 9];
    expect(degreeToMidi(0, scale)).toBe(48);
    expect(degreeToMidi(4, scale)).toBe(57);
    expect(degreeToMidi(5, scale)).toBe(60);
  });
});

describe('midiToHz', () => {
  it('puts A4 at 440', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(midiToHz(60)).toBeCloseTo(261.6256, 3);
  });
});
