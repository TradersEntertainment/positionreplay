/**
 * Finish the standalone build. SPEC §15.1 step 2.
 *
 * `output: 'standalone'` emits a self-contained server but deliberately does NOT copy
 * `.next/static` or `public` into it — Next assumes a CDN serves them. Nothing here
 * does, so without this the deployed app starts, renders HTML, and then 404s every
 * stylesheet and chunk. That exact failure cost a debugging cycle locally, presenting
 * as an unstyled page rather than as a missing file.
 *
 * The server's location is searched for rather than assumed: `outputFileTracingRoot`
 * decides how deeply it is nested, and that is computed from a path, so it can differ
 * between a developer's checkout and a build container. Hardcoding the nesting would
 * turn "deployed to a different directory" into a build failure with no clue in it.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(WEB, '.next', 'standalone');

/** Depth-first hunt for server.js; the tree is a handful of directories. */
function findServer(dir, depth = 0) {
  if (depth > 6) return null;
  if (existsSync(join(dir, 'server.js'))) return dir;
  for (const entry of readdirSync(dir)) {
    // node_modules is large and never contains the entry point.
    if (entry === 'node_modules') continue;
    const child = join(dir, entry);
    if (!statSync(child).isDirectory()) continue;
    const found = findServer(child, depth + 1);
    if (found) return found;
  }
  return null;
}

if (!existsSync(ROOT)) {
  throw new Error(
    `No standalone output at ${ROOT}. Run \`next build\` first, and check that ` +
      `next.config.ts still sets output: 'standalone'.`,
  );
}

const server = findServer(ROOT);
if (!server) {
  throw new Error(
    `Built ${ROOT} but found no server.js under it. The standalone layout changed; ` +
      `whatever directory holds server.js is what package.json's "start" must run.`,
  );
}

for (const [from, to] of [
  [join(WEB, '.next', 'static'), join(server, '.next', 'static')],
  [join(WEB, 'public'), join(server, 'public')],
]) {
  if (!existsSync(from)) continue;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`  copied ${relative(WEB, from)} -> ${relative(WEB, to)}`);
}

const entry = relative(WEB, join(server, 'server.js'));
console.log(`standalone ready: node ${entry}`);

// The start script names this path. If they ever disagree the deploy boots nothing, so
// say it here rather than letting the container fail with MODULE_NOT_FOUND.
const EXPECTED = join('.next', 'standalone', 'apps', 'web', 'server.js');
if (entry !== EXPECTED) {
  console.warn(
    `\n  WARNING: package.json "start" runs ${EXPECTED}, but the server was built at ` +
      `${entry}.\n  Update "start" to match, or the container will exit immediately.\n`,
  );
}
