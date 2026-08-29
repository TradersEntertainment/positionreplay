'use client';

/**
 * A venue's leaderboard, as a way in.
 *
 * The same table idiom as `EpisodeTable` — client-side sorting over already-loaded rows,
 * uppercase dim headers, right-aligned numbers — with three differences that all come
 * from the same fact: **these are the venue's numbers, not ours.**
 *
 *  - The column headers name the source ("HL PNL", not "PNL"). The attribution belongs
 *    where the number is read, not only in a caption someone scrolls past.
 *  - A column appears only if some row actually carries it, and a cell the venue did not
 *    publish reads as a dash. Both rules live in lib/leaderboard.ts, where they are
 *    tested; `$0.00` for "unknown" is the failure this component is shaped to avoid.
 *  - The rank column is the venue's own ordering, carried as the array index. We never
 *    rank anyone by a metric we chose.
 *
 * The whole table scrolls inside its own container rather than dropping columns on a
 * phone: a hidden number is a worse answer than a sideways swipe, and SPEC §13 asks only
 * that mobile not be broken.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { LeaderboardEntry, LeaderboardWindow } from '@trade-replay/adapters';
import {
  formatAccountValue,
  formatLeaderboardPnl,
  formatRoi,
  hasRoi,
  performanceIn,
  sortEntries,
  traderLabel,
  type LeaderboardSortKey,
} from '@/lib/leaderboard';
import { shortAddress } from '@/lib/format';

type Direction = 'asc' | 'desc';

export interface LeaderboardTableProps {
  venue: string;
  entries: LeaderboardEntry[];
  activeWindow: LeaderboardWindow;
  /** Short label for the venue, for the column headers that name the source. */
  venueTag: string;
}

export function LeaderboardTable({ venue, entries, activeWindow, venueTag }: LeaderboardTableProps) {
  const [sortKey, setSortKey] = useState<LeaderboardSortKey>('rank');
  const [direction, setDirection] = useState<Direction>('asc');

  const showRoi = useMemo(() => hasRoi(entries, activeWindow), [entries, activeWindow]);
  const sorted = useMemo(
    () => sortEntries(entries, sortKey, direction, activeWindow),
    [entries, sortKey, direction, activeWindow],
  );

  // The venue's own position, fixed before any sort so a re-sort never renumbers anyone.
  const rankOf = useMemo(() => {
    const ranks = new Map<string, number>();
    entries.forEach((entry, index) => ranks.set(entry.address, index + 1));
    return ranks;
  }, [entries]);

  const toggle = (key: LeaderboardSortKey): void => {
    if (key === sortKey) {
      setDirection(direction === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortKey(key);
    // Rank reads best smallest-first; every figure reads best biggest-first.
    setDirection(key === 'rank' ? 'asc' : 'desc');
  };

  const columns: { key: LeaderboardSortKey; label: string; align: 'left' | 'right' }[] = [
    { key: 'accountValue', label: `${venueTag} ACCOUNT`, align: 'right' },
    { key: 'pnl', label: `${venueTag} PNL`, align: 'right' },
    ...(showRoi ? [{ key: 'roi' as const, label: `${venueTag} ROI`, align: 'right' as const }] : []),
  ];

  if (entries.length === 0) {
    return (
      <p className="border border-tr-line p-4 text-sm text-tr-dim" data-testid="leaderboard-empty">
        No leaderboard rows came back.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" data-testid="leaderboard-table">
        <thead>
          <tr className="border-b border-tr-line text-xs text-tr-dim">
            <th className="p-2 text-left font-normal">
              <button
                type="button"
                onClick={() => toggle('rank')}
                data-testid="sort-rank"
                aria-sort={
                  sortKey === 'rank' ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
                }
                className={`hover:text-tr-text ${sortKey === 'rank' ? 'text-tr-up' : ''}`}
              >
                #{sortKey === 'rank' ? (direction === 'asc' ? ' ↑' : ' ↓') : ''}
              </button>
            </th>
            <th className="p-2 text-left font-normal">TRADER</th>
            {columns.map((column) => (
              <th key={column.key} className="p-2 text-right font-normal whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => toggle(column.key)}
                  data-testid={`sort-${column.key}`}
                  aria-sort={
                    sortKey === column.key
                      ? direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  className={`hover:text-tr-text ${sortKey === column.key ? 'text-tr-up' : ''}`}
                >
                  {column.label}
                  {sortKey === column.key ? (direction === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              </th>
            ))}
            <th className="p-2" />
          </tr>
        </thead>

        <tbody data-testid="leaderboard-rows">
          {sorted.map((entry) => {
            const performance = performanceIn(entry, activeWindow);
            const pnl = performance?.pnl;
            const rank = rankOf.get(entry.address) ?? 0;

            return (
              <tr
                key={entry.address}
                className="border-b border-tr-line/50 hover:bg-tr-panel"
                data-testid="leaderboard-row"
                data-rank={rank}
                data-address={entry.address}
                // Absent, not zero, when the venue published nothing — the verify script
                // asserts that a row without this attribute renders a dash.
                {...(pnl === undefined ? {} : { 'data-pnl': pnl })}
                {...(performance?.roi === undefined ? {} : { 'data-roi': performance.roi })}
              >
                <td className="p-2 text-tr-dim">{rank}</td>
                <td className="p-2 font-bold whitespace-nowrap">
                  {traderLabel(entry, shortAddress)}
                  {entry.isVault ? (
                    <span className="ml-2 text-xs font-normal text-tr-notice">VAULT</span>
                  ) : null}
                </td>
                <td className="p-2 text-right whitespace-nowrap text-tr-dim">
                  {formatAccountValue(entry.accountValue)}
                </td>
                <td
                  className={`p-2 text-right font-bold whitespace-nowrap ${
                    pnl === undefined ? 'text-tr-dim' : pnl >= 0 ? 'text-tr-up' : 'text-tr-down'
                  }`}
                >
                  {formatLeaderboardPnl(pnl)}
                </td>
                {showRoi ? (
                  <td className="p-2 text-right whitespace-nowrap text-tr-dim">
                    {formatRoi(performance?.roi)}
                  </td>
                ) : null}
                <td className="p-2 text-right">
                  <Link
                    href={`/a/${venue}/${entry.address}`}
                    // No prefetch, doubly: each one would reconstruct up to ten thousand
                    // fills and fetch candles, server-side, for a row nobody clicked.
                    prefetch={false}
                    data-testid="leaderboard-link"
                    className="border border-tr-line px-2 py-1 text-xs hover:border-tr-up"
                  >
                    positions
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
