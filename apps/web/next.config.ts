import type { NextConfig } from 'next';

const config: NextConfig = {
  // SPEC §15.1: required or the Railway start command has nothing to run.
  output: 'standalone',
  // The workspace packages ship TypeScript sources, not build output.
  transpilePackages: ['@trade-replay/core', '@trade-replay/renderer', '@trade-replay/adapters'],
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  // better-sqlite3 is a native binding: webpack cannot bundle a .node file, so it has
  // to be required at runtime from node_modules instead.
  serverExternalPackages: ['better-sqlite3'],

  webpack(config) {
    // The workspace packages are ESM TypeScript, so their relative imports carry the
    // `.js` extension the spec requires. Webpack needs telling that those resolve to
    // the `.ts` sources; tsc, tsx and vite already do this on their own.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },

  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
  },
};

export default config;
