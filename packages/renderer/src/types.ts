/**
 * Renderer contracts. SPEC.md §7.
 *
 * Nothing here references the DOM. The context is described structurally so that a
 * browser `CanvasRenderingContext2D` and `@napi-rs/canvas`'s context both satisfy it
 * with no cast — that identity is what makes SPEC §9's "server output is
 * pixel-identical to the browser preview" true rather than aspirational.
 */

import type { FrameEnergy } from './effects.js';

/** The subset of the Canvas 2D API this renderer uses. */
export interface Canvas2D {
  /** `string | CanvasGradient | CanvasPattern` in both hosts; we only ever set strings. */
  fillStyle: string | object;
  strokeStyle: string | object;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: string;
  textBaseline: string;

  save(): void;
  restore(): void;

  /**
   * Both hosts have these; only the outro uses them, and only inside a save/restore.
   *
   * Adding them to this interface is what lets the ending pull the chart back without
   * every layer needing to know about it — the transform is applied once around the
   * existing draw order.
   */
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;

  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  clip(): void;

  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;

  setLineDash(segments: number[]): void;
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number): void;
}

/**
 * Colours and typography. SPEC §7.3: monospace throughout, near-black background,
 * teal/red candles, no gradients, no rounded corners, no shadows. "It should look
 * like a terminal, not a dashboard."
 */
export interface Theme {
  background: string;
  grid: string;
  axisText: string;
  candleUp: string;
  candleDown: string;
  lineStroke: string;
  lineFill: string;
  entryLine: string;
  entryPill: string;
  entryPillText: string;
  markerOpen: string;
  markerClose: string;
  markerFlip: string;
  markerLiquidation: string;
  markerText: string;
  hudText: string;
  hudDim: string;
  pnlUp: string;
  pnlDown: string;
  notice: string;
  watermark: string;
  fontFamily: string;
}

/**
 * Output geometry plus the display metadata the HUD needs.
 *
 * SPEC §7 types this parameter as `{ width, height, dpr }`; the extra fields are
 * optional additions, because §7.1 requires the HUD to show an address and §6.1
 * requires it to show the picked interval, and neither is derivable from the episode.
 */
export interface RenderLayout {
  width: number;
  height: number;
  dpr: number;
  /** Truncated into the HUD. SPEC §7.1. */
  address?: string;
  /** SPEC §7.1: "small centered domain string at the top of the chart area". */
  watermark?: string;
  /** SPEC §6.1: "Show the picked interval in the HUD." */
  interval?: string;
  /**
   * User-supplied leverage overlay. SPEC §4.3: Hyperliquid does not expose historical
   * leverage, so this is NEVER derived — absent means the HUD omits it entirely
   * rather than inventing a number (CLAUDE.md).
   */
  leverage?: number;
  /**
   * Warnings that must survive being exported as an image: a truncated fill history,
   * an estimated funding figure. CLAUDE.md: an export is a screenshot someone posts
   * as fact.
   */
  notices?: string[];
  /**
   * The venue cannot tell us this account's funding charges.
   *
   * Polymarket Perps serves funding *rates* publicly but per-account amounts only to an
   * authenticated session (SPEC §4.4.2). Drawing $0.00 would assert that no funding was
   * paid, so the HUD shows it as unavailable instead — same rule as leverage.
   */
  fundingUnavailable?: boolean;
  /**
   * The fees on this replay are not knowable.
   *
   * True for a manually constructed position: nothing was actually paid, so the fills
   * carry zero — but a real trade would have paid something, and "FEES $0.00" is a
   * claim about what this trade would have cost. Same rule as leverage and Perps
   * funding (CLAUDE.md): unavailable, not invented.
   */
  feesUnavailable?: boolean;
  /**
   * This position was typed, not traded.
   *
   * Drawn into the image itself rather than only onto the page around it, because the
   * image is what gets posted, and a constructed replay is indistinguishable from a
   * real one once it is an MP4.
   */
  constructed?: boolean;
  /** SPEC §7.2: (b) growing domain is the default, (a) fixed is the option. */
  xMode?: 'growing' | 'fixed';
  /**
   * How hard the replay is moving at this frame. See effects.ts.
   *
   * Passed in rather than derived here because it depends on the whole frame history,
   * which `renderFrame` deliberately does not have. Absent means draw nothing extra —
   * every caller that does not opt in gets the plain chart.
   */
  energy?: FrameEnergy;
  /**
   * How far into the closing card this frame is, 0..1. See outro.ts.
   *
   * Passed in for the same reason `energy` is: it depends on the length of the whole
   * replay, which `renderFrame` deliberately does not know. Absent means the frame is
   * drawn as an ordinary one, which is what every caller that does not opt in gets.
   */
  outro?: number;
}

/** Pixel geometry derived entirely from width/height — no hardcoded positions. */
export interface Metrics {
  /** The chart drawing area. */
  plot: { x0: number; y0: number; x1: number; y1: number; width: number; height: number };
  /** Base unit for all sizing, so 1080x1080 and 1920x1080 both look right. */
  unit: number;
  hud: { top: number; lineHeight: number };
  bottomBar: { y0: number; height: number };
  axisWidth: number;
}
