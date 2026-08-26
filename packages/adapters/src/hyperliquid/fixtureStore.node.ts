/**
 * Node-only loader for a recorded fixture directory.
 *
 * Split from fixtureFetch.ts so that importing the replay logic never drags
 * `node:fs` into a browser bundle.
 *
 * Layout (written by `pnpm capture:hl`, and by scripts/make-synthetic-fixture.ts):
 *   <dir>/fills.json
 *   <dir>/funding.json
 *   <dir>/candles/<COIN>-<INTERVAL>.json
 *   <dir>/meta.json
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FixtureStore } from './fixtureFetch.js';

export interface FixtureMeta {
  provenance?: string;
  warning?: string;
  address?: string;
  capturedAt?: string;
  fillCount?: number;
}

export interface LoadedFixture extends FixtureStore {
  meta: FixtureMeta;
  /** Which candle sets exist, for error messages when one is missing. */
  availableCandles: string[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadFixtureStore(dir: string): LoadedFixture {
  if (!existsSync(dir)) {
    throw new Error(
      `No fixture directory at ${dir}. Generate the synthetic one with ` +
        `\`pnpm tsx scripts/make-synthetic-fixture.ts\`, or record a real one with \`pnpm capture:hl <address>\`.`,
    );
  }

  const fillsPath = join(dir, 'fills.json');
  if (!existsSync(fillsPath)) {
    throw new Error(`Fixture at ${dir} has no fills.json.`);
  }

  const fundingPath = join(dir, 'funding.json');
  const metaPath = join(dir, 'meta.json');
  const candlesDir = join(dir, 'candles');

  const candles = new Map<string, unknown[]>();
  const availableCandles: string[] = [];
  if (existsSync(candlesDir)) {
    for (const file of readdirSync(candlesDir)) {
      if (!file.endsWith('.json')) continue;
      const key = file.replace(/\.json$/, '');
      candles.set(key, readJson(join(candlesDir, file)) as unknown[]);
      availableCandles.push(key);
    }
  }

  return {
    fills: readJson(fillsPath) as unknown[],
    funding: existsSync(fundingPath) ? (readJson(fundingPath) as unknown[]) : [],
    candles,
    meta: existsSync(metaPath) ? (readJson(metaPath) as FixtureMeta) : {},
    availableCandles: availableCandles.sort(),
  };
}
