/**
 * Start the standalone server on an address the platform can actually reach.
 *
 * Next's standalone server takes its bind address from `process.env.HOSTNAME`. Docker
 * — and therefore Railway — sets HOSTNAME to the container id, so the server binds
 * that single interface and reports:
 *
 *     - Network: http://65f9735906d5:8080
 *
 * It then passes every check a process can pass: it starts, it is ready in 200ms, it
 * logs nothing wrong. The only symptom is the platform's healthcheck failing with
 * "service unavailable" until the deploy is marked dead — a failure that looks like the
 * app crashing and is nothing of the kind.
 *
 * HOSTNAME is a variable the platform sets for its own reasons, not one anybody chose
 * as a bind address, so defaulting it here is a correction rather than an override.
 * An explicit BIND_HOST still wins, for the case where binding one interface is meant.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(WEB, '.next', 'standalone', 'apps', 'web', 'server.js');

if (!existsSync(SERVER)) {
  console.error(
    `No standalone server at ${SERVER}.\n` +
      `  Run \`pnpm --filter @trade-replay/web build\` first — the build is what emits it.`,
  );
  process.exit(1);
}

process.env['HOSTNAME'] = process.env['BIND_HOST'] ?? '0.0.0.0';

await import(pathToFileURL(SERVER).href);
