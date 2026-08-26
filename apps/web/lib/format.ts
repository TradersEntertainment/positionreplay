/**
 * Browser-side formatting.
 *
 * Deliberately not shared with packages/renderer: those helpers are constrained to be
 * pure and host-agnostic for the export path, and pulling them into React components
 * would invite DOM-flavoured changes into a file M8 depends on staying clean.
 * Dates are UTC here for the same reason they are there — a shared link must read the
 * same for everyone who opens it.
 */

const usdFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatUsd(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${usdFormat.format(Math.abs(value))}`;
}

export function formatSignedUsd(value: number): string {
  return `${value > 0 ? '+' : ''}${formatUsd(value)}`;
}

export function formatSize(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}K`;
  if (abs >= 1) return abs.toFixed(2);
  return abs.toFixed(4);
}

export function formatPrice(value: number): string {
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 0 : abs >= 10 ? 2 : abs >= 1 ? 3 : 5;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatDate(ts: number): string {
  return `${new Date(ts).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

export function formatDuration(ms: number): string {
  if (ms < 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}
