/**
 * Playback controller. SPEC.md §6.3.
 *
 * A pure state machine with no timers, no rAF and no DOM. SPEC: "Fixed timestep:
 * advance `framesPerSecond = 24 * speed` decoupled from rAF, using an accumulator.
 * Same clock math is reused by the exporter, just driven by a counter instead of wall
 * time."
 *
 * That last sentence is why this lives in core rather than in the player component:
 * an exported video and the preview it was rendered from must walk the same frames.
 */

/** SPEC §6.3: `framesPerSecond = 24 * speed`. */
export const BASE_FPS = 24;

export type PlaybackSpeed = 0.5 | 1 | 2 | 4;

/** SPEC §6.3: "slow down to 0.3x for the last ~10% of frames (the 'climax')". */
export const CLIMAX_SPEED = 0.3;
export const CLIMAX_TAIL_RATIO = 0.1;

/**
 * Longest span a single `advance` may consume.
 *
 * A backgrounded tab delivers one enormous delta when it wakes. Without this the
 * replay silently jumps from wherever the viewer was to the end — they see none of
 * the trade. Losing that time is the correct trade: playback is a presentation, not a
 * simulation that has to stay in sync with a wall clock.
 */
export const MAX_ADVANCE_MS = 250;

export interface PlaybackState {
  frameIndex: number;
  frameCount: number;
  playing: boolean;
  speed: PlaybackSpeed;
  /** Milliseconds banked toward the next frame. */
  accumulator: number;
  climax: boolean;
}

export interface PlaybackClock {
  readonly state: Readonly<PlaybackState>;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Jump to a frame. Fractional values are rounded — the scrubber emits them. */
  seek(index: number): void;
  /** Move by whole frames and pause, for the arrow keys. */
  step(delta: number): void;
  setSpeed(speed: PlaybackSpeed): void;
  setClimax(enabled: boolean): void;
  /** Replace the frame count when the interval override rebuilds the timeline. */
  setFrameCount(frameCount: number): void;
  /** Feed elapsed milliseconds; returns the resulting frame index. */
  advance(deltaMs: number): number;
  reset(): void;
}

export interface PlaybackOptions {
  frameCount: number;
  speed?: PlaybackSpeed;
  climax?: boolean;
}

export function createPlaybackClock(options: PlaybackOptions): PlaybackClock {
  const state: PlaybackState = {
    frameIndex: 0,
    frameCount: Math.max(0, Math.floor(options.frameCount)),
    playing: false,
    speed: options.speed ?? 1,
    accumulator: 0,
    climax: options.climax ?? false,
  };

  const lastIndex = (): number => Math.max(0, state.frameCount - 1);

  /**
   * Milliseconds this particular frame should be held for.
   *
   * Computed per frame rather than once per advance, so entering the climax tail
   * slows playback from that frame on rather than from the next call.
   */
  const msForFrame = (index: number): number => {
    const inTail = state.climax && index >= state.frameCount * (1 - CLIMAX_TAIL_RATIO);
    const fps = BASE_FPS * state.speed * (inTail ? CLIMAX_SPEED : 1);
    return 1_000 / fps;
  };

  const clamp = (index: number): number => Math.min(lastIndex(), Math.max(0, index));

  return {
    state,

    play(): void {
      if (state.frameCount === 0) return;
      // Pressing play on the final frame means "watch it again", not "do nothing".
      if (state.frameIndex >= lastIndex()) {
        state.frameIndex = 0;
      }
      state.accumulator = 0;
      state.playing = true;
    },

    pause(): void {
      state.playing = false;
    },

    toggle(): void {
      if (state.playing) this.pause();
      else this.play();
    },

    seek(index: number): void {
      state.frameIndex = clamp(Math.round(index));
      // Carrying a part-finished frame across a jump makes the first frame after a
      // seek shorter than the rest.
      state.accumulator = 0;
    },

    step(delta: number): void {
      state.playing = false;
      state.frameIndex = clamp(state.frameIndex + Math.trunc(delta));
      state.accumulator = 0;
    },

    setSpeed(speed: PlaybackSpeed): void {
      state.speed = speed;
      // A remainder banked at one speed would pay out at the new one, which stutters.
      state.accumulator = 0;
    },

    setClimax(enabled: boolean): void {
      state.climax = enabled;
    },

    setFrameCount(frameCount: number): void {
      state.frameCount = Math.max(0, Math.floor(frameCount));
      state.frameIndex = clamp(state.frameIndex);
      state.accumulator = 0;
    },

    advance(deltaMs: number): number {
      if (!state.playing || state.frameCount === 0) return state.frameIndex;

      state.accumulator += Math.min(Math.max(0, deltaMs), MAX_ADVANCE_MS);

      while (state.frameIndex < lastIndex()) {
        const hold = msForFrame(state.frameIndex);
        if (state.accumulator < hold) break;
        state.accumulator -= hold;
        state.frameIndex++;
      }

      if (state.frameIndex >= lastIndex()) {
        state.frameIndex = lastIndex();
        state.playing = false;
        state.accumulator = 0;
      }

      return state.frameIndex;
    },

    reset(): void {
      state.frameIndex = 0;
      state.playing = false;
      state.accumulator = 0;
      state.speed = options.speed ?? 1;
    },
  };
}
