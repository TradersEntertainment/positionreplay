'use client';

/**
 * SPEC §8 `/a/[venue]/[address]`: "table of reconstructed episodes, sortable by
 * PnL / duration / size / date. Sparkline per row. Clicking one opens the player."
 *
 * Sorting is client-side: the rows are already loaded, so a sort must not cost a round
 * trip to the venue.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { EpisodeSummary } from '@/lib/data';
import { Sparkline } from '@/components/Sparkline';
import { formatDate, formatDuration, formatPrice, formatSize, formatUsd } from '@/lib/format';

type SortKey = 'date' | 'pnl' | 'duration' | 'size';
type Direction = 'asc' | 'desc';

const COLUMNS: { key: SortKey; label: string; align: 'left' | 'right' }[] = [
  { key: 'date', label: 'OPENED', align: 'left' },
  { key: 'duration', label: 'HELD', align: 'right' },
  { key: 'size', label: 'PEAK', align: 'right' },
  { key: 'pnl', label: 'NET', align: 'right' },
];

function valueFor(episode: EpisodeSummary, key: SortKey, now: number): number {
  switch (key) {
    case 'pnl':
      return episode.net;
    case 'duration':
      return (episode.closedAt ?? now) - episode.openedAt;
    case 'size':
      return episode.peakSize;
    case 'date':
      return episode.openedAt;
  }
}

export function EpisodeTable({ episodes }: { episodes: EpisodeSummary[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [direction, setDirection] = useState<Direction>('desc');

  const sorted = useMemo(() => {
    const now = Date.now();
    const factor = direction === 'asc' ? 1 : -1;
    return [...episodes].sort((a, b) => {
      const delta = valueFor(a, sortKey, now) - valueFor(b, sortKey, now);
      // Ties fall back to open time so the order is stable and reproducible.
      return delta !== 0 ? delta * factor : (a.openedAt - b.openedAt) * factor;
    });
  }, [episodes, sortKey, direction]);

  const toggle = (key: SortKey): void => {
    if (key === sortKey) setDirection(direction === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      // Biggest first is what someone scanning a PnL or size column wants.
      setDirection(key === 'date' ? 'desc' : 'desc');
    }
  };

  return (
    <table className="w-full border-collapse text-sm" data-testid="episode-table">
      <thead>
        <tr className="border-b border-tr-line text-xs text-tr-dim">
          <th className="p-2 text-left font-normal">INSTRUMENT</th>
          <th className="p-2 text-left font-normal">DIR</th>
          <th className="p-2 text-left font-normal">PATH</th>
          {COLUMNS.map((column) => (
            <th
              key={column.key}
              className={`p-2 font-normal ${column.align === 'right' ? 'text-right' : 'text-left'}`}
            >
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

      <tbody data-testid="episode-rows">
        {sorted.map((episode) => (
          <tr
            key={episode.replayId}
            className="border-b border-tr-line/50 hover:bg-tr-panel"
            data-testid="episode-row"
            data-net={episode.net}
            data-opened={episode.openedAt}
            data-peak={episode.peakSize}
            data-duration={(episode.closedAt ?? Date.now()) - episode.openedAt}
          >
            <td className="p-2 font-bold">{episode.displayName}</td>
            <td
              className={`p-2 ${episode.direction === 'long' ? 'text-tr-up' : 'text-tr-down'}`}
            >
              {episode.direction === 'long' ? 'LONG' : 'SHORT'}
            </td>
            <td className="p-2">
              <Sparkline points={episode.spark} positive={episode.net >= 0} />
            </td>
            <td className="p-2 text-tr-dim">{formatDate(episode.openedAt)}</td>
            <td className="p-2 text-right text-tr-dim">
              {episode.closedAt === null ? (
                <span className="text-tr-notice">OPEN</span>
              ) : (
                formatDuration(episode.closedAt - episode.openedAt)
              )}
            </td>
            <td className="p-2 text-right text-tr-dim">
              {formatSize(episode.peakSize)}
              <span className="ml-2 text-tr-dim/60">@ {formatPrice(episode.avgEntry)}</span>
            </td>
            <td
              className={`p-2 text-right font-bold ${episode.net >= 0 ? 'text-tr-up' : 'text-tr-down'}`}
            >
              {formatUsd(episode.net)}
            </td>
            <td className="p-2 text-right">
              <Link
                href={`/r/${episode.replayId}`}
                // No prefetch: each one would run a full replay load server-side.
                prefetch={false}
                data-testid="episode-link"
                className="border border-tr-line px-2 py-1 text-xs hover:border-tr-up"
              >
                replay
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
