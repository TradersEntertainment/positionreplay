import type { LeaderboardEntry, LeaderboardWindow } from '@trade-replay/adapters';
import { describe, expect, it } from 'vitest';
import {
  UNAVAILABLE,
  availableWindows,
  formatAccountValue,
  formatLeaderboardPnl,
  formatRoi,
  hasRoi,
  performanceIn,
  sortEntries,
  traderLabel,
} from './leaderboard';

const ORDER: readonly LeaderboardWindow[] = ['day', 'week', 'month', 'allTime'];

function entry(
  address: string,
  overrides: Partial<LeaderboardEntry> = {},
): LeaderboardEntry {
  return {
    address,
    accountValue: 1000,
    performance: [{ window: 'day', pnl: 0 }],
    ...overrides,
  };
}

const short = (address: string): string => `${address.slice(0, 4)}…`;

describe('availableWindows', () => {
  it('offers only windows some row actually carries', () => {
    const entries = [
      entry('0xa', { performance: [{ window: 'day', pnl: 1 }] }),
      entry('0xb', { performance: [{ window: 'allTime', pnl: 2 }] }),
    ];
    expect(availableWindows(entries, ORDER)).toEqual(['day', 'allTime']);
  });

  it('keeps the canonical order rather than the order rows happen to list', () => {
    const entries = [
      entry('0xa', {
        performance: [
          { window: 'allTime', pnl: 1 },
          { window: 'day', pnl: 2 },
        ],
      }),
    ];
    expect(availableWindows(entries, ORDER)).toEqual(['day', 'allTime']);
  });

  it('offers nothing for an empty board rather than a row of dead tabs', () => {
    expect(availableWindows([], ORDER)).toEqual([]);
  });
});

describe('hasRoi', () => {
  it('is false when the venue published no ROI, so the column is dropped entirely', () => {
    expect(hasRoi([entry('0xa', { performance: [{ window: 'day', pnl: 5 }] })], 'day')).toBe(false);
  });

  it('is true when any row has one, and the rest show as unavailable', () => {
    const entries = [
      entry('0xa', { performance: [{ window: 'day', pnl: 5 }] }),
      entry('0xb', { performance: [{ window: 'day', pnl: 6, roi: 0.2 }] }),
    ];
    expect(hasRoi(entries, 'day')).toBe(true);
    expect(formatRoi(performanceIn(entries[0]!, 'day')?.roi)).toBe(UNAVAILABLE);
  });
});

describe('sortEntries', () => {
  const board = [
    entry('0xa', { performance: [{ window: 'day', pnl: 100 }] }),
    entry('0xb', { performance: [{ window: 'day', pnl: 300 }] }),
    entry('0xc', { performance: [{ window: 'day', pnl: 200 }] }),
  ];

  it('orders by the window figure in both directions', () => {
    expect(sortEntries(board, 'pnl', 'desc', 'day').map((e) => e.address)).toEqual([
      '0xb',
      '0xc',
      '0xa',
    ]);
    expect(sortEntries(board, 'pnl', 'asc', 'day').map((e) => e.address)).toEqual([
      '0xa',
      '0xc',
      '0xb',
    ]);
  });

  it("defaults to the venue's own order, not one we computed", () => {
    expect(sortEntries(board, 'rank', 'asc', 'day').map((e) => e.address)).toEqual([
      '0xa',
      '0xb',
      '0xc',
    ]);
  });

  it('puts an unpublished figure last in BOTH directions, never among the flat ones', () => {
    // The rule this whole module exists for. A trader whose PnL the venue did not
    // publish is not a trader who broke even, and sorting them as a zero would file
    // them mid-table where nobody would think to question the number.
    const withGap = [
      entry('0xa', { performance: [{ window: 'day', pnl: 100 }] }),
      entry('0xgap', { performance: [] }),
      entry('0xb', { performance: [{ window: 'day', pnl: -100 }] }),
    ];
    expect(sortEntries(withGap, 'pnl', 'desc', 'day').at(-1)!.address).toBe('0xgap');
    expect(sortEntries(withGap, 'pnl', 'asc', 'day').at(-1)!.address).toBe('0xgap');
  });

  it('breaks ties on the venue order, so re-sorting is stable', () => {
    const tied = [
      entry('0xa', { performance: [{ window: 'day', pnl: 5 }] }),
      entry('0xb', { performance: [{ window: 'day', pnl: 5 }] }),
      entry('0xc', { performance: [{ window: 'day', pnl: 5 }] }),
    ];
    expect(sortEntries(tied, 'pnl', 'desc', 'day').map((e) => e.address)).toEqual([
      '0xa',
      '0xb',
      '0xc',
    ]);
    expect(sortEntries(tied, 'pnl', 'asc', 'day').map((e) => e.address)).toEqual([
      '0xa',
      '0xb',
      '0xc',
    ]);
  });

  it('does not mutate the board it was given', () => {
    const original = board.map((e) => e.address);
    sortEntries(board, 'pnl', 'desc', 'day');
    expect(board.map((e) => e.address)).toEqual(original);
  });
});

describe('formatters', () => {
  it('never prints an unavailable figure as a number', () => {
    // The single assertion that would have caught the bug this module is defending
    // against: an undefined running through a currency formatter comes out $0.00 and
    // reads as a measurement.
    expect(formatLeaderboardPnl(undefined)).toBe(UNAVAILABLE);
    expect(formatAccountValue(undefined)).toBe(UNAVAILABLE);
    expect(formatRoi(undefined)).toBe(UNAVAILABLE);
    for (const rendered of [
      formatLeaderboardPnl(undefined),
      formatAccountValue(undefined),
      formatRoi(undefined),
    ]) {
      expect(rendered).not.toMatch(/\d/);
    }
  });

  it('signs a PnL so a gain never reads as a bare number', () => {
    expect(formatLeaderboardPnl(1234.5)).toBe('+$1,234.50');
    expect(formatLeaderboardPnl(-1234.5)).toBe('-$1,234.50');
    expect(formatLeaderboardPnl(0)).toBe('$0.00');
  });

  it('turns the DTO fraction into a percentage exactly once', () => {
    expect(formatRoi(0.4237)).toBe('+42.4%');
    expect(formatRoi(-0.05)).toBe('-5.0%');
    expect(formatRoi(0)).toBe('0.0%');
  });

  it('leaves an account value unsigned — it is a balance, not a change', () => {
    expect(formatAccountValue(9_500_000)).toBe('$9,500,000.00');
  });
});

describe('traderLabel', () => {
  it("uses the venue's own name when it published one", () => {
    expect(traderLabel(entry('0xabcdef', { displayName: 'whale' }), short)).toBe('whale');
  });

  it('falls back to the address rather than inventing a name', () => {
    expect(traderLabel(entry('0xabcdef'), short)).toBe('0xab…');
  });

  it('treats a blank name as no name', () => {
    expect(traderLabel(entry('0xabcdef', { displayName: '   ' }), short)).toBe('0xab…');
  });
});
