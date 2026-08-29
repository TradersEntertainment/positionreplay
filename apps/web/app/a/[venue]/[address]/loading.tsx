/**
 * Something to look at while a trader's positions are reconstructed.
 *
 * This is a server component that fetches fills, pages through them and then fetches
 * candles per instrument, so a first, uncached load of a busy account takes real
 * seconds. Without a fallback the browser simply sits on the previous page and the
 * click reads as having done nothing.
 *
 * It matters more now that the front page features traders: those accounts are busy
 * ones — up to the ~10,000-fill ceiling of SPEC §4.3 — and they are the first thing a
 * new visitor clicks.
 */

export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl p-6" data-testid="episodes-loading">
      <div className="h-8 w-64 border border-tr-line bg-tr-panel" />
      <p className="mt-6 text-sm text-tr-dim">
        Reconstructing positions from this account&apos;s fills — a high-volume trader can
        take a moment.
      </p>
    </main>
  );
}
