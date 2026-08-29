'use client';

/**
 * The front door: a handful of real traders, on the landing page, before anything is typed.
 *
 * Fetched from `/api/leaderboard` after mount rather than server-rendered into the page.
 * A cold leaderboard read is megabytes from a third-party host that publishes no uptime
 * promise, and putting it in front of the first paint would mean the venue having a bad
 * afternoon turns our front door into a spinner. Here, the worst case is that this one
 * panel resolves into a sentence and everything else on the page is already usable.
 *
 * For the same reason the failure state is a notice, not the red panel the address page
 * uses: a leaderboard is an editorial endpoint, not a documented API, and a red crash
 * box for someone else's optional feature reads as our bug.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LEADERBOARD_WINDOWS, type LeaderboardEntry, type LeaderboardWindow } from '@trade-replay/adapters';
import { LeaderboardTable } from '@/components/LeaderboardTable';
import { LEADERBOARD_BASIS, availableWindows } from '@/lib/leaderboard';

export interface LeaderboardPanelProps {
  venue: string;
  label: string;
  /** Short tag for the column headers that name the source, e.g. "HL". */
  venueTag: string;
  rows: number;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; entries: LeaderboardEntry[] }
  | { status: 'failed'; message: string };

export function LeaderboardPanel({ venue, label, venueTag, rows }: LeaderboardPanelProps) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    // Aborted on unmount so a slow venue cannot set state on a gone component, and so
    // navigating away actually cancels the request rather than leaving it in flight.
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(
          `/api/leaderboard?venue=${encodeURIComponent(venue)}&limit=${rows}`,
          { signal: controller.signal },
        );
        const body = (await response.json()) as { entries?: LeaderboardEntry[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `The venue answered ${response.status}.`);
        setState({ status: 'ready', entries: body.entries ?? [] });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          status: 'failed',
          message: error instanceof Error ? error.message : 'Could not reach the venue.',
        });
      }
    })();

    return () => controller.abort();
  }, [venue, rows]);

  const entries = state.status === 'ready' ? state.entries : [];
  const windows = availableWindows(entries, LEADERBOARD_WINDOWS);
  const active: LeaderboardWindow = windows[0] ?? 'day';

  return (
    <section className="mt-6 border border-tr-up/40 bg-tr-up/5 p-4" data-testid="leaderboard-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold">Top traders on {label}</p>
        <Link
          href={`/top/${venue}`}
          data-testid="leaderboard-all-link"
          className="text-xs text-tr-dim underline hover:text-tr-text"
        >
          see the whole board
        </Link>
      </div>

      {state.status === 'loading' ? (
        <p className="mt-3 text-xs text-tr-dim" data-testid="leaderboard-loading">
          Reading {label}&apos;s leaderboard…
        </p>
      ) : null}

      {state.status === 'failed' ? (
        <p
          className="mt-3 border border-tr-notice/40 bg-tr-notice/10 p-2 text-xs text-tr-notice"
          data-testid="leaderboard-error"
        >
          {label}&apos;s leaderboard is not answering right now — {state.message} You can still
          paste an address below.
        </p>
      ) : null}

      {state.status === 'ready' && entries.length > 0 ? (
        <>
          <div className="mt-3">
            <LeaderboardTable
              venue={venue}
              entries={entries}
              activeWindow={active}
              venueTag={venueTag}
            />
          </div>
          <p className="mt-2 text-xs text-tr-dim" data-testid="leaderboard-basis">
            {LEADERBOARD_BASIS}
          </p>
        </>
      ) : null}

      {state.status === 'ready' && entries.length === 0 ? (
        <p className="mt-3 text-xs text-tr-dim" data-testid="leaderboard-empty">
          {label} returned no leaderboard rows.
        </p>
      ) : null}
    </section>
  );
}
