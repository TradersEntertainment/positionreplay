/**
 * The whole leaderboard, for someone who wants to browse rather than glance.
 *
 * Server-rendered, unlike the landing page's panel: this page *is* the leaderboard, so
 * there is nothing to protect from a slow read, and a shareable URL that arrives with
 * its rows already in it beats one that arrives with a spinner.
 *
 * The window lives in the query string rather than in client state so the view is
 * linkable and survives a reload, which matches how `/` routes by GET form.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LEADERBOARD_WINDOWS, type LeaderboardWindow } from '@trade-replay/adapters';
import { LeaderboardTable } from '@/components/LeaderboardTable';
import { Notices } from '@/components/Notices';
import { leaderboardVenues, loadLeaderboard } from '@/lib/data';
import {
  LEADERBOARD_BASIS,
  LEADERBOARD_HISTORY_CAVEAT,
  availableWindows,
} from '@/lib/leaderboard';

export const dynamic = 'force-dynamic';

const WINDOW_LABELS: Record<LeaderboardWindow, string> = {
  day: '24 hours',
  week: 'week',
  month: 'month',
  allTime: 'all time',
};

/** A few letters naming the source in the column headers. */
function tagFor(venue: string): string {
  return venue === 'hyperliquid' ? 'HL' : venue.slice(0, 2).toUpperCase();
}

export default async function TopTraders({
  params,
  searchParams,
}: {
  params: Promise<{ venue: string }>;
  searchParams: Promise<{ window?: string }>;
}) {
  const { venue } = await params;
  const { window: asked } = await searchParams;

  // notFound rather than an empty page: a venue with no leaderboard has no board to
  // show, and a route that half-exists is worse than one that does not.
  if (!leaderboardVenues().some((option) => option.id === venue)) notFound();

  let result;
  try {
    result = await loadLeaderboard(venue);
  } catch (error) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <Header venue={venue} label={venue} />
        <p
          className="mt-6 border border-tr-notice/40 bg-tr-notice/10 p-4 text-sm text-tr-notice"
          data-testid="leaderboard-error"
        >
          This leaderboard is not answering right now —{' '}
          {error instanceof Error ? error.message : 'the venue could not be reached.'} It is an
          editorial endpoint the venue publishes at its own discretion, not part of the API this
          app replays from, so everything else still works.{' '}
          <Link href="/" className="underline">
            Paste an address instead
          </Link>
          .
        </p>
      </main>
    );
  }

  const offered = availableWindows(result.entries, LEADERBOARD_WINDOWS);
  const active: LeaderboardWindow =
    offered.find((option) => option === asked) ?? offered[0] ?? 'day';

  return (
    <main className="mx-auto max-w-4xl p-6">
      <Header venue={venue} label={result.label} />

      {/* Above the table on purpose: whose numbers these are has to be read before the
          numbers, not after them. The verify script asserts the order, not just that the
          sentence exists somewhere on the page. */}
      <p
        className="mt-4 border border-tr-notice/40 bg-tr-notice/10 p-3 text-xs text-tr-notice"
        data-testid="leaderboard-basis"
      >
        {LEADERBOARD_BASIS} {LEADERBOARD_HISTORY_CAVEAT}
      </p>

      {/* empty:hidden so the wrapper's margin disappears along with the notices. */}
      <div className="mt-4 empty:hidden">
        <Notices
          warnings={result.warnings}
          {...(result.provenanceWarning ? { provenanceWarning: result.provenanceWarning } : {})}
        />
      </div>

      {offered.length > 1 ? (
        <div className="mt-4 flex flex-wrap gap-2" data-testid="leaderboard-windows">
          {offered.map((option) => (
            <Link
              key={option}
              href={`/top/${venue}?window=${option}`}
              data-testid={`window-${option}`}
              aria-current={option === active ? 'page' : undefined}
              className={`border px-3 py-1 text-xs ${
                option === active
                  ? 'border-tr-up text-tr-up'
                  : 'border-tr-line text-tr-dim hover:border-tr-up'
              }`}
            >
              {WINDOW_LABELS[option]}
            </Link>
          ))}
        </div>
      ) : null}

      <div className="mt-4">
        <LeaderboardTable
          venue={venue}
          entries={result.entries}
          activeWindow={active}
          venueTag={tagFor(venue)}
        />
      </div>

      <p className="mt-4 text-xs text-tr-dim">
        Published by {result.label}, read at{' '}
        {new Date(result.fetchedAt).toISOString().slice(11, 16)} UTC.
      </p>
    </main>
  );
}

function Header({ venue, label }: { venue: string; label: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h1 className="text-2xl font-bold" data-testid="leaderboard-heading">
        Top traders on {label}
      </h1>
      <div className="flex gap-3 text-sm text-tr-dim">
        {leaderboardVenues()
          .filter((option) => option.id !== venue)
          .map((option) => (
            <Link key={option.id} href={`/top/${option.id}`} className="underline hover:text-tr-text">
              {option.label}
            </Link>
          ))}
        <Link href="/" className="underline hover:text-tr-text">
          paste an address
        </Link>
      </div>
    </div>
  );
}
