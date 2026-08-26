/**
 * The bundle every layer receives. Assembled once per frame by renderFrame so the
 * layers do not each recompute geometry or search the series.
 */

import type { Fill, Frame, PositionEpisode, PriceSeries } from '@trade-replay/core';
import type { ScaleState } from '../scale.js';
import type { Metrics, RenderLayout, Theme } from '../types.js';

export interface MarkerInfo {
  fill: Fill;
  action: string;
  /** Series index of the bar this fill landed in. */
  barIndex: number;
}

export interface LayerContext {
  frame: Frame;
  episode: PositionEpisode;
  series: PriceSeries;
  scale: ScaleState;
  theme: Theme;
  layout: RenderLayout;
  metrics: Metrics;
  /** Right edge of the x domain in bar-index units. */
  xDomain: number;
  totalBars: number;
  /** Bar open times, flattened across both PriceSeries shapes. */
  times: number[];
  /** Milliseconds covered by the whole series, for axis label granularity. */
  spanMs: number;
  markers: MarkerInfo[];
}
