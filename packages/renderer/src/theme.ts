/**
 * SPEC §7.3: "Monospace throughout. Near-black background, teal/red candles, no
 * gradients, no rounded corners, no shadows. It should look like a terminal, not a
 * dashboard. Theme lives in one theme.ts object so a light theme is a config swap."
 */

import type { Theme } from './types.js';

export const darkTheme: Theme = {
  background: '#08090b',
  grid: '#15181d',
  axisText: '#59616e',
  candleUp: '#00d99a',
  candleDown: '#ff4757',
  lineStroke: '#00d99a',
  lineFill: 'rgba(0, 217, 154, 0.10)',
  entryLine: '#7a8698',
  entryPill: '#1b1f26',
  entryPillText: '#c6cedb',
  markerOpen: '#00d99a',
  markerClose: '#ff4757',
  markerFlip: '#ffa502',
  markerLiquidation: '#ff2d55',
  markerText: '#e6ebf2',
  hudText: '#e6ebf2',
  hudDim: '#59616e',
  pnlUp: '#00d99a',
  pnlDown: '#ff4757',
  notice: '#ffa502',
  watermark: '#2a2f38',
  fontFamily: '"JetBrains Mono", "IBM Plex Mono", monospace',
};

/** Proof that a light theme is a config swap and not a rewrite. */
export const lightTheme: Theme = {
  background: '#fbfbfa',
  grid: '#e6e6e3',
  axisText: '#7d7d78',
  candleUp: '#009e73',
  candleDown: '#d1394b',
  lineStroke: '#009e73',
  lineFill: 'rgba(0, 158, 115, 0.12)',
  entryLine: '#8a8a84',
  entryPill: '#eeeeeb',
  entryPillText: '#2b2b28',
  markerOpen: '#009e73',
  markerClose: '#d1394b',
  markerFlip: '#b8730a',
  markerLiquidation: '#c1121f',
  markerText: '#1c1c1a',
  hudText: '#1c1c1a',
  hudDim: '#7d7d78',
  pnlUp: '#009e73',
  pnlDown: '#d1394b',
  notice: '#b8730a',
  watermark: '#dcdcd8',
  fontFamily: '"JetBrains Mono", "IBM Plex Mono", monospace',
};
