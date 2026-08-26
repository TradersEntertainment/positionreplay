/**
 * SPEC §8 `/` — the address input.
 *
 * The episode list here is navigation only: enough to reach the player. The *episode
 * browser* (sortable table, per-row sparklines, the caching layer) is M4, and building
 * it now would be starting a milestone before this one is demoable.
 */

import Link from 'next/link';
import { loadEpisodes } from '@/lib/data';
import { Notices } from '@/components/Notices';
import { formatDate, formatDuration, formatSize, formatUsd } from '@/lib/format';

export const dynamic = 'force-dynamic';

const EXAMPLE = '0x393d0b87ed38fc779fd9611144ae649ba6082109';

async function EpisodeList({ address }: { address: string }) {
  let result;
  try {
    result = await loadEpisodes(address);
  } catch (error) {
    return (
      <p className="border border-tr-down/40 bg-tr-down/10 p-4 text-sm text-tr-down">
        {error instanceof Error ? error.message : 'Could not load this address.'}
      </p>
    );
  }

  if (result.episodes.length === 0) {
    return (
      <div className="border border-tr-line p-4 text-sm">
        <p>No fills found for {result.address}.</p>
        <p className="mt-2 text-tr-dim">
          If this address definitely trades, check that it is the MAIN account and not an
          agent/API wallet — those return empty data.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-tr-dim">
        {result.episodes.length} episodes · {result.label}
      </p>

      <Notices warnings={result.warnings} provenanceWarning={result.provenanceWarning} />

      <ul className="divide-y divide-tr-line border border-tr-line">
        {result.episodes.map((episode) => (
          <li key={episode.replayId}>
            <Link
              href={`/r/${episode.replayId}`}
              // Prefetch is off deliberately. There is no caching layer yet (M4), so
              // Next prefetching every row would run a full venue reload — fills,
              // funding and candles — per episode just from rendering this list.
              // Turn it back on once SPEC §10's cache lands.
              prefetch={false}
              className="flex flex-wrap items-baseline gap-x-6 gap-y-1 p-3 hover:bg-tr-panel"
              data-testid="episode-link"
            >
              <span className="w-28 font-bold">{episode.displayName}</span>
              <span
                className={`w-14 text-sm ${episode.direction === 'long' ? 'text-tr-up' : 'text-tr-down'}`}
              >
                {episode.direction === 'long' ? 'LONG' : 'SHORT'}
              </span>
              <span className="w-40 text-sm text-tr-dim">{formatDate(episode.openedAt)}</span>
              <span className="w-20 text-sm text-tr-dim">
                {episode.closedAt === null
                  ? 'OPEN'
                  : formatDuration(episode.closedAt - episode.openedAt)}
              </span>
              <span className="w-24 text-right text-sm text-tr-dim">
                {formatSize(episode.peakSize)}
              </span>
              <span
                className={`ml-auto text-right font-bold ${episode.net >= 0 ? 'text-tr-up' : 'text-tr-down'}`}
              >
                {formatUsd(episode.net)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ address?: string }>;
}) {
  const { address } = await searchParams;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold">trade-replay</h1>
      <p className="mt-1 text-sm text-tr-dim">
        Replay a trader&apos;s position from open to close.
      </p>

      <form method="GET" className="mt-6 flex gap-2">
        <input
          type="text"
          name="address"
          defaultValue={address ?? ''}
          placeholder={EXAMPLE}
          aria-label="Wallet address"
          data-testid="address-input"
          className="flex-1 border border-tr-line bg-tr-panel px-3 py-2 text-sm outline-none focus:border-tr-up"
        />
        <button
          type="submit"
          data-testid="address-submit"
          className="border border-tr-line bg-tr-panel px-4 py-2 text-sm hover:border-tr-up"
        >
          Load
        </button>
      </form>

      <p className="mt-2 text-xs text-tr-dim">
        Hyperliquid address or ENS name. Hyperliquid has no username system.
      </p>

      <div className="mt-8">
        {address ? (
          <EpisodeList address={address} />
        ) : (
          <p className="text-sm text-tr-dim">
            Try{' '}
            <Link href={`/?address=${EXAMPLE}`} className="underline hover:text-tr-text">
              {EXAMPLE}
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
