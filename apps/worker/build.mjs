/**
 * Bundle the worker to a single file. SPEC §15.1 step 3: `node apps/worker/dist/index.js`.
 *
 * Bundled rather than compiled with tsc because the workspace packages export their
 * TypeScript sources (`"exports": "./src/index.ts"`), so there is no dist for tsc to
 * point at without restructuring all four of them. esbuild follows those sources and
 * emits one file, which also means production never loads a TypeScript loader.
 *
 * The three externals are things that cannot be bundled and must exist in node_modules
 * at runtime: two native modules, and one package resolved by path at runtime.
 */

import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // ESM output has no `require`; @napi-rs/canvas's loader wants one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  external: [
    // Native binding, loaded by better-sqlite3 at runtime.
    'better-sqlite3',
    // Prebuilt .node binaries; esbuild cannot inline them.
    '@napi-rs/canvas',
    // preflight.ts locates the font files with require.resolve, which needs the
    // package on disk rather than in the bundle.
    '@fontsource/jetbrains-mono',
  ],
});

console.log('worker bundled -> apps/worker/dist/index.js');
