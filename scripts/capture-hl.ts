/**
 * Record real Hyperliquid responses into a fixture directory.
 *
 *   pnpm capture:hl 0x393d0b87ed38fc779fd9611144ae649ba6082109
 *
 * Run this wherever `api.hyperliquid.xyz` is reachable. It drives the ordinary
 * adapter through a recording fetch, so what lands on disk is exactly what the live
 * venue returned — then `pnpm verify:m1 --fixture <name>` and the adapter tests can
 * check our reconstruction against real data anywhere.
 *
 * Read-only: fills, candles and funding. No key, no signature, no write path
 * (CLAUDE.md, hard rules).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { hyperliquidAdapter } from '@trade-replay/adapters';
import type { AdapterWarning, FetchLike } from '@trade-replay/adapters';
import { coinForInstrument } from '@trade-replay/adapters/hyperliquid';
import { HL_INTERVALS, buildEpisodes, pickInterval, seriesRangeFor } from '@trade-replay/core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || positionals.length === 0) {
  console.log(`
pnpm capture:hl <address> [--name <fixture-name>]

  Records this account's fills, funding and the candles its episodes need into
  fixtures/hyperliquid/<name>. Defaults <name> to the address.
`);
  process.exit(values.help ? 0 : 1);
}

const address = positionals[0]!;
const fixtureName = values.name ?? address.toLowerCase();
const outDir = join(ROOT, 'fixtures', 'hyperliquid', fixtureName);

/** Buckets the raw responses into the on-disk fixture layout as the adapter runs. */
const recorded = {
  fills: [] as unknown[],
  funding: [] as unknown[],
  candles: new Map<string, unknown[]>(),
};

const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
if (!globalFetch) throw new Error('This Node build has no global fetch.');

const recordingFetch: FetchLike = async (url, init) => {
  const response = await globalFetch(url, init);
  const text = await response.text();

  if (response.ok) {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const data = JSON.parse(text) as unknown[];

    if (body['type'] === 'userFillsByTime') recorded.fills.push(...data);
    else if (body['type'] === 'userFunding') recorded.funding.push(...data);
    else if (body['type'] === 'candleSnapshot') {
      const req = body['req'] as Record<string, unknown>;
      const key = `${String(req['coin'])}-${String(req['interval'])}`;
      recorded.candles.set(key, [...(recorded.candles.get(key) ?? []), ...data]);
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

const warnings: AdapterWarning[] = [];
const ctx = { fetch: recordingFetch, onWarning: (w: AdapterWarning) => warnings.push(w) };

function write(relative: string, data: unknown, compact = false): void {
  const path = join(outDir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)}\n`);
  console.log(`  wrote ${relative}`);
}

/** Dedupe by a key, since paginated windows can overlap at their boundaries. */
function dedupe<T>(items: T[], key: (item: T) => unknown): T[] {
  const seen = new Set<unknown>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

async function main(): Promise<void> {
  const input = await hyperliquidAdapter.parseInput(address, ctx);
  console.log(`Capturing ${input.address} -> fixtures/hyperliquid/${fixtureName}\n`);

  console.log('  fetching fills...');
  const fills = await hyperliquidAdapter.fetchFills(input, undefined, ctx);
  console.log(`    ${fills.length} fills`);

  if (fills.length === 0) {
    console.error('\nNo fills for this address — nothing to capture.');
    console.error('Check it is the MAIN account, not an agent/API wallet (SPEC §4.3).');
    process.exitCode = 1;
    return;
  }

  const range = {
    from: Math.min(...fills.map((f) => f.ts)),
    to: Math.max(...fills.map((f) => f.ts)),
  };

  console.log('  fetching funding...');
  const funding = (await hyperliquidAdapter.fetchFunding?.(input, range, ctx)) ?? [];
  console.log(`    ${funding.length} funding events`);

  const episodes = buildEpisodes(fills, { venue: 'hyperliquid', funding });
  console.log(`  reconstructed ${episodes.length} episodes`);

  // Record the interval each episode actually replays at, plus one step either side so
  // the UI's interval override still has data to work with offline.
  const wanted = new Set<string>();
  for (const episode of episodes) {
    const seriesRange = seriesRangeFor(episode, Date.now());
    const picked = pickInterval((episode.closedAt ?? Date.now()) - episode.openedAt, HL_INTERVALS);
    const index = HL_INTERVALS.findIndex((i) => i.name === picked.interval);
    const coin = coinForInstrument(episode.instrument);

    for (const offset of [-1, 0, 1]) {
      const neighbour = HL_INTERVALS[index + offset];
      if (neighbour) wanted.add(`${coin}|${neighbour.name}|${seriesRange.from}|${seriesRange.to}`);
    }
  }

  console.log(`  fetching ${wanted.size} candle sets...`);
  for (const entry of wanted) {
    const [coin, interval, from, to] = entry.split('|') as [string, string, string, string];
    try {
      await hyperliquidAdapter.fetchSeries(
        { instrument: `${coin}-PERP`, interval, from: Number(from), to: Number(to) },
        ctx,
      );
      console.log(`    ${coin} ${interval}`);
    } catch (error) {
      // A delisted market or a range past the venue's retention is expected for some
      // episodes; it should not abort the whole capture.
      console.log(`    ${coin} ${interval} — skipped (${error instanceof Error ? error.message.split('\n')[0] : error})`);
    }
  }

  console.log('');
  write(
    'fills.json',
    dedupe(recorded.fills, (f) => (f as { tid: number }).tid),
  );
  write(
    'funding.json',
    dedupe(recorded.funding, (f) => JSON.stringify(f)),
  );
  for (const [key, bars] of recorded.candles) {
    write(
      `candles/${key}.json`,
      dedupe(bars, (b) => (b as { t: number }).t),
      true,
    );
  }
  write('meta.json', {
    provenance: 'REAL — recorded from https://api.hyperliquid.xyz/info',
    address: input.address,
    capturedAt: new Date().toISOString(),
    fillCount: fills.length,
    episodeCount: episodes.length,
    warnings,
  });

  console.log(`\nDone. Verify against the venue's own UI with:`);
  console.log(`  pnpm verify:m1 ${input.address} --fixture ${fixtureName}`);
}

main().catch((error: unknown) => {
  console.error(`\nCapture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
