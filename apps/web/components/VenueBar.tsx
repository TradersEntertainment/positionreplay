/**
 * The supported-venue strip at the top of every page.
 *
 * Two rules shape it.
 *
 * SPEC §7.3 — "no gradients, no rounded corners, no shadows. It should look like a
 * terminal, not a dashboard." So the marks are drawn here as flat geometry in the site's
 * own palette rather than being venue brand logos. That is also why they are not brand
 * logos in the licensing sense: dropping four third-party trademark files into the repo
 * is a decision for whoever owns this project, not one to make while wiring a header,
 * and a full-colour logo row would fight the terminal palette anyway. Each mark is one
 * small component, so swapping in an official asset later is a one-file change.
 *
 * CLAUDE.md's honesty rule, applied to the header: a venue is shown as live only if the
 * adapter registry actually has an adapter for it. `SUPPORTED_VENUES` is the source of
 * that, so a venue cannot be advertised here and then fail when someone clicks it —
 * which is exactly what a hand-maintained list would eventually do.
 */

import { SUPPORTED_VENUES, VENUE_LABELS } from '@trade-replay/adapters';
import { buildCommit } from '../lib/build';
import type { ReactNode } from 'react';
import Link from 'next/link';

/**
 * Venues we intend to support, in the order they appear.
 *
 * Listing one that is not built is deliberate and safe *because* the live/soon state is
 * derived rather than written here: `PLANNED` says what exists in the world, the
 * registry says what works today, and the two cannot drift apart.
 */
const PLANNED = ['hyperliquid', 'polymarket-perps', 'lighter', 'aster', 'csv'] as const;

/** Labels for venues that have no adapter yet, so no registry entry to read one from. */
const PLANNED_LABELS: Record<string, string> = {
  lighter: 'Lighter',
  aster: 'Aster',
};

function isLive(venue: string): boolean {
  return (SUPPORTED_VENUES as readonly string[]).includes(venue);
}

/**
 * The marks. 24x24, `currentColor`, straight segments only.
 *
 * `shapeRendering="crispEdges"` because the rest of the page is hairline borders on a
 * near-black background; an antialiased 1px stroke reads as grey mush next to them.
 */
function Mark({ venue }: { venue: string }): ReactNode {
  const common = {
    viewBox: '0 0 24 24',
    width: 20,
    height: 20,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    'aria-hidden': true,
  } as const;

  switch (venue) {
    // A bolt in straight segments — the venue's own mark is a single angular stroke.
    case 'hyperliquid':
      return (
        <svg {...common}>
          <path d="M13 2 L4 14 H11 L10 22 L19 10 H12 Z" />
        </svg>
      );
    // A square split on the diagonal: a binary market is one box with two sides.
    case 'polymarket-perps':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" />
          <path d="M3 21 L21 3" />
        </svg>
      );
    // A beam: one upright, three rays.
    case 'lighter':
      return (
        <svg {...common}>
          <path d="M12 3 V21" />
          <path d="M5 8 H9 M15 8 H19 M5 16 H9 M15 16 H19" />
        </svg>
      );
    // An asterisk. "Aster" is Greek for star, so for once the obvious mark is the right
    // one rather than a pun on the name.
    case 'aster':
      return (
        <svg {...common}>
          <path d="M12 3 V21 M4 7 L20 17 M20 7 L4 17" />
        </svg>
      );
    // A sheet with the corner cut, and rows. The cut is a straight bevel, not a curl.
    default:
      return (
        <svg {...common}>
          <path d="M5 3 H15 L19 7 V21 H5 Z" />
          <path d="M8 12 H16 M8 16 H16" />
        </svg>
      );
  }
}

function VenueChip({ venue }: { venue: string }): ReactNode {
  const live = isLive(venue);
  const label = VENUE_LABELS[venue] ?? PLANNED_LABELS[venue] ?? venue;

  const body = (
    <>
      <Mark venue={venue} />
      <span className="text-xs">{label}</span>
      {live ? null : (
        // Said in words, not encoded in the colour alone: a dimmed chip is not a
        // readable "we have not built this yet" for anyone who cannot see the contrast.
        <span className="text-[10px] tracking-wider text-tr-notice">SOON</span>
      )}
    </>
  );

  const shared = 'flex items-center gap-2 border px-2 py-1';

  // A chip that leads nowhere should not look clickable, and a planned venue leads
  // nowhere. Only the live ones are links.
  return live && venue !== 'csv' ? (
    <Link
      href={`/?venue=${venue}`}
      data-testid={`venue-chip-${venue}`}
      data-venue-state="live"
      className={`${shared} border-tr-line text-tr-text hover:border-tr-up`}
    >
      {body}
    </Link>
  ) : (
    <span
      data-testid={`venue-chip-${venue}`}
      data-venue-state={live ? 'live' : 'planned'}
      className={`${shared} ${live ? 'border-tr-line text-tr-text' : 'border-tr-line/50 text-tr-dim'}`}
    >
      {body}
    </span>
  );
}

export function VenueBar(): ReactNode {
  const commit = buildCommit();

  return (
    <header className="border-b border-tr-line" data-testid="venue-bar">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-8 py-3">
        <Link href="/" className="text-sm font-bold hover:text-tr-up">
          trade-replay
        </Link>
        <span className="text-xs text-tr-dim">supports</span>
        {PLANNED.map((venue) => (
          <VenueChip key={venue} venue={venue} />
        ))}
        <Link
          href="/build"
          data-testid="header-build-link"
          className="border border-tr-line px-2 py-1 text-xs hover:border-tr-up"
        >
          Build
        </Link>
        {commit ? (
          // Pushed to the right, dim, out of the way. It answers "is my change live?"
          // without being something a visitor has to read.
          <span className="ml-auto text-[10px] text-tr-dim" data-testid="build-commit">
            build {commit}
          </span>
        ) : null}
      </div>
    </header>
  );
}
