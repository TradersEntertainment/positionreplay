/**
 * Worker configuration. SPEC §15.
 *
 * "`web` and `worker` share adapter config. Use Railway shared variables so they
 * cannot drift. No API keys are required for any read path in this spec — if a key or
 * private key ever appears in the environment, something has gone wrong."
 *
 * Nothing here reads a secret, and nothing here can be made to: the worker's whole
 * input is a replayId, and every fetch it makes is a public read.
 */

import { hostname } from 'node:os';
import { join } from 'node:path';

/** See transport.ts: which of the two deployment shapes this worker is in. */
export type TransportKind = 'sqlite' | 'http';

export interface WorkerConfig {
  transport: TransportKind;
  /** Shared secret for the http transport. Not a venue key — see CLAUDE.md. */
  workerToken?: string;
  /** Where `web` serves /api/replay. SPEC §15's "internal HTTP endpoint". */
  webUrl: string;
  /** SPEC §10's SQLite file, shared with `web`. */
  databaseUrl: string;
  /** Finished MP4s. SPEC §15: "store output to object storage (or a volume)". */
  outputDir: string;
  /** How often the job table is polled. */
  pollMs: number;
  /**
   * How long a claim survives without a progress report.
   *
   * Longer than the slowest plausible gap between two frames, shorter than a person
   * will wait staring at a spinner.
   */
  leaseMs: number;
  /** Identifies this process in the job table, so a stuck claim can be attributed. */
  workerId: string;
  /** Cap on frames per job, so one pathological replay cannot fill the disk. */
  maxFrames: number;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}".`);
  }
  return Math.floor(value);
}

/**
 * Reject a value that is still the placeholder from the deploy guide.
 *
 * Pasting `<web ile AYNI değer>` into a token surfaces 2000 polls later as "Cannot
 * convert argument to a ByteString because the character at index 23 has a value of
 * 287" — technically the truth (HTTP headers are ASCII, and that is the `ğ`) and
 * useless to anyone trying to fix it. The angle brackets are the giveaway, and a
 * non-ASCII byte is worth naming on its own since it cannot go in a header at all.
 */
function requireRealValue(name: string, value: string): void {
  if (/[<>]/.test(value)) {
    throw new Error(
      `${name} is still a placeholder: "${value}". Replace it with the real value — ` +
        `see docs/DEPLOY-RAILWAY.md.`,
    );
  }
  const offender = [...value].findIndex((c) => c.charCodeAt(0) > 127);
  if (offender !== -1) {
    throw new Error(
      `${name} contains a non-ASCII character ("${value[offender]}" at position ${offender}), ` +
        `which cannot be sent in an HTTP header. Use letters, digits and punctuation only.`,
    );
  }
}

export function loadConfig(): WorkerConfig {
  const token = process.env['RENDER_WORKER_TOKEN'];
  const transport = process.env['RENDER_TRANSPORT'];
  if (transport !== undefined && transport !== 'sqlite' && transport !== 'http') {
    throw new Error(`RENDER_TRANSPORT must be "sqlite" or "http", got "${transport}".`);
  }

  const config: WorkerConfig = {
    // Defaulting to http when a token is present: on Railway the token is the thing
    // that has to be configured anyway, and a worker that quietly opened a local
    // SQLite file there would poll a database nothing else writes to.
    transport: transport ?? (token ? 'http' : 'sqlite'),
    ...(token ? { workerToken: token } : {}),
    webUrl: (process.env['WEB_URL'] ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    databaseUrl: process.env['DATABASE_URL'] ?? 'file:.data/cache.db',
    outputDir: process.env['RENDER_OUTPUT_DIR'] ?? join(process.cwd(), '.data', 'renders'),
    pollMs: intFromEnv('RENDER_POLL_MS', 2000),
    leaseMs: intFromEnv('RENDER_LEASE_MS', 120_000),
    workerId: process.env['WORKER_ID'] ?? `${hostname()}:${process.pid}`,
    maxFrames: intFromEnv('RENDER_MAX_FRAMES', 3000),
  };

  if (config.transport === 'http') {
    requireRealValue('WEB_URL', config.webUrl);
    if (config.workerToken !== undefined) requireRealValue('RENDER_WORKER_TOKEN', config.workerToken);
    try {
      new URL(config.webUrl);
    } catch {
      throw new Error(`WEB_URL is not a URL: "${config.webUrl}".`);
    }
  }

  return config;
}
