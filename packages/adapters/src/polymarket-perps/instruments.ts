/**
 * The `symbol ↔ instrument_id` map. SPEC.md §4.4.2.
 *
 * "Fetch once at boot and cache a `symbol ↔ instrument_id` map. Every other Perps call
 * needs the integer id."
 */

import type { AdapterContext } from '../types.js';
import { createPerpsClient, PM_PERPS_API_BASE, PM_WEIGHTS } from './client.js';
import { PmInstrumentsSchema, type PmInstrument } from './schemas.js';

export interface InstrumentMap {
  byId: Map<number, PmInstrument>;
  bySymbol: Map<string, PmInstrument>;
  all: PmInstrument[];
}

interface CacheEntry {
  at: number;
  value: Promise<InstrumentMap>;
}

/** Instruments are listed, not delisted, often — but a stale map means an unknown id. */
const TTL_MS = 10 * 60_000;

const cache = new Map<string, CacheEntry>();

/** Drops the process-wide cache. For tests and for a long-running worker. */
export function resetInstrumentCache(): void {
  cache.clear();
}

function toMap(instruments: PmInstrument[]): InstrumentMap {
  return {
    byId: new Map(instruments.map((i) => [i.instrument_id, i])),
    bySymbol: new Map(instruments.map((i) => [i.symbol, i])),
    all: instruments,
  };
}

export async function loadInstruments(
  ctx: AdapterContext = {},
  baseUrl = PM_PERPS_API_BASE,
): Promise<InstrumentMap> {
  const now = (ctx.now ?? Date.now)();

  // Only the live path is cached. A caller that injected its own fetch is either a test
  // or a fixture replay, where a shared cache would leak state between runs and cost
  // nothing to skip.
  const shared = ctx.fetch === undefined;
  if (shared) {
    const hit = cache.get(baseUrl);
    if (hit && now - hit.at < TTL_MS) return hit.value;
  }

  const client = createPerpsClient(ctx, baseUrl);
  const promise = client
    .get('/v1/info/instruments', {}, PmInstrumentsSchema, 'instruments', PM_WEIGHTS.instruments)
    .then(toMap);

  if (shared) {
    cache.set(baseUrl, { at: now, value: promise });
    // A failed fetch must not be cached as the answer for the next ten minutes.
    promise.catch(() => cache.delete(baseUrl));
  }

  return promise;
}
