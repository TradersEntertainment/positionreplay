/**
 * Turning a venue's leaderboard into a table, without inventing anything.
 *
 * Extracted from the component because `vitest.config.ts` only collects
 * `apps/web/lib/**`, and every rule in here is one that would be a wrong number on a
 * page if it were wrong: which columns exist at all, where a missing figure sorts, and
 * what a missing figure prints. A rule worth stating is a rule worth asserting.
 *
 * The whole file exists to defend one line of CLAUDE.md — "No fabricated numbers … If a
 * value is unavailable, show it as unavailable" — against the two ways a table quietly
 * breaks it: a formatter that renders `undefined` as `$0.00`, and a sort that treats it
 * as zero and files a trader we know nothing about in among the flat ones.
 */

import type {
  LeaderboardEntry,
  LeaderboardWindow,
  LeaderboardWindowPerformance,
} from '@trade-replay/adapters';
import { formatSignedUsd, formatUsd } from './format';

/** What a cell shows when the venue did not publish the figure. */
export const UNAVAILABLE = '—';

export type LeaderboardSortKey = 'rank' | 'pnl' | 'roi' | 'accountValue';

/** The window's row for this trader, or undefined when the venue reported none. */
export function performanceIn(
  entry: LeaderboardEntry,
  window: LeaderboardWindow,
): LeaderboardWindowPerformance | undefined {
  return entry.performance.find((row) => row.window === window);
}

/**
 * The windows any row actually carries, in the canonical order.
 *
 * Derived rather than declared, for the same reason `buildableVenues()` is: a window the
 * venue stopped publishing should stop being offered, and a tab that leads to an empty
 * column is worse than no tab. Order comes from the constant so the tabs do not reshuffle
 * when a window happens to be missing from the first row.
 */
export function availableWindows(
  entries: readonly LeaderboardEntry[],
  order: readonly LeaderboardWindow[],
): LeaderboardWindow[] {
  return order.filter((window) => entries.some((entry) => performanceIn(entry, window)));
}

/** True when at least one row has an ROI for this window — otherwise the column is dropped. */
export function hasRoi(entries: readonly LeaderboardEntry[], window: LeaderboardWindow): boolean {
  return entries.some((entry) => performanceIn(entry, window)?.roi !== undefined);
}

/** The sortable value for a row, or undefined when the venue published none. */
function valueFor(
  entry: LeaderboardEntry,
  key: LeaderboardSortKey,
  window: LeaderboardWindow,
  rank: number,
): number | undefined {
  if (key === 'rank') return rank;
  if (key === 'accountValue') return entry.accountValue;
  return performanceIn(entry, window)?.[key === 'pnl' ? 'pnl' : 'roi'];
}

/**
 * Sorted rows, with unknown values last in **both** directions.
 *
 * Not zero. A trader whose PnL the venue did not publish is not a trader who broke even,
 * and sorting them as though they were would file them in the middle of the table where
 * nobody would think to question the number. Last in both directions is the only
 * placement that never reads as a claim.
 *
 * `rank` is the venue's own ordering, carried as the array index — never a ranking we
 * computed from a metric we picked.
 */
export function sortEntries(
  entries: readonly LeaderboardEntry[],
  key: LeaderboardSortKey,
  direction: 'asc' | 'desc',
  window: LeaderboardWindow,
): LeaderboardEntry[] {
  const ranked = entries.map((entry, index) => ({ entry, rank: index + 1 }));

  ranked.sort((a, b) => {
    const left = valueFor(a.entry, key, window, a.rank);
    const right = valueFor(b.entry, key, window, b.rank);

    if (left === undefined && right === undefined) return a.rank - b.rank;
    if (left === undefined) return 1;
    if (right === undefined) return -1;

    // Ties break on the venue's own order, so a re-sort is stable and reproducible.
    if (left === right) return a.rank - b.rank;
    return direction === 'desc' ? right - left : left - right;
  });

  return ranked.map((row) => row.entry);
}

export function formatLeaderboardPnl(value: number | undefined): string {
  return value === undefined ? UNAVAILABLE : formatSignedUsd(value);
}

export function formatAccountValue(value: number | undefined): string {
  return value === undefined ? UNAVAILABLE : formatUsd(value);
}

/**
 * ROI as a signed percentage.
 *
 * The DTO carries a fraction, so the ×100 happens exactly once, here. A venue that
 * reports percentages is converted at the adapter boundary rather than by teaching this
 * function about vendors.
 */
export function formatRoi(value: number | undefined): string {
  if (value === undefined) return UNAVAILABLE;
  const percent = value * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

/**
 * The two things a leaderboard has to say out loud, in one place so both the landing
 * panel and the full page say them identically.
 *
 * The first is CLAUDE.md's no-fabricated-numbers rule applied to someone else's numbers:
 * a venue's figure, attributed, is fine; the same figure presented as ours is not. And
 * they genuinely will not agree — a leaderboard ranks an account, this app reconstructs
 * one position at a time.
 *
 * The second is SPEC §11 case 9 said *before* the click instead of only after it. A
 * leaderboard sends people to the highest-volume accounts on the venue, which are
 * exactly the ones whose history hits the API ceiling, so the warning on the next page
 * should read as a known limit rather than as our bug.
 */
export const LEADERBOARD_BASIS =
  'These are the venue\u2019s own account-level figures for the whole account. This app\u2019s ' +
  'numbers are per-position and reconstructed from fills, so the two measure different ' +
  'things and will not add up.';

export const LEADERBOARD_HISTORY_CAVEAT =
  'Ranked traders are high-volume accounts, and a venue only serves so much history. ' +
  'Where it runs out, the position list says so.';

/** How a trader is named: what the venue calls them, else the address, shortened. */
export function traderLabel(entry: LeaderboardEntry, short: (address: string) => string): string {
  const named = entry.displayName?.trim();
  return named ? named : short(entry.address);
}
