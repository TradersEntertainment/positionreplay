'use client';

/**
 * SPEC §8's export panel and share button, driving §9 Phase 1.
 *
 * CLAUDE.md: "These outputs get exported as images and posted as fact." So this panel
 * never hands over a file it cannot vouch for — an unsupported codec disables the
 * button with the reason, and MP4 says plainly that it is M8's job rather than
 * pretending.
 */

import { buildFrames } from '@trade-replay/core';
import type { PositionEpisode, PriceSeries } from '@trade-replay/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EXPORT_PRESETS,
  ExportUnsupportedError,
  GIF_FPS,
  GIF_MAX_FRAMES,
  RenderJobError,
  awaitMp4,
  downloadBlob,
  encodeGif,
  exportFilename,
  formatBytes,
  pickVideoMimeType,
  planGif,
  recordVideo,
  renderProgress,
  requestMp4,
  type ExportPreset,
  type ExportScene,
} from '@/lib/export';

type Job = 'video' | 'gif' | 'mp4' | null;

export interface ExportPanelProps {
  episode: PositionEpisode;
  series: PriceSeries;
  address: string;
  interval: string;
  notices: string[];
  fundingUnavailable?: boolean;
  shareUrl: string;
  /** SPEC §9 Phase 2: what the worker is asked to render. */
  replayId: string;
  /** SPEC §6.3's climax easing, so the MP4 matches what the player just played. */
  slowFinish?: boolean;
}

export function ExportPanel(props: ExportPanelProps) {
  const { episode, series, address, interval, notices, fundingUnavailable, shareUrl } = props;
  const { replayId, slowFinish = false } = props;

  // Built here rather than passed from the server: Frame[] is large, and buildFrames is
  // pure and cheap enough that shipping it would only inflate the page payload.
  const scene: ExportScene = useMemo(
    () => ({
      episode,
      series,
      frames: buildFrames(episode, series),
      address,
      interval,
      notices,
      ...(fundingUnavailable ? { fundingUnavailable: true } : {}),
    }),
    [episode, series, address, interval, notices, fundingUnavailable],
  );

  const [preset, setPreset] = useState<ExportPreset>(EXPORT_PRESETS[0]!);
  const [job, setJob] = useState<Job>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Probed on the client only: MediaRecorder does not exist during SSR.
  const [videoMime, setVideoMime] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setVideoMime(pickVideoMimeType());
  }, []);

  const gifPlan = useMemo(() => planGif(scene.frames.length), [scene.frames.length]);
  const replaySeconds = scene.frames.length / 24;

  const run = useCallback(
    async (kind: Exclude<Job, null>) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setJob(kind);
      setProgress(0);
      setError(null);
      setStatus(null);

      try {
        if (kind === 'video') {
          // Recording is real time (SPEC §9), so this genuinely takes the replay's length.
          const result = await recordVideo(scene, preset, {
            onProgress: setProgress,
            signal: controller.signal,
          });
          downloadBlob(result.blob, exportFilename(scene, result.extension));
          setStatus(`${formatBytes(result.blob.size)} · ${result.mimeType}`);
        } else if (kind === 'gif') {
          const result = await encodeGif(scene, preset, {
            onProgress: setProgress,
            signal: controller.signal,
          });
          downloadBlob(result.blob, exportFilename(scene, 'gif'));
          setStatus(
            `${formatBytes(result.blob.size)} · ${result.frames} frames · ${result.width}×${result.height}`,
          );
        } else {
          // SPEC §9 Phase 2. The work happens on the server, so this is a queue and a
          // poll rather than a render; the browser never sees a frame of it.
          setStatus('Queued on the render worker…');
          const queued = await requestMp4({
            replayId,
            preset,
            slowFinish,
            interval,
          });
          const done = await awaitMp4(queued.id, {
            signal: controller.signal,
            onProgress: (update) => {
              const fraction = renderProgress(update);
              if (fraction !== null) setProgress(fraction);
              setStatus(
                update.status === 'queued'
                  ? 'Queued on the render worker…'
                  : `Rendering ${update.framesDone}/${update.frameCount} frames on the server…`,
              );
            },
          });

          // A plain link, not a fetch-into-a-Blob: the file is on disk and can be tens
          // of megabytes, and pulling it into memory to hand straight back is waste.
          const link = document.createElement('a');
          link.href = done.url ?? `/api/render/${done.id}/file`;
          link.download = exportFilename(scene, 'mp4');
          link.click();
          setStatus(`${formatBytes(done.bytes ?? 0)} · H.264 yuv420p · rendered server-side`);
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') setStatus('Cancelled.');
        else if (caught instanceof ExportUnsupportedError) setError(caught.message);
        else if (caught instanceof RenderJobError) setError(caught.message);
        else setError(caught instanceof Error ? caught.message : 'Export failed.');
      } finally {
        abortRef.current = null;
        setJob(null);
        setProgress(0);
      }
    },
    [scene, preset, replayId, slowFinish, interval],
  );

  const share = useCallback(async () => {
    try {
      // The prop is a path; a shared link has to carry the origin to be usable.
      const absolute = new URL(shareUrl, window.location.href).toString();
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setError('Could not copy to the clipboard. The link is in the address bar.');
    }
  }, [shareUrl]);

  const busy = job !== null;

  return (
    <section className="space-y-3 border border-tr-line p-4" data-testid="export-panel">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-bold">Export</h2>

        <label className="flex items-center gap-2 text-xs text-tr-dim">
          <span>size</span>
          <select
            value={preset.id}
            disabled={busy}
            onChange={(event) =>
              setPreset(EXPORT_PRESETS.find((p) => p.id === event.target.value) ?? EXPORT_PRESETS[0]!)
            }
            data-testid="export-preset"
            className="border border-tr-line bg-tr-panel px-2 py-1 text-tr-text"
          >
            {EXPORT_PRESETS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={share}
          data-testid="share-button"
          className="ml-auto border border-tr-line bg-tr-panel px-3 py-1.5 text-xs hover:border-tr-up"
        >
          {copied ? 'Link copied' : 'Copy link'}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void run('video')}
          disabled={busy || videoMime === null}
          data-testid="export-video"
          title={videoMime ?? undefined}
          className="border border-tr-line bg-tr-panel px-3 py-1.5 text-sm hover:border-tr-up disabled:cursor-not-allowed disabled:opacity-40"
        >
          {job === 'video' ? 'Recording…' : 'Download WebM'}
        </button>

        <button
          type="button"
          onClick={() => void run('gif')}
          disabled={busy}
          data-testid="export-gif"
          className="border border-tr-line bg-tr-panel px-3 py-1.5 text-sm hover:border-tr-up disabled:cursor-not-allowed disabled:opacity-40"
        >
          {job === 'gif' ? 'Encoding…' : 'Download GIF'}
        </button>

        {/*
          SPEC §9: "Offer Download MP4 which routes to Phase 2 when available." It is
          available: the worker renders it with the same renderFrame this canvas uses,
          so the file is the preview rather than a re-interpretation of it.
        */}
        <button
          type="button"
          onClick={() => void run('mp4')}
          disabled={busy}
          data-testid="export-mp4"
          title="Rendered on the server with H.264 + yuv420p, which is what X accepts."
          className="border border-tr-line bg-tr-panel px-3 py-1.5 text-sm hover:border-tr-up disabled:cursor-not-allowed disabled:opacity-40"
        >
          {job === 'mp4' ? 'Rendering…' : 'Download MP4'}
        </button>

        {busy ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            data-testid="export-cancel"
            className="border border-tr-down/60 px-3 py-1.5 text-sm text-tr-down hover:border-tr-down"
          >
            Cancel
          </button>
        ) : null}
      </div>

      {busy ? (
        <div data-testid="export-progress">
          <div className="h-1 w-full bg-tr-line">
            <div
              className="h-1 bg-tr-up transition-[width] duration-150"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-tr-dim">
            {job === 'video'
              ? `Recording in real time — about ${replaySeconds.toFixed(0)}s.`
              : 'Encoding…'}{' '}
            {Math.round(progress * 100)}%
          </p>
        </div>
      ) : null}

      {status ? (
        <p className="text-xs text-tr-up" data-testid="export-status">
          {status}
        </p>
      ) : null}

      {error ? (
        <p className="border border-tr-down/40 bg-tr-down/10 p-2 text-xs text-tr-down" data-testid="export-error">
          {error}
        </p>
      ) : null}

      {videoMime === null ? (
        <p className="text-xs text-tr-notice">
          This browser cannot record video. Safari has no WebM encoder — try Chrome or Firefox.
        </p>
      ) : null}

      <p className="text-xs text-tr-dim">
        WebM is {scene.frames.length} frames at {replaySeconds.toFixed(0)}s. GIF is{' '}
        {gifPlan.indices.length} frames at {GIF_FPS}fps, 640px wide
        {gifPlan.indices.length >= GIF_MAX_FRAMES ? ' (frame-capped, so it will look choppy)' : ''}.
        MP4 is rendered on the server as H.264 + yuv420p, which is what X accepts;
        WebM and GIF are made here in the browser.
      </p>
    </section>
  );
}
