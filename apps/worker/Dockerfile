# The render worker. SPEC §15.1 step 4: "or give `worker` its own Dockerfile."
#
# A Dockerfile rather than builder configuration because ffmpeg has to be in the image
# and nothing else reliably puts it there: Nixpacks reads its config from the build
# root (so apps/worker/nixpacks.toml is never seen), and NIXPACKS_APT_PKGS does nothing
# when the platform builds with Railpack. This is the one option that does not depend
# on which builder the platform happens to default to this month.
#
# Build from the REPOSITORY ROOT, not from this directory:
#   docker build -f apps/worker/Dockerfile -t trade-replay-worker .
# The pnpm workspace needs the root lockfile and the packages/ sources.

FROM node:22-slim

# ffmpeg is the service's one system dependency, and src/preflight.ts refuses to boot
# without it *and* libx264 — Debian's ffmpeg package carries both. python3/make/g++ are
# for better-sqlite3, which falls back to compiling from source when no prebuilt binary
# matches the platform; without them that failure happens at install time with a
# node-gyp error that does not mention the compiler.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /app

# The workspace manifests first, so a change to source does not invalidate the install
# layer. Every package.json is needed: pnpm resolves the whole workspace graph even to
# install one filtered package.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY packages/renderer/package.json packages/renderer/
COPY packages/cache/package.json packages/cache/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile --filter @trade-replay/worker...

# The sources. The workspace packages export TypeScript directly, so the bundle in the
# next step reads these rather than any build output of their own.
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/worker/ apps/worker/

RUN pnpm --filter @trade-replay/worker build

# Not publicly exposed and it listens on nothing (SPEC §15): its only inbound work
# arrives by polling. There is no port to EXPOSE and no healthcheck endpoint to give.
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
