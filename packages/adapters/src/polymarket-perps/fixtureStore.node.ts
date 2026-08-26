/**
 * Node-only loader for a recorded Perps fixture directory.
 *
 * Split from fixtureFetch.ts for the same reason as the Hyperliquid pair: importing the
 * replay logic must never drag `node:fs` into a browser bundle.
 *
 * Layout (written by scripts/make-perps-fixture.ts and by `pnpm capture:pm`):
 *   <dir>/instruments.json
 *   <dir>/portfolio.json
 *   <dir>/position-fills/<instrumentId>.json
 *   <dir>/fills/first.json, <dir>/fills/<cursor>.json
 *   <dir>/klines/<instrumentId>-<interval>.json
 *   <dir>/mark-history/<instrumentId>-1s.json
 *   <dir>/meta.json
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PerpsFixtureStore } from './fixtureFetch.js';

export interface PerpsFixtureMeta {
  provenance?: string;
  warning?: string;
  address?: string;
  mode?: string;
  capturedAt?: string;
}

export interface LoadedPerpsFixture extends PerpsFixtureStore {
  meta: PerpsFixtureMeta;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readDirInto<K>(dir: string, key: (file: string) => K): Map<K, unknown> {
  const out = new Map<K, unknown>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    out.set(key(file.replace(/\.json$/, '')), readJson(join(dir, file)));
  }
  return out;
}

export function loadPerpsFixtureStore(dir: string): LoadedPerpsFixture {
  if (!existsSync(dir)) {
    throw new Error(
      `No Perps fixture at ${dir}. Generate the synthetic one with ` +
        `\`pnpm tsx scripts/make-perps-fixture.ts\`, or record a real one with ` +
        `\`pnpm capture:pm <address>\`.`,
    );
  }

  const metaPath = join(dir, 'meta.json');

  return {
    instruments: readJson(join(dir, 'instruments.json')),
    portfolio: readJson(join(dir, 'portfolio.json')),
    positionFills: readDirInto(join(dir, 'position-fills'), Number),
    // `first` is the page served when the request carries no cursor at all.
    history: readDirInto(join(dir, 'fills'), (file) => (file === 'first' ? '' : file)),
    klines: readDirInto(join(dir, 'klines'), String),
    markHistory: readDirInto(join(dir, 'mark-history'), String),
    meta: existsSync(metaPath) ? (readJson(metaPath) as PerpsFixtureMeta) : {},
  };
}
