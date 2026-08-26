'use client';

/**
 * SPEC §12 M3: "canvas, rAF loop over `Frame[]`, transport controls, eased scaling."
 *
 * The loop does two things only: advance the clock and call `renderFrame`. No PnL is
 * computed per frame (SPEC §6.2 precomputes the whole `Frame[]`) and no React state is
 * set per frame — re-rendering a component tree 24 times a second is how a canvas
 * player ends up stuttering. The frame readout is written straight into a DOM node
 * from inside the loop instead.
 */

import {
  buildFrames,
  createPlaybackClock,
  type Frame,
  type PlaybackClock,
  type PlaybackSpeed,
  type PositionEpisode,
  type PriceSeries,
} from '@trade-replay/core';
import {
  advanceScale,
  createScale,
  darkTheme,
  renderFrame,
  type Canvas2D,
  type ScaleState,
} from '@trade-replay/renderer';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { formatSignedUsd, formatUsd, shortAddress } from '@/lib/format';

const SPEEDS: PlaybackSpeed[] = [0.5, 1, 2, 4];

export interface PlayerProps {
  replayId: string;
  address: string;
  episode: PositionEpisode;
  series: PriceSeries;
  interval: string;
  availableIntervals: string[];
  notices: string[];
}

function seriesLength(series: PriceSeries): number {
  return series.kind === 'ohlcv' ? series.candles.length : series.points.length;
}

export function Player(props: PlayerProps) {
  const { episode, notices } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const readoutRef = useRef<HTMLSpanElement | null>(null);
  const scrubRef = useRef<HTMLInputElement | null>(null);

  // The interval override swaps the series; everything downstream keys off this.
  const [seriesOverride, setSeriesOverride] = useState<PriceSeries | null>(null);
  const [interval, setIntervalName] = useState(props.interval);
  const [loadingInterval, setLoadingInterval] = useState(false);

  const series = seriesOverride ?? props.series;
  const frames: Frame[] = useMemo(() => buildFrames(episode, series), [episode, series]);

  // One clock for the component's life; the frame count is updated in place when the
  // interval changes, rather than silently constructing a second clock.
  const clockRef = useRef<PlaybackClock | null>(null);
  clockRef.current ??= createPlaybackClock({ frameCount: frames.length });
  const clock = clockRef.current;

  const scaleRef = useRef<ScaleState>(createScale());
  /** Last frame actually drawn, so the eased scale can be stepped to match. */
  const drawnRef = useRef(-1);
  const playingRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [climax, setClimax] = useState(false);

  /**
   * Draw a frame, stepping the eased scale to it.
   *
   * SPEC §7.2's scale at frame N depends on every frame before it, so a jumped-to
   * frame must replay that easing or it is framed differently from the same frame
   * reached by playing. Stepping through the intermediates — and restarting on a
   * backwards jump — makes seek and playback agree exactly.
   */
  const draw = useCallback(
    (index: number) => {
      const canvas = canvasRef.current;
      const frame = frames[index];
      if (!canvas || !frame) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      let from = drawnRef.current;
      if (index < from) {
        scaleRef.current = createScale();
        from = -1;
      }
      for (let i = from + 1; i < index; i++) {
        const skipped = frames[i];
        if (skipped) advanceScale(scaleRef.current, series, skipped);
      }
      drawnRef.current = index;

      renderFrame(ctx as unknown as Canvas2D, frame, episode, series, scaleRef.current, darkTheme, {
        width: canvas.width,
        height: canvas.height,
        // The backing store is already sized in device pixels, so geometry derived
        // from width/height is device-accurate and text comes out crisp.
        dpr: 1,
        address: props.address,
        watermark: 'trade-replay',
        interval,
        ...(notices.length > 0 ? { notices } : {}),
      });

      if (readoutRef.current) {
        readoutRef.current.textContent = `${index + 1} / ${frames.length}   ${formatSignedUsd(frame.totalPnl)}`;
      }
      if (scrubRef.current && document.activeElement !== scrubRef.current) {
        scrubRef.current.value = String(index);
      }
    },
    [frames, episode, series, interval, notices, props.address],
  );

  /** Match the backing store to the element's real size, in device pixels. */
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width === width && canvas.height === height) return;

    canvas.width = width;
    canvas.height = height;
    // Geometry changed, so the eased scale has to be replayed from scratch.
    scaleRef.current = createScale();
    drawnRef.current = -1;
    draw(clock.state.frameIndex);
  }, [draw, clock]);

  // A new series means a new timeline: adopt the frame count and redraw from scratch.
  useEffect(() => {
    clock.setFrameCount(frames.length);
    scaleRef.current = createScale();
    drawnRef.current = -1;
    draw(clock.state.frameIndex);
  }, [frames, clock, draw]);

  // Fonts are the host's job (SPEC §7); the renderer only names them. Waiting avoids a
  // first paint measured against a fallback face, which shifts every label.
  useEffect(() => {
    let cancelled = false;
    const ready = document.fonts
      ? document.fonts.load('700 16px "JetBrains Mono"').then(() => undefined)
      : Promise.resolve();

    void ready.catch(() => undefined).then(() => {
      if (cancelled) return;
      scaleRef.current = createScale();
      drawnRef.current = -1;
      draw(clock.state.frameIndex);
    });

    return () => {
      cancelled = true;
    };
  }, [draw, clock]);

  useEffect(() => {
    resize();
    const observer = new ResizeObserver(resize);
    const canvas = canvasRef.current;
    if (canvas) observer.observe(canvas);
    return () => observer.disconnect();
  }, [resize]);

  // The render loop.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number): void => {
      const delta = now - last;
      last = now;

      const before = clock.state.frameIndex;
      const index = clock.advance(delta);
      if (index !== before || drawnRef.current !== index) draw(index);

      // Playback stops itself at the final frame; reflect that in the button without
      // touching React state on every tick.
      if (clock.state.playing !== playingRef.current) {
        playingRef.current = clock.state.playing;
        setPlaying(clock.state.playing);
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clock, draw]);

  const syncPlaying = useCallback(() => {
    playingRef.current = clock.state.playing;
    setPlaying(clock.state.playing);
  }, [clock]);

  const togglePlay = useCallback(() => {
    clock.toggle();
    syncPlaying();
    draw(clock.state.frameIndex);
  }, [clock, syncPlaying, draw]);

  const seekTo = useCallback(
    (index: number) => {
      clock.seek(index);
      draw(clock.state.frameIndex);
    },
    [clock, draw],
  );

  const stepBy = useCallback(
    (delta: number) => {
      clock.step(delta);
      syncPlaying();
      draw(clock.state.frameIndex);
    },
    [clock, syncPlaying, draw],
  );

  // SPEC §8: "space = play/pause, arrows = ±1 frame, shift+arrows = ±10".
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;

      if (event.code === 'Space') {
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        stepBy(event.shiftKey ? -10 : -1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        stepBy(event.shiftKey ? 10 : 1);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, stepBy]);

  /** SPEC §8: "Hovering the canvas pauses and seeks to that x position." */
  const onCanvasMove = useCallback(
    (event: MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || frames.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      clock.pause();
      syncPlaying();
      seekTo(Math.round(ratio * (frames.length - 1)));
    },
    [clock, frames.length, seekTo, syncPlaying],
  );

  const changeSpeed = useCallback(
    (next: PlaybackSpeed) => {
      clock.setSpeed(next);
      setSpeed(next);
    },
    [clock],
  );

  const toggleClimax = useCallback(() => {
    const next = !climax;
    clock.setClimax(next);
    setClimax(next);
  }, [clock, climax]);

  /** SPEC §8 interval override. Different bars means refetching the series. */
  const changeInterval = useCallback(
    async (next: string) => {
      setLoadingInterval(true);
      try {
        const response = await fetch(
          `/api/replay?replayId=${encodeURIComponent(props.replayId)}&interval=${encodeURIComponent(next)}`,
        );
        if (!response.ok) return;
        const data = (await response.json()) as { series: PriceSeries; interval: string };
        setIntervalName(data.interval);
        setSeriesOverride(data.series);
      } finally {
        setLoadingInterval(false);
      }
    },
    [props.replayId],
  );

  // SPEC §8: "Scrubber shows fill markers as ticks along the track."
  const fillTicks = useMemo(
    () =>
      frames
        .map((frame, index) => ({ index, count: frame.newFills.length }))
        .filter((entry) => entry.count > 0)
        .map((entry) => (entry.index / Math.max(1, frames.length - 1)) * 100),
    [frames],
  );

  const finalFrame = frames.at(-1);

  return (
    <div
      className="space-y-4"
      data-testid="player"
      data-interval={interval}
      data-series-length={seriesLength(series)}
      data-frame-count={frames.length}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={onCanvasMove}
        data-testid="replay-canvas"
        className="block aspect-video w-full border border-tr-line"
      />

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          onClick={togglePlay}
          data-testid="play-toggle"
          aria-pressed={playing}
          className="w-24 border border-tr-line bg-tr-panel px-3 py-1.5 hover:border-tr-up"
        >
          {playing ? 'Pause' : 'Play'}
        </button>

        <span ref={readoutRef} data-testid="frame-readout" className="w-52 text-tr-dim">
          1 / {frames.length}
        </span>

        <div className="flex gap-1">
          {SPEEDS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => changeSpeed(option)}
              data-testid={`speed-${option}`}
              className={`border px-2 py-1 ${
                speed === option
                  ? 'border-tr-up text-tr-up'
                  : 'border-tr-line bg-tr-panel hover:border-tr-dim'
              }`}
            >
              {option}x
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-tr-dim">
          <span>interval</span>
          <select
            value={interval}
            disabled={loadingInterval}
            onChange={(event) => void changeInterval(event.target.value)}
            data-testid="interval-select"
            className="border border-tr-line bg-tr-panel px-2 py-1 text-tr-text"
          >
            {props.availableIntervals.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-tr-dim">
          <input
            type="checkbox"
            checked={climax}
            onChange={toggleClimax}
            data-testid="climax-toggle"
          />
          <span>slow finish</span>
        </label>
      </div>

      <div className="relative">
        <input
          ref={scrubRef}
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          defaultValue={0}
          onChange={(event) => seekTo(Number(event.target.value))}
          data-testid="scrubber"
          aria-label="Seek"
          className="w-full accent-[var(--color-tr-up)]"
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-2">
          {fillTicks.map((left, index) => (
            <span
              key={index}
              style={{ left: `${left}%` }}
              className="absolute top-0 h-2 w-px bg-tr-notice"
            />
          ))}
        </div>
      </div>

      {finalFrame ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 border border-tr-line p-3 text-xs sm:grid-cols-4">
          <Stat label="ADDRESS" value={shortAddress(props.address)} />
          <Stat label="BOUGHT" value={formatUsd(finalFrame.bought)} />
          <Stat label="SOLD" value={formatUsd(finalFrame.sold)} />
          <Stat label="FEES" value={formatUsd(episode.totalFees)} />
        </dl>
      ) : null}

      <p className="text-xs text-tr-dim">
        space play/pause · arrows step a frame · shift+arrows step ten · hover the chart to
        scrub
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-tr-dim">{label}</dt>
      <dd className="font-bold">{value}</dd>
    </div>
  );
}
