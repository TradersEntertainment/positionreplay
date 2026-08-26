/** SPEC §8 `/r/[replayId]` — the player. */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Player } from '@/components/Player';
import { Notices } from '@/components/Notices';
import { ReplayNotFoundError, loadReplay } from '@/lib/data';
import { formatDate, formatDuration, formatSignedUsd, formatPrice } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ReplayPage({
  params,
}: {
  params: Promise<{ replayId: string }>;
}) {
  const { replayId } = await params;

  let replay;
  try {
    replay = await loadReplay(replayId);
  } catch (error) {
    if (error instanceof ReplayNotFoundError) notFound();
    throw error;
  }

  const { episode } = replay;
  const net = episode.realizedPnl - episode.totalFees + episode.totalFunding;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">
            {episode.displayName}{' '}
            <span className={episode.direction === 'long' ? 'text-tr-up' : 'text-tr-down'}>
              {episode.direction === 'long' ? 'LONG' : 'SHORT'}
            </span>
          </h1>
          <p className="mt-1 text-xs text-tr-dim">
            {formatDate(episode.openedAt)} ·{' '}
            {episode.closedAt === null
              ? 'still open'
              : formatDuration(episode.closedAt - episode.openedAt)}{' '}
            · avg entry {formatPrice(episode.avgEntry)} · {replay.barCount} bars
          </p>
        </div>

        <div className="text-right">
          <p className={`text-2xl font-bold ${net >= 0 ? 'text-tr-up' : 'text-tr-down'}`}>
            {formatSignedUsd(net)}
          </p>
          <Link
            href={`/?address=${replay.address}`}
            className="text-xs text-tr-dim underline hover:text-tr-text"
          >
            all episodes
          </Link>
        </div>
      </div>

      <div className="mt-4 space-y-4">
        <Notices warnings={replay.warnings} provenanceWarning={replay.provenanceWarning} />

        <Player
          replayId={replay.replayId}
          address={replay.address}
          episode={replay.episode}
          series={replay.series}
          interval={replay.interval}
          availableIntervals={replay.availableIntervals}
          notices={replay.notices}
        />
      </div>
    </main>
  );
}
