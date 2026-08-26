/**
 * Record real Polymarket Perps responses into a fixture directory.
 *
 *   pnpm capture:pm 0x393d0b87ed38fc779fd9611144ae649ba6082109
 *
 * Run where `api.perpetuals.polymarket.com` is reachable. It drives the ordinary
 * adapter through a recording fetch, so what lands on disk is exactly what the live
 * venue returned — which is the only way the schemas in polymarket-perps/schemas.ts get
 * checked against reality (see docs/VERIFYING-M1.md).
 *
 * TIMING MATTERS HERE. Option A means the venue serves only the account's *current open
 * cycle*: whatever is open at the moment you run this is all that can ever be recorded,
 * and it becomes unreachable the instant the position closes.
 *
 * Read-only. No key, no signature, no write path.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { polymarketPerpsAdapter } from '@trade-replay/adapters';
import type { AdapterWarning, FetchLike } from '@trade-replay/adapters';
import { buildEpisodes, pickInterval, seriesRangeFor } from '@trade-replay/core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { name: { type: 'string' }, help: { type: 'boolean', default: false } },
});

if (values.help || positionals.length === 0) {
  console.log(`
pnpm capture:pm <address> [--name <fixture-name>]

  Records this account's OPEN Perps positions, their fills and the candles they need
  into fixtures/polymarket-perps/<name>. Defaults <name> to the address.

  Only positions open at the moment you run this can be captured (SPEC §4.4.1 option A).
`);
  process.exit(values.help ? 0 : 1);
}

const address = positionals[0]!;
const fixtureName = values.name ?? address.toLowerCase();
const outDir = join(ROOT, 'fixtures', 'polymarket-perps', fixtureName);

const recorded = {
  instruments: undefined as unknown,
  portfolio: undefined as unknown,
  positionFills: new Map<string, unknown>(),
  klines: new Map<string, unknown>(),
  markHistory: new Map<string, unknown>(),
};

const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
if (!globalFetch) throw new Error('This Node build has no global fetch.');

const recordingFetch: FetchLike = async (rawUrl, init) => {
  const response = await globalFetch(rawUrl, init);
  const text = await response.text();

  if (response.ok) {
    const url = new URL(rawUrl);
    const params = url.searchParams;
    const data = JSON.parse(text) as unknown;

    if (url.pathname === '/v1/info/instruments') recorded.instruments = data;
    else if (url.pathname === '/v1/info/public-portfolio') recorded.portfolio = data;
    else if (url.pathname === '/v1/info/position-fills') {
      recorded.positionFills.set(String(params.get('instrument_id')), data);
    } else if (url.pathname === '/v1/info/klines') {
      merge(recorded.klines, `${params.get('instrument_id')}-${params.get('interval')}`, data);
    } else if (url.pathname === '/v1/info/mark-history') {
      merge(recorded.markHistory, `${params.get('instrument_id')}-${params.get('interval')}`, data);
    }
  }

  // The adapter still has to read the body, so hand back a replayable response.
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text: async () => text,
  };
};

/** Paginated endpoints arrive in pages; keep every row, deduped by timestamp. */
function merge(store: Map<string, unknown>, key: string, data: unknown): void {
  const incoming = (data as { data?: [number, ...number[]][] }).data ?? [];
  const existing = (store.get(key) as { data?: [number, ...number[]][] } | undefined)?.data ?? [];
  const byTime = new Map<number, [number, ...number[]]>();
  for (const row of [...existing, ...incoming]) byTime.set(row[0], row);
  store.set(key, {
    data: [...byTime.values()].sort((a, b) => a[0] - b[0]),
    more: false,
  });
}

const warnings: AdapterWarning[] = [];
const ctx = { fetch: recordingFetch, onWarning: (w: AdapterWarning) => warnings.push(w) };

function write(relative: string, data: unknown, compact = false): void {
  const path = join(outDir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)}\n`);
  console.log(`  wrote ${relative}`);
}

async function main(): Promise<void> {
  const input = await polymarketPerpsAdapter.parseInput(address, ctx);
  console.log(`Capturing ${input.address} -> fixtures/polymarket-perps/${fixtureName}\n`);

  console.log('  fetching open positions and their fills...');
  const fills = await polymarketPerpsAdapter.fetchFills(input, undefined, ctx);
  console.log(`    ${fills.length} fills`);

  if (fills.length === 0) {
    console.error('\nNo open Perps positions for this address — nothing to capture.');
    console.error('Option A can only record positions that are open right now (SPEC §4.4.1).');
    process.exitCode = 1;
    return;
  }

  const episodes = buildEpisodes(fills, { venue: 'polymarket-perps' });
  console.log(`  reconstructed ${episodes.length} open episodes`);

  const wanted = new Set<string>();
  for (const episode of episodes) {
    const range = seriesRangeFor(episode, Date.now());
    const picked = pickInterval(
      Date.now() - episode.openedAt,
      polymarketPerpsAdapter.intervals,
    );
    const index = polymarketPerpsAdapter.intervals.findIndex((i) => i.name === picked.interval);

    // The chosen interval plus a neighbour either side, so the UI override still has
    // data offline.
    for (const offset of [-1, 0, 1]) {
      const neighbour = polymarketPerpsAdapter.intervals[index + offset];
      if (neighbour) {
        wanted.add(`${episode.instrument}|${neighbour.name}|${range.from}|${range.to}`);
      }
    }
  }

  console.log(`  fetching ${wanted.size} series...`);
  for (const entry of wanted) {
    const [instrument, interval, from, to] = entry.split('|') as [string, string, string, string];
    try {
      await polymarketPerpsAdapter.fetchSeries(
        { instrument, interval, from: Number(from), to: Number(to) },
        ctx,
      );
      console.log(`    ${instrument} ${interval}`);
    } catch (error) {
      console.log(
        `    ${instrument} ${interval} — skipped (${error instanceof Error ? error.message.split('\n')[0] : error})`,
      );
    }
  }

  console.log('');
  write('instruments.json', recorded.instruments);
  write('portfolio.json', recorded.portfolio);
  for (const [id, data] of recorded.positionFills) write(`position-fills/${id}.json`, data);
  for (const [key, data] of recorded.klines) write(`klines/${key}.json`, data, true);
  for (const [key, data] of recorded.markHistory) write(`mark-history/${key}.json`, data, true);
  write('meta.json', {
    provenance: 'REAL — recorded from https://api.perpetuals.polymarket.com',
    mode: 'A — open positions only (SPEC §4.4.1)',
    address: input.address,
    capturedAt: new Date().toISOString(),
    fillCount: fills.length,
    episodeCount: episodes.length,
    warnings,
  });

  console.log(`\nDone. Check the reconstruction against the venue's own UI with:`);
  console.log(`  pnpm verify:m1 ${input.address} --venue polymarket-perps --fixture ${fixtureName}`);
}

main().catch((error: unknown) => {
  console.error(`\nCapture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
