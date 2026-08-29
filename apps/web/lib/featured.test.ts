import type { AdapterWarning } from '@trade-replay/adapters';
import { describe, expect, it } from 'vitest';
import type { EpisodeSummary, EpisodesResult } from './data';
import { FEATURED_TRADERS, formatFeaturedStat, summarise } from './featured';

const TRADER = FEATURED_TRADERS[0]!;

function episode(net: number): EpisodeSummary {
  return {
    replayId: `r${net}`,
    spark: [],
    instrument: 'HYPE-PERP',
    displayName: 'HYPE PERP',
    direction: 'long',
    openedAt: 0,
    closedAt: 1,
    peakSize: 1,
    avgEntry: 1,
    realizedPnl: net,
    totalFees: 0,
    totalFunding: 0,
    net,
    fillCount: 2,
    durationMs: 1,
  };
}

function result(
  episodes: EpisodeSummary[],
  warnings: AdapterWarning[] = [],
): Pick<EpisodesResult, 'episodes' | 'warnings'> {
  return { episodes, warnings };
}

describe('FEATURED_TRADERS', () => {
  it('holds lowercase 0x addresses, the form everything downstream is keyed on', () => {
    // parseInput lowercases, and the fill cache and replay ids are keyed on that form.
    // A checksummed address here would miss the cache on every load and build a URL that
    // disagrees with the one the address page normalises to.
    for (const trader of FEATURED_TRADERS) {
      expect(trader.address).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });

  it('names a venue the app actually supports', () => {
    for (const trader of FEATURED_TRADERS) {
      expect(trader.venue).toBe('hyperliquid');
    }
  });

  it('lists no address twice', () => {
    const seen = new Set(FEATURED_TRADERS.map((trader) => trader.address));
    expect(seen.size).toBe(FEATURED_TRADERS.length);
  });

  it('describes why each one is here without claiming a ranking', () => {
    // The note is editorial. A superlative would be a claim about a leaderboard we do
    // not read, and it would rot the moment the account had a bad month.
    for (const trader of FEATURED_TRADERS) {
      expect(trader.note.length).toBeGreaterThan(0);
      expect(trader.note).not.toMatch(/\b(best|top|highest|#1|number one)\b/i);
    }
  });
});

describe('summarise', () => {
  it('folds the net the same way the address page does', () => {
    const summary = summarise(TRADER, result([episode(100), episode(-30), episode(5)]));
    expect(summary?.positions).toBe(3);
    expect(summary?.net).toBeCloseTo(75, 9);
  });

  it('returns null for an account with nothing to show, rather than a row of zeroes', () => {
    // The rule the whole card is built around: an account we could not reconstruct is
    // not an account that broke even, and the caller drops the card instead of printing
    // $0.00 over a dead link.
    expect(summarise(TRADER, result([]))).toBeNull();
  });

  it('flags a truncated history, because the net is folded from a partial record', () => {
    const warning: AdapterWarning = {
      kind: 'fill_history_truncated',
      message: 'Fill history unavailable before …',
    };
    expect(summarise(TRADER, result([episode(10)], [warning]))?.truncated).toBe(true);
  });

  it('does not flag a different warning as truncation', () => {
    const warning: AdapterWarning = {
      kind: 'pagination_collision',
      message: 'A full page of fills all share one timestamp.',
    };
    expect(summarise(TRADER, result([episode(10)], [warning]))?.truncated).toBe(false);
  });

  it('carries the trader through unchanged, so the card links where the list says', () => {
    const summary = summarise(TRADER, result([episode(1)]));
    expect(summary?.address).toBe(TRADER.address);
    expect(summary?.venue).toBe(TRADER.venue);
    expect(summary?.note).toBe(TRADER.note);
  });
});

describe('formatFeaturedStat', () => {
  const base = { venue: 'hyperliquid', address: '0xa', note: 'n', truncated: false };

  it('signs the net so a gain never reads as a bare number', () => {
    expect(formatFeaturedStat({ ...base, positions: 3, net: 4320.22 })).toBe(
      '3 positions · +$4,320.22',
    );
    expect(formatFeaturedStat({ ...base, positions: 2, net: -18.5 })).toBe(
      '2 positions · -$18.50',
    );
  });

  it('says "1 position", not "1 positions"', () => {
    expect(formatFeaturedStat({ ...base, positions: 1, net: 0 })).toBe('1 position · $0.00');
  });
});
