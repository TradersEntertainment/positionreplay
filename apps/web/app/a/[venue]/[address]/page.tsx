/** SPEC §8 `/a/[venue]/[address]` — the episode browser. */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EpisodeTable } from '@/components/EpisodeTable';
import { Notices } from '@/components/Notices';
import { isSupportedVenue, VENUE_LABELS } from '@trade-replay/adapters';
import { loadEpisodes } from '@/lib/data';
import { formatUsd, shortAddress } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function AddressPage({
  params,
}: {
  params: Promise<{ venue: string; address: string }>;
}) {
  const { venue, address } = await params;
  // An unknown venue is a 404 rather than a broken page.
  if (!isSupportedVenue(venue)) notFound();

  let result;
  try {
    result = await loadEpisodes(venue, decodeURIComponent(address));
  } catch (error) {
    return (
      <main className="mx-auto max-w-6xl p-6">
        <Header venue={venue} address={address} />
        <p className="mt-6 border border-tr-down/40 bg-tr-down/10 p-4 text-sm text-tr-down">
          {error instanceof Error ? error.message : 'Could not load this address.'}
        </p>
      </main>
    );
  }

  const net = result.episodes.reduce((sum, episode) => sum + episode.net, 0);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <Header venue={venue} address={result.address} />

      <div className="mt-4 space-y-4">
        {result.limitation ? (
          <p
            className="border border-tr-notice/40 bg-tr-notice/10 p-3 text-xs text-tr-notice"
            data-testid="venue-limitation"
          >
            <span className="font-bold">{result.limitation.title}</span> —{' '}
            {result.limitation.detail}
          </p>
        ) : null}

        <Notices warnings={result.warnings} provenanceWarning={result.provenanceWarning} />

        {result.episodes.length === 0 ? (
          <div className="border border-tr-line p-4 text-sm">
            <p>No fills found for {result.address}.</p>
            <p className="mt-2 text-tr-dim">
              If this address definitely trades, check that it is the MAIN account and not an
              agent/API wallet — those return empty data.
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs text-tr-dim" data-testid="summary">
              {result.episodes.length} episodes · net{' '}
              <span className={net >= 0 ? 'text-tr-up' : 'text-tr-down'}>{formatUsd(net)}</span> ·{' '}
              {result.label}
            </p>
            <EpisodeTable episodes={result.episodes} />
          </>
        )}
      </div>
    </main>
  );
}

function Header({ venue, address }: { venue: string; address: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold" data-testid="address-heading">
          {shortAddress(address)}
        </h1>
        <p className="mt-1 text-xs text-tr-dim">{VENUE_LABELS[venue] ?? venue}</p>
      </div>
      <Link href="/" className="text-xs text-tr-dim underline hover:text-tr-text">
        new address
      </Link>
    </div>
  );
}
