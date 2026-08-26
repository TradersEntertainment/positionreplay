import { describe, expect, it } from 'vitest';
import { buildEpisodes } from './episodes.js';
import {
  MANUAL_MAX_LEGS,
  ManualSpecError,
  decodeManualSpec,
  encodeManualSpec,
  manualFills,
  normalizeManualSpec,
} from './manual.js';
import type { ManualSpec } from './manual.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 2, 12, 0, 0);

function spec(overrides: Partial<ManualSpec> = {}): ManualSpec {
  return {
    venue: 'hyperliquid',
    instrument: 'HYPE',
    displayName: 'HYPE',
    legs: [
      { ts: T0, side: 'buy', size: 100, price: 10 },
      { ts: T0 + 4 * HOUR, side: 'sell', size: 100, price: 14 },
    ],
    ...overrides,
  };
}

describe('manualFills', () => {
  it('turns each leg into a fill the §5 fold can read', () => {
    const fills = manualFills(spec());

    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({
      ts: T0,
      side: 'buy',
      price: 10,
      size: 100,
      instrument: 'HYPE',
      displayName: 'HYPE',
    });
  });

  it('gives every fill a distinct id, or the dedupe would eat them', () => {
    // Two legs at the same instant and price is a legitimate thing to type, and
    // `Fill.id` is the dedupe key — colliding ids would silently drop one.
    const fills = manualFills(
      spec({
        legs: [
          { ts: T0, side: 'buy', size: 1, price: 10 },
          { ts: T0, side: 'buy', size: 1, price: 10 },
        ],
      }),
    );

    expect(new Set(fills.map((f) => f.id)).size).toBe(2);
  });

  it('carries no fee, and does not pretend the fee is zero', () => {
    // A hypothetical trade did not pay fees, but a real one would have. Zero is a claim
    // about cost; `undefined` is the absence of one. See ManualSpec's doc comment.
    for (const fill of manualFills(spec())) {
      expect(fill.fee).toBe(0);
      expect(fill.raw).toBeNull();
    }
  });

  it('reconstructs into an episode that closes', () => {
    const episodes = buildEpisodes(manualFills(spec()), { venue: 'hyperliquid' });

    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.closedAt).toBe(T0 + 4 * HOUR);
    expect(episodes[0]!.realizedPnl).toBeCloseTo(400, 6);
  });

  it('reconstructs a position left open', () => {
    const episodes = buildEpisodes(
      manualFills(spec({ legs: [{ ts: T0, side: 'buy', size: 100, price: 10 }] })),
      { venue: 'hyperliquid' },
    );

    expect(episodes[0]!.closedAt).toBeNull();
  });

  it('handles a short, where the profit is the fall', () => {
    const episodes = buildEpisodes(
      manualFills(
        spec({
          legs: [
            { ts: T0, side: 'sell', size: 10, price: 100 },
            { ts: T0 + HOUR, side: 'buy', size: 10, price: 80 },
          ],
        }),
      ),
      { venue: 'hyperliquid' },
    );

    expect(episodes[0]!.direction).toBe('short');
    expect(episodes[0]!.realizedPnl).toBeCloseTo(200, 6);
  });
});

describe('normalizeManualSpec', () => {
  it('sorts legs by time, however they were typed', () => {
    // The form lets rows be filled in any order, and §5 is a running fold: reading it
    // out of order produces a different and wrong answer rather than an error.
    const out = normalizeManualSpec(
      spec({
        legs: [
          { ts: T0 + 4 * HOUR, side: 'sell', size: 100, price: 14 },
          { ts: T0, side: 'buy', size: 100, price: 10 },
        ],
      }),
    );

    expect(out.legs.map((l) => l.ts)).toEqual([T0, T0 + 4 * HOUR]);
  });

  it('refuses a spec with no legs', () => {
    expect(() => normalizeManualSpec(spec({ legs: [] }))).toThrow(ManualSpecError);
  });

  it('refuses more legs than the URL can carry', () => {
    const many = Array.from({ length: MANUAL_MAX_LEGS + 1 }, (_, i) => ({
      ts: T0 + i * HOUR,
      side: 'buy' as const,
      size: 1,
      price: 10,
    }));
    expect(() => normalizeManualSpec(spec({ legs: many }))).toThrow(/at most/i);
  });

  it('refuses a size or price that is not a positive finite number', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        normalizeManualSpec(spec({ legs: [{ ts: T0, side: 'buy', size: bad, price: 10 }] })),
      ).toThrow(ManualSpecError);
      expect(() =>
        normalizeManualSpec(spec({ legs: [{ ts: T0, side: 'buy', size: 1, price: bad }] })),
      ).toThrow(ManualSpecError);
    }
  });

  it('refuses a timestamp that is not a real instant', () => {
    expect(() =>
      normalizeManualSpec(spec({ legs: [{ ts: Number.NaN, side: 'buy', size: 1, price: 1 }] })),
    ).toThrow(ManualSpecError);
  });

  it('refuses an empty instrument, which would render a chart with no title', () => {
    expect(() => normalizeManualSpec(spec({ instrument: '   ' }))).toThrow(ManualSpecError);
  });

  it('falls back to the instrument when no display name was given', () => {
    expect(normalizeManualSpec(spec({ displayName: '' })).displayName).toBe('HYPE');
  });

  it('truncates a timestamp to whole milliseconds', () => {
    expect(
      normalizeManualSpec(spec({ legs: [{ ts: T0 + 0.7, side: 'buy', size: 1, price: 1 }] }))
        .legs[0]!.ts,
    ).toBe(T0);
  });
});

describe('encodeManualSpec / decodeManualSpec', () => {
  it('round-trips a spec through a URL-safe string', () => {
    const original = normalizeManualSpec(spec());
    const encoded = encodeManualSpec(original);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeManualSpec(encoded)).toEqual(original);
  });

  it('normalizes on the way in, so a hand-built link cannot smuggle bad legs', () => {
    // This value comes out of a URL, so it is attacker-controlled.
    const outOfOrder = encodeManualSpec(
      spec({
        legs: [
          { ts: T0 + HOUR, side: 'sell', size: 1, price: 20 },
          { ts: T0, side: 'buy', size: 1, price: 10 },
        ],
      }),
    );

    expect(decodeManualSpec(outOfOrder)?.legs.map((l) => l.ts)).toEqual([T0, T0 + HOUR]);
  });

  it('returns null for anything malformed rather than throwing', () => {
    // A route handler has to be able to 404 on this without a try/catch around it.
    for (const bad of ['', 'not-base64!!', 'YWJj', btoaUrl('{"venue":"nope"}'), btoaUrl('{')]) {
      expect(decodeManualSpec(bad)).toBeNull();
    }
  });

  it('returns null for a spec that decodes but is invalid', () => {
    expect(decodeManualSpec(btoaUrl(JSON.stringify({ v: 1, i: 'X', l: [] })))).toBeNull();
  });

  it('stays short enough to be a link', () => {
    // Eight legs is the cap; if that does not fit in a URL the cap is wrong.
    const eight = Array.from({ length: MANUAL_MAX_LEGS }, (_, i) => ({
      ts: T0 + i * HOUR,
      side: (i % 2 === 0 ? 'buy' : 'sell') as 'buy' | 'sell',
      size: 1234.5678,
      price: 98765.4321,
    }));
    expect(encodeManualSpec(normalizeManualSpec(spec({ legs: eight }))).length).toBeLessThan(600);
  });
});

function btoaUrl(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
