/**
 * Finish the standalone build. SPEC §15.1 step 2.
 *
 * `output: 'standalone'` emits a self-contained server but deliberately does NOT copy
 * `.next/static` or `public` into it — Next assumes a CDN serves them. Nothing here
 * does, so without this the deployed app starts, renders HTML, and then 404s every
 * stylesheet and chunk. That exact failure cost a debugging cycle locally, presenting
 * as an unstyled page rather than as a missing file.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const STANDALONE = join(WEB, '.next', 'standalone', 'apps', 'web');

if (!existsSync(STANDALONE)) {
  throw new Error(
    `No standalone output at ${STANDALONE}. Run \`next build\` first, and check that ` +
      `next.config.ts still sets output: 'standalone'.`,
  );
}

for (const [from, to] of [
  [join(WEB, '.next', 'static'), join(STANDALONE, '.next', 'static')],
  [join(WEB, 'public'), join(STANDALONE, 'public')],
]) {
  if (!existsSync(from)) continue;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`  copied ${from.replace(WEB, 'apps/web')} -> ${to.replace(WEB, 'apps/web')}`);
}

console.log('standalone ready: node apps/web/.next/standalone/apps/web/server.js');
