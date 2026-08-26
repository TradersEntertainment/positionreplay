/**
 * A row sparkline, drawn as an inline SVG polyline.
 *
 * SPEC §7 bans charting libraries; a polyline over normalized points is us drawing it.
 * Inline SVG rather than a canvas because there is one of these per table row, and a
 * canvas per row would mean a context, a device-pixel resize and a paint each.
 */

import type { ReactNode } from 'react';

export interface SparklineProps {
  /** Values already normalized to 0..1 by lib/data. */
  points: number[];
  positive: boolean;
  width?: number;
  height?: number;
}

export function Sparkline({
  points,
  positive,
  width = 96,
  height = 24,
}: SparklineProps): ReactNode {
  if (points.length < 2) {
    // No price data for this window — say nothing rather than draw a fake flat line.
    return <span className="inline-block text-tr-dim" style={{ width, height }} aria-hidden />;
  }

  const stroke = positive ? 'var(--color-tr-up)' : 'var(--color-tr-down)';
  const stepX = width / (points.length - 1);
  // SVG y grows downward; 1 is the high, so it maps to y = 0.
  const path = points
    .map((value, index) => `${(index * stepX).toFixed(2)},${((1 - value) * height).toFixed(2)}`)
    .join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block overflow-visible"
      role="img"
      aria-label={positive ? 'price path, position profitable' : 'price path, position at a loss'}
      data-testid="sparkline"
    >
      <polyline points={path} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}
