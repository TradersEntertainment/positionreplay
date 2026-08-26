/**
 * `/b/[spec]` — the player for a position someone typed.
 *
 * The same components the real player uses, given a replay whose fills were built from
 * the URL rather than fetched from an account. It is the same page in every respect
 * except the ones that must differ: the CONSTRUCTED tag in the image, fees shown as
 * unavailable, and no address to attribute the trade to.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExportPanel } from '@/components/ExportPanel';
import { Player } from '@/components/Player';
import { Notices } from '@/components/Notices';
import { ReplayNotFoundError, loadManualReplay } from '@/lib/data';
import { formatDate, formatDuration, formatSignedUsd, formatPrice } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ManualReplayPage({
  params,
}: {
  params: Promise<{ spec: string }>;
}) {
  const { spec } = await params;

  let replay;
  try {
    replay = await loadManualReplay(spec);
  } catch (error) {
    if (error instanceof ReplayNotFoundError) notFound();
    throw error;
  }

  const { episode } = replay;
  // Fees are excluded on purpose: this position paid none, and the HUD shows them as
  // unavailable rather than as zero, so subtracting a zero here would be the only place
  // in the app that treated the unknown as known.
  const net = episode.realizedPnl;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">
            {episode.displayName}{' '}
            <span className={episode.direction === 'long' ? 'text-tr-up' : 'text-tr-down'}>
              {episode.direction === 'long' ? 'LONG' : 'SHORT'}
            </span>{' '}
            <span
              className="bg-tr-notice px-1.5 py-0.5 align-middle text-[10px] font-bold text-tr-bg"
              data-testid="constructed-badge"
            >
              CONSTRUCTED
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
          <Link href="/build" className="text-xs text-tr-dim underline hover:text-tr-text">
            build another
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
          fundingUnavailable={replay.fundingUnavailable}
          manualSpec={spec}
        />

        <ExportPanel
          episode={replay.episode}
          series={replay.series}
          address={replay.address}
          interval={replay.interval}
          notices={replay.notices}
          fundingUnavailable={replay.fundingUnavailable}
          shareUrl={`/b/${replay.replayId}`}
          replayId={replay.replayId}
          manualSpec={spec}
        />
      </div>
    </main>
  );
}
