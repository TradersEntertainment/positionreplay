/**
 * Resolves where an adapter's data comes from: the live venue, or a recorded fixture.
 *
 * The fixture path exists because the venue APIs are not reachable from every
 * environment. It replays through the real adapter code, so the reconstruction being
 * exercised is the same one that runs in production — only the socket is swapped.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnlimitedLimiter } from '@trade-replay/adapters';
import type { AdapterContext, AdapterWarning } from '@trade-replay/adapters';
import { createFixtureFetch } from '@trade-replay/adapters/hyperliquid';
import { loadFixtureStore } from '@trade-replay/adapters/hyperliquid/fixtures';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface CliSource {
  ctx: AdapterContext;
  /** Collected as the adapter runs; print these, never swallow them. */
  warnings: AdapterWarning[];
  label: string;
  /** Set when the data is not real, so output can never be mistaken for fact. */
  provenanceWarning?: string;
}

export function resolveFixtureDir(nameOrPath: string): string {
  if (isAbsolute(nameOrPath) || nameOrPath.includes('/')) return nameOrPath;
  return join(REPO_ROOT, 'fixtures', 'hyperliquid', nameOrPath);
}

export function createSource(fixture?: string): CliSource {
  const warnings: AdapterWarning[] = [];
  const onWarning = (w: AdapterWarning): void => {
    warnings.push(w);
  };

  if (fixture === undefined) {
    return { ctx: { onWarning }, warnings, label: 'live Hyperliquid API' };
  }

  const dir = resolveFixtureDir(fixture);
  if (!existsSync(dir)) {
    throw new Error(
      `No fixture at ${dir}.\n` +
        `  Generate the synthetic one:  pnpm tsx scripts/make-synthetic-fixture.ts\n` +
        `  Or record a real one:        pnpm capture:hl <address>`,
    );
  }

  const store = loadFixtureStore(dir);

  return {
    ctx: {
      fetch: createFixtureFetch(store),
      limiter: createUnlimitedLimiter(),
      sleep: async () => undefined,
      onWarning,
    },
    warnings,
    label: `fixture ${dir.replace(REPO_ROOT, '')}`,
    ...(store.meta.warning ? { provenanceWarning: store.meta.warning } : {}),
  };
}
