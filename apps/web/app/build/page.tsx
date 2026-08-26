/**
 * `/build` — a position typed by hand, replayed against the venue's real candles.
 *
 * Only venues whose adapter can list its own markets appear: a picker that cannot be
 * populated is not a choice, and typing an instrument key by hand is not a feature.
 */

import { PositionBuilder } from '@/components/PositionBuilder';
import { buildableVenues } from '@/lib/data';

export const dynamic = 'force-dynamic';

export default function BuildPage() {
  const venues = buildableVenues();

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold">Build a position</h1>
      <p className="mt-1 text-sm text-tr-dim">
        Pick a market, type the entries and exits, and watch it play against the venue&apos;s
        real chart.
      </p>

      <p
        className="mt-4 border border-tr-notice/40 bg-tr-notice/10 p-3 text-xs text-tr-notice"
        data-testid="constructed-warning"
      >
        <span className="font-bold">This is not a real trade.</span> The prices are the
        venue&apos;s, the position is yours to invent. Anything you export is stamped
        CONSTRUCTED in the image itself, and fees are shown as unavailable rather than as
        zero — nothing was paid, but a real trade would have paid something.
      </p>

      {venues.length === 0 ? (
        <p className="mt-6 text-sm text-tr-down">No venue here can list its own markets.</p>
      ) : (
        <div className="mt-6">
          <PositionBuilder venues={venues} />
        </div>
      )}
    </main>
  );
}
