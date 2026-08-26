/**
 * gif.js runs its encoder in a Web Worker loaded from a URL, so the worker file has to
 * be served. Copying it from node_modules at build time keeps a vendored copy out of
 * git while pinning it to the installed version.
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

try {
  const entry = createRequire(import.meta.url).resolve('gif.js/dist/gif.js');
  mkdirSync(publicDir, { recursive: true });
  copyFileSync(join(dirname(entry), 'gif.worker.js'), join(publicDir, 'gif.worker.js'));
  console.log('copied gif.worker.js -> public/');
} catch (error) {
  // Not fatal: the app still builds, and the GIF button reports the worker as missing
  // rather than producing a broken file.
  console.warn(`could not copy gif.worker.js: ${error instanceof Error ? error.message : error}`);
}
