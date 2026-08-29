'use client';

/**
 * The front door: two real accounts, before anything is typed.
 *
 * Fetched from `/api/featured` after mount rather than server-rendered into the page. A
 * cold summary reconstructs thousands of fills per account, and putting that in front of
 * the landing page's first paint would mean a busy venue turns the front door into a
 * spinner. Here the worst case is that this one panel stays quiet and the address form,
 * the builder and the CSV drop zone are all already usable.
 *
 * Every figure on a card is **this app's own** — the same per-position fold the address
 * page shows, recomputed on each load. That is what makes a card safe where a hardcoded
 * number would not be: it can be wrong about a trade, but it cannot go stale. It is not
 * the venue's account PnL and the card does not imply it is.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatFeaturedStat, type FeaturedSummary } from '@/lib/featured';
import { shortAddress } from '@/lib/format';

type State =
  | { status: 'loading' }
  | { status: 'ready'; traders: FeaturedSummary[] }
  | { status: 'failed' };

export function FeaturedTraders() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    // Aborted on unmount so a slow venue cannot set state on a gone component, and so
    // navigating away actually cancels the request instead of leaving it in flight.
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch('/api/featured', { signal: controller.signal });
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { traders?: FeaturedSummary[] };
        setState({ status: 'ready', traders: body.traders ?? [] });
      } catch {
        if (controller.signal.aborted) return;
        setState({ status: 'failed' });
      }
    })();

    return () => controller.abort();
  }, []);

  // Nothing to show is not worth a panel explaining itself. The rest of the page is a
  // complete answer on its own, and an error box on the front door for an optional
  // convenience reads as the site being broken when it is not.
  if (state.status === 'failed') return null;
  if (state.status === 'ready' && state.traders.length === 0) return null;

  return (
    <section className="mt-6 border border-tr-up/40 bg-tr-up/5 p-4" data-testid="featured-panel">
      <p className="text-sm font-bold">Start with one of these</p>
      <p className="mt-1 text-xs text-tr-dim">
        Real accounts on Hyperliquid. The figures are this app&apos;s own reconstruction of
        their positions, not the numbers the venue publishes for the account.
      </p>

      {state.status === 'loading' ? (
        <p className="mt-3 text-xs text-tr-dim" data-testid="featured-loading">
          Reconstructing their positions…
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-3">
          {state.traders.map((trader) => (
            <Link
              key={trader.address}
              href={`/a/${trader.venue}/${trader.address}`}
              // No prefetch: each one would reconstruct the whole account server-side for
              // a card nobody clicked.
              prefetch={false}
              data-testid="featured-card"
              data-address={trader.address}
              data-net={trader.net}
              data-positions={trader.positions}
              className="min-w-56 flex-1 border border-tr-line bg-tr-panel p-3 hover:border-tr-up"
            >
              <span className="block text-sm font-bold">{shortAddress(trader.address)}</span>
              <span className="mt-1 block text-xs text-tr-dim">{trader.note}</span>
              <span
                className={`mt-2 block text-sm font-bold ${
                  trader.net >= 0 ? 'text-tr-up' : 'text-tr-down'
                }`}
              >
                {formatFeaturedStat(trader)}
              </span>
              {trader.truncated ? (
                // SPEC §4.3 serves only the most recent ~10,000 fills, and a busy account
                // is exactly the kind that hits it — so this net is folded from an
                // incomplete record, and §11 case 9 wants that said where it is read.
                <span
                  className="mt-1 block text-xs text-tr-notice"
                  data-testid="featured-truncated"
                >
                  PARTIAL HISTORY
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
