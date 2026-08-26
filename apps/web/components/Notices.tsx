/**
 * Adapter warnings and provenance, shown beside the chart.
 *
 * CLAUDE.md: "No fabricated numbers in the HUD. If a value is unavailable or
 * estimated, show it as unavailable or label it as an estimate." The same warnings are
 * also drawn onto the canvas by renderFrame, so they survive an export — this is the
 * on-page copy, not a replacement for that.
 */

import type { AdapterWarning } from '@trade-replay/adapters';
import type { ReactNode } from 'react';

export function Notices({
  warnings,
  provenanceWarning,
}: {
  warnings: AdapterWarning[];
  provenanceWarning?: string | undefined;
}): ReactNode {
  if (warnings.length === 0 && !provenanceWarning) return null;

  return (
    <div className="space-y-2" data-testid="notices">
      {provenanceWarning ? (
        <p className="border border-tr-down/50 bg-tr-down/10 p-3 text-xs text-tr-down">
          <span className="font-bold">NOT REAL DATA</span> — {provenanceWarning}
        </p>
      ) : null}

      {warnings.map((warning, index) => (
        <p
          key={`${warning.kind}-${index}`}
          className="border border-tr-notice/40 bg-tr-notice/10 p-3 text-xs text-tr-notice"
        >
          <span className="font-bold">[{warning.kind}]</span> {warning.message}
        </p>
      ))}
    </div>
  );
}
