# Trade Replay

Replay any trader's position from open to close as an animated, time-lapse chart.

`SPEC.md` is the source of truth. `CLAUDE.md` describes how to work on it.

## Status

| Milestone | State |
|---|---|
| **M1** core + Hyperliquid adapter + `episodes` CLI | Code complete, 165 tests green. **Live verification pending** — see `docs/VERIFYING-M1.md` |
| **M2** renderer + one-frame PNG | Complete |
| M3–M8 | Not started |

M1 is deliberately *not* marked done. SPEC §12 defines it as done when the numbers
match Hyperliquid's own UI, and the environment this was built in blocks every venue
API at the egress gateway. Everything that does not need the network is built and
tested; `docs/VERIFYING-M1.md` has the two commands that close it.

## Quick start

```bash
pnpm install

# Reconstruct an address's position episodes.
pnpm episodes 0x393d0b87ed38fc779fd9611144ae649ba6082109

# ...or offline, against a recorded fixture.
pnpm episodes 0x393d0b87ed38fc779fd9611144ae649ba6082109 --fixture synthetic

# Render one frame to out.png (M2).
pnpm render:still 0x393d0b87ed38fc779fd9611144ae649ba6082109 --fixture synthetic --size wide

pnpm test
pnpm typecheck
pnpm lint
```

Every command that hits the venue also accepts `--fixture`, which replays a recording
through the real adapter. Only the socket is swapped; the reconstruction being
exercised is the one that runs in production.

## Layout

```
packages/core        pure TS, zero deps: the §5 fold and the §6 timeline
packages/adapters    venue connectors; Hyperliquid so far
packages/renderer    pure Canvas 2D; runs in a browser AND in Node
apps/cli             episodes / render-still / verify:m1
scripts/             capture-hl, synthetic fixture generator
fixtures/            recorded and synthetic venue responses
```

Three boundaries are load-bearing and enforced, not just documented:

- **`packages/core` knows no venue.** ESLint forbids it importing from `adapters`.
- **`packages/renderer` is pure.** No DOM, no async, no network — ESLint forbids the
  globals, and M2 renders it under `@napi-rs/canvas` in plain Node, which is the real
  proof. Break this and M8's server-side MP4 export becomes impossible.
- **Venue shapes stop at the adapter.** Everything above speaks core types only.

## Data sources

Read-only, unauthenticated. No API key or private key is ever requested, stored or
logged, and nothing here places, modifies or cancels an order.

## Fixtures

`fixtures/hyperliquid/synthetic` is **generated and invented**. It is shaped like a
documented Hyperliquid response so the code paths run offline, and every output built
from it is stamped `SYNTHETIC DATA` — including the rendered PNG, because an export is
a screenshot someone posts as fact.

Real recordings come from `pnpm capture:hl <address>`.
