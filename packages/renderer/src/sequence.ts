/**
 * Renders frames of one replay in sequence, keeping the eased scale consistent.
 *
 * SPEC §7.2's axis at frame N depends on every frame before it. Anything that draws a
 * frame — the browser player, the export path, M8's server worker — has to replay that
 * easing or the same frame comes out framed differently depending on how it was
 * reached. This is that logic, in one place, so those three cannot drift apart. SPEC §9
 * calls pixel-identical server and browser output "the whole payoff of §7".
 *
 * Still pure: `ScaleState` is the only mutable thing, the context is passed in, and
 * nothing here touches the DOM or awaits.
 */

import type { Frame, PositionEpisode, PriceSeries } from '@trade-replay/core';
import { computeEnergyTrack, type FrameEnergy } from './effects.js';
import { advanceScale, renderFrame, type RenderOptions } from './render.js';
import { createScale, type ScaleState } from './scale.js';
import type { Canvas2D, RenderLayout, Theme } from './types.js';

export interface SequenceRenderer {
  /** Draw `index`, stepping the scale from wherever it was left. */
  render(ctx: Canvas2D, index: number, layout: RenderLayout): void;
  /** Forget the scale; the next render replays easing from frame 0. */
  reset(): void;
  /** Index most recently drawn, or -1. */
  readonly lastIndex: number;
}

export function createSequenceRenderer(
  episode: PositionEpisode,
  series: PriceSeries,
  frames: readonly Frame[],
  theme: Theme,
  options: RenderOptions = {},
): SequenceRenderer {
  let scale: ScaleState = createScale();
  let lastIndex = -1;

  // Computed once, here, for the same reason the easing lives here: every path that
  // draws this replay — player, WebM/GIF export, M8's server worker — goes through this
  // function, so this is the only place the effects can be guaranteed identical across
  // all three. Doing it in the player would mean the exported file is a different clip
  // from the one the user watched.
  const energy: FrameEnergy[] = options.effects === false ? [] : computeEnergyTrack(frames);

  return {
    get lastIndex() {
      return lastIndex;
    },

    reset(): void {
      scale = createScale();
      lastIndex = -1;
    },

    render(ctx: Canvas2D, index: number, layout: RenderLayout): void {
      const frame = frames[index];
      if (!frame) return;

      // Going backwards cannot be undone by stepping, so start the easing again.
      if (index < lastIndex) {
        scale = createScale();
        lastIndex = -1;
      }
      for (let i = lastIndex + 1; i < index; i++) {
        const skipped = frames[i];
        if (skipped) advanceScale(scale, series, skipped, episode, options.easing);
      }
      lastIndex = index;

      // `exactOptionalPropertyTypes`: an absent track means absent, not `undefined`,
      // and the layers read absence as "draw the plain chart".
      const frameEnergy = energy[index];
      renderFrame(
        ctx,
        frame,
        episode,
        series,
        scale,
        theme,
        frameEnergy ? { ...layout, energy: frameEnergy } : layout,
        options,
      );
    },
  };
}
