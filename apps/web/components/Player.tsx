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
  composeScore,
  computeEnergyTrack,
  createSequenceRenderer,
  darkTheme,
  type Canvas2D,
} from '@trade-replay/renderer';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { formatSignedUsd, formatUsd, shortAddress } from '@/lib/format';
import { createReplayAudio, type ReplayAudio } from '@/lib/audio';

const SPEEDS: PlaybackSpeed[] = [0.5, 1, 2, 4];

/** Remembered across replays, because being asked to mute a second time is rude. */
const MUTE_KEY = 'trade-replay:muted';

function storedMuted(): boolean {
  // Private windows and blocked site data both throw here rather than returning null.
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export interface PlayerProps {
  replayId: string;
  address: string;
  episode: PositionEpisode;
  series: PriceSeries;
  interval: string;
  availableIntervals: string[];
  notices: string[];
  /** The venue cannot report funding for this account; the HUD shows a dash. */
  fundingUnavailable?: boolean;
  /**
   * Present when this position was typed rather than traded.
   *
   * Two consequences. The canvas carries a CONSTRUCTED tag and shows fees as
   * unavailable — a hypothetical paid nothing, but a real trade would have. And the
   * interval override refetches by spec: there is no account to look the fills up from,
   * so `?replayId=` would find nothing.
   */
  manualSpec?: string;
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

  /**
   * Owns the eased scale and the last-drawn index.
   *
   * Shared with the export path so a downloaded frame and the on-screen one are framed
   * identically — SPEC §9 calls that the whole payoff of §7's purity rule.
   */
  const renderer = useMemo(
    () => createSequenceRenderer(episode, series, frames, darkTheme),
    [episode, series, frames],
  );
  const playingRef = useRef(false);
  const audioStateRef = useRef<AudioContextState>('suspended');

  /**
   * The soundtrack, derived from the same energy track the chart's effects use — so the
   * flash, the meter and the note are three readings of one number, not three things
   * that happen to coincide. Pure and precomputed, for the same reason the frames are.
   */
  const score = useMemo(
    () => composeScore(frames, computeEnergyTrack(frames), episode),
    [frames, episode],
  );

  const audioRef = useRef<ReplayAudio | null>(null);
  const [muted, setMuted] = useState(false);
  /**
   * Whether the browser has actually started the audio context.
   *
   * Tracked because "suspended" and "playing quietly" are indistinguishable from the
   * outside, and that ambiguity is exactly how a silent player shipped: the button said
   * "Sound on" while the browser had never let a note through. Polled from the render
   * loop, which is already running, rather than by a timer of its own.
   */
  const [audioState, setAudioState] = useState<AudioContextState>('suspended');

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [climax, setClimax] = useState(false);

  /**
   * Unblock audio on the first interaction with the page, whatever it was.
   *
   * Browsers start an AudioContext suspended and only let a *user gesture* resume it.
   * Hanging that solely off the Play button is fragile: someone who drags the scrubber,
   * hits space, or clicks the canvas first has already spent their gesture, and a
   * `resume()` that arrives outside one can be refused. Listening once for any pointer
   * or key removes the whole class.
   *
   * `once: true` — after the context is running there is nothing left to do.
   */
  useEffect(() => {
    const unblock = (): void => {
      void audioRef.current?.resume().then(() => {
        const state = audioRef.current?.state();
        if (state) {
          audioStateRef.current = state;
          setAudioState(state);
        }
      });
    };

    document.addEventListener('pointerdown', unblock, { once: true });
    document.addEventListener('keydown', unblock, { once: true });
    return () => {
      document.removeEventListener('pointerdown', unblock);
      document.removeEventListener('keydown', unblock);
    };
  }, []);

  // A window handle onto the live audio graph, for `verify:sound`.
  //
  // The export path drives its own graph, so a file with sound proves nothing about the
  // player — that is precisely the gap that let a silent player pass verification. This
  // is the only way to assert from outside that the player itself made a noise.
  useEffect(() => {
    const w = window as unknown as { __replayAudio?: () => { state: string; strikes: number } };
    w.__replayAudio = () => ({
      state: audioRef.current?.state() ?? 'closed',
      strikes: audioRef.current?.strikes() ?? 0,
    });
    return () => {
      delete w.__replayAudio;
    };
  }, []);

  const draw = useCallback(
    (index: number) => {
      const canvas = canvasRef.current;
      const frame = frames[index];
      if (!canvas || !frame) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      renderer.render(ctx as unknown as Canvas2D, index, {
        width: canvas.width,
        height: canvas.height,
        // The backing store is already sized in device pixels, so geometry derived
        // from width/height is device-accurate and text comes out crisp.
        dpr: 1,
        address: props.address,
        watermark: 'trade-replay',
        interval,
        ...(notices.length > 0 ? { notices } : {}),
        ...(props.fundingUnavailable ? { fundingUnavailable: true } : {}),
        ...(props.manualSpec ? { constructed: true, feesUnavailable: true } : {}),
      });

      if (readoutRef.current) {
        readoutRef.current.textContent = `${index + 1} / ${frames.length}   ${formatSignedUsd(frame.totalPnl)}`;
      }
      if (scrubRef.current && document.activeElement !== scrubRef.current) {
        scrubRef.current.value = String(index);
      }
    },
    [
      frames,
      renderer,
      interval,
      notices,
      props.address,
      props.fundingUnavailable,
      props.manualSpec,
    ],
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
    renderer.reset();
    draw(clock.state.frameIndex);
  }, [draw, clock, renderer]);

  // A new series means a new timeline: adopt the frame count and redraw from scratch.
  useEffect(() => {
    clock.setFrameCount(frames.length);
    renderer.reset();
    draw(clock.state.frameIndex);
  }, [frames, clock, draw, renderer]);

  // Fonts are the host's job (SPEC §7); the renderer only names them. Waiting avoids a
  // first paint measured against a fallback face, which shifts every label.
  useEffect(() => {
    let cancelled = false;
    const ready = document.fonts
      ? document.fonts.load('700 16px "JetBrains Mono"').then(() => undefined)
      : Promise.resolve();

    void ready.catch(() => undefined).then(() => {
      if (cancelled) return;
      renderer.reset();
      draw(clock.state.frameIndex);
    });

    return () => {
      cancelled = true;
    };
  }, [draw, clock, renderer]);

  // The audio graph is built once per score and torn down with the component. It is not
  // started here: browsers refuse to run an AudioContext that was not begun by a user
  // gesture, so `resume()` is called from the play button instead.
  useEffect(() => {
    const audio = createReplayAudio(score);
    audioRef.current = audio;
    const initial = storedMuted();
    setMuted(initial);
    audio?.setMuted(initial);
    audio?.seek(clock.state.frameIndex);
    return () => {
      audio?.close();
      audioRef.current = null;
    };
  }, [score, clock]);

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
      if (index !== before || renderer.lastIndex !== index) draw(index);
      // Driven by the frame index, not by elapsed time, so the melody stays locked to
      // the chart at every speed and through a scrub.
      audioRef.current?.advanceTo(index);
      // Cheap: a string compare against a ref, and the setter is a no-op when unchanged.
      const state = audioRef.current?.state();
      if (state && state !== audioStateRef.current) {
        audioStateRef.current = state;
        setAudioState(state);
      }

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
  }, [clock, draw, renderer]);

  const syncPlaying = useCallback(() => {
    playingRef.current = clock.state.playing;
    setPlaying(clock.state.playing);
  }, [clock]);

  const togglePlay = useCallback(() => {
    clock.toggle();
    syncPlaying();
    draw(clock.state.frameIndex);
    // The gesture browsers require. Pressing play is the moment sound is expected, and
    // no other control in this player is one a user would be surprised to hear.
    if (clock.state.playing) {
      void audioRef.current?.resume().then(() => {
        const state = audioRef.current?.state();
        if (state) {
          audioStateRef.current = state;
          setAudioState(state);
        }
      });
    }
  }, [clock, syncPlaying, draw]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    audioRef.current?.setMuted(next);
    try {
      window.localStorage.setItem(MUTE_KEY, next ? '1' : '0');
    } catch {
      // A browser that refuses to store the preference still honours it for this
      // session; failing the click over it would be worse.
    }
  }, [muted]);

  const seekTo = useCallback(
    (index: number) => {
      clock.seek(index);
      draw(clock.state.frameIndex);
      audioRef.current?.seek(clock.state.frameIndex);
    },
    [clock, draw],
  );

  const stepBy = useCallback(
    (delta: number) => {
      clock.step(delta);
      syncPlaying();
      draw(clock.state.frameIndex);
      audioRef.current?.seek(clock.state.frameIndex);
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
        const source = props.manualSpec
          ? `manual=${encodeURIComponent(props.manualSpec)}`
          : `replayId=${encodeURIComponent(props.replayId)}`;
        const response = await fetch(`/api/replay?${source}&interval=${encodeURIComponent(next)}`);
        if (!response.ok) return;
        const data = (await response.json()) as { series: PriceSeries; interval: string };
        setIntervalName(data.interval);
        setSeriesOverride(data.series);
      } finally {
        setLoadingInterval(false);
      }
    },
    [props.replayId, props.manualSpec],
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

        <button
          type="button"
          onClick={toggleMute}
          data-testid="mute-toggle"
          aria-pressed={muted}
          title={
            muted
              ? 'Muted — click to turn the piano back on'
              : 'A piano line that follows the PnL. Click to mute.'
          }
          data-audio-state={audioState}
          className={`border bg-tr-panel px-3 py-1.5 ${
            muted ? 'border-tr-line text-tr-dim' : 'border-tr-up text-tr-up'
          }`}
        >
          {muted ? 'Sound off' : 'Sound on'}
        </button>

        {/* Said out loud rather than left to silence. A context the browser has not
            started looks exactly like one that is working and quiet, and the whole
            reason the player shipped mute is that nothing here distinguished them. */}
        {!muted && audioState !== 'running' && playing ? (
          <span className="text-xs text-tr-notice" data-testid="audio-blocked">
            Your browser has not started audio — click Sound on, then Play again.
          </span>
        ) : null}

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
          {/* A constructed position has no account, and a labelled empty cell reads as
              a value that failed to load rather than as one that does not exist. */}
          {props.address ? (
            <Stat label="ADDRESS" value={shortAddress(props.address)} />
          ) : null}
          <Stat label="BOUGHT" value={formatUsd(finalFrame.bought)} />
          <Stat label="SOLD" value={formatUsd(finalFrame.sold)} />
          {/* Same rule the canvas follows: nothing was paid, but a real trade would
              have, so the cost of this trade is unknown rather than zero. */}
          <Stat
            label="FEES"
            value={props.manualSpec ? '—' : formatUsd(episode.totalFees)}
          />
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
