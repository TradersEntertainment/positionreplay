# Trade Replay

Replay any trader's position from open to close as an animated, time-lapse chart.

`SPEC.md` is the source of truth. `CLAUDE.md` describes how to work on it.

## Status

| Milestone | State |
|---|---|
| **M1** core + Hyperliquid adapter + `episodes` CLI | Code complete, 165 tests green. **Live verification pending** — see `docs/VERIFYING-M1.md` |
| **M2** renderer + one-frame PNG | Complete |
| **M3** interactive player | Complete — 15/15 browser checks pass |
| **M4** episode browser + caching | Complete — 12/12 browser checks pass |
| **M5** client-side export | Complete — 11/11 browser checks pass |
| **M6** Polymarket Perps adapter | Complete — 11/11 browser checks pass |
| **M7** CSV adapter + Binance klines | Complete — 17/17 browser checks pass |
| M8 server MP4 worker | Not started |

M1 is deliberately *not* marked done. SPEC §12 defines it as done when the numbers
match Hyperliquid's own UI, and the environment this was built in blocks every venue
API at the egress gateway. Everything that does not need the network is built and
tested; `docs/VERIFYING-M1.md` has the two commands that close it.

## Quick start

```bash
pnpm install

# Reconstruct an address's position episodes.
pnpm episodes 0x393d0b87ed38fc779fd9611144ae649ba6082109

# The same, on Polymarket Perps. Only currently-open positions exist there — see below.
pnpm episodes 0x393d0b87ed38fc779fd9611144ae649ba6082109 --venue polymarket-perps

# A CSV of your own fills. In the web app you upload it; the CLI takes a fixture.
pnpm episodes --venue csv --fixture synthetic

# ...or offline, against a recorded fixture.
pnpm episodes 0x393d0b87ed38fc779fd9611144ae649ba6082109 --fixture synthetic

# Render one frame to out.png (M2).
pnpm render:still 0x393d0b87ed38fc779fd9611144ae649ba6082109 --fixture synthetic --size wide

# The web app (M3 player + M4 browser). Omit the env var to hit the live venue.
TRADE_REPLAY_FIXTURE=synthetic pnpm --filter @trade-replay/web dev

pnpm test
pnpm typecheck
pnpm lint
```

`pnpm verify:m3` and `pnpm verify:m4` drive the running app in a real Chromium: playback,
seeking, the keyboard and the interval override for M3; the episode table, every sort
order, sparklines and the cache for M4. Both need a server already up:

```bash
pnpm --filter @trade-replay/web build
cd apps/web && TRADE_REPLAY_FIXTURE=synthetic npx next start -p 3100 &
pnpm verify:m3
pnpm verify:m4
pnpm verify:m5
pnpm verify:m6
pnpm verify:m7
```

`verify:m7` uploads a CSV through the real browser flow, then proves the mapping step
is not decorative: it unmaps the fee column, re-applies, and checks the reconstructed
PnL moved by exactly the fees in the file. It also drives SPEC §4.6's fallback —
a symbol Binance does not list, replayed from a user-supplied OHLCV file.

`verify:m6` drives the venue toggle to the Perps browser, checks that option A's
limitation is stated on the page and not only in a doc, and samples the canvas pixels for
`markerLiquidation` — a colour used by nothing else — so a forced exit cannot silently
render as an ordinary close.

`verify:m5` downloads the real WebM and GIF and inspects their bytes — the EBML magic,
the GIF header's width field, and the animation-frame count. A button that appears to
work and a file that actually plays are different claims.

Every command that hits the venue also accepts `--fixture`, which replays a recording
through the real adapter. Only the socket is swapped; the reconstruction being
exercised is the one that runs in production.

## Layout

```
packages/core        pure TS, zero deps: the §5 fold and the §6 timeline
packages/adapters    venue connectors; Hyperliquid, Polymarket Perps and CSV
packages/renderer    pure Canvas 2D; runs in a browser AND in Node
packages/cache       SPEC §10 caching on SQLite via Drizzle
apps/web             Next.js browser + player + /api adapter proxies
apps/cli             episodes / render-still / verify:m1
scripts/             capture-hl / capture-pm / capture-binance, verify-m3…m7,
                     the three synthetic fixture generators
fixtures/            recorded and synthetic venue responses
```

Three boundaries are load-bearing and enforced, not just documented:

- **`packages/core` knows no venue.** ESLint forbids it importing from `adapters`.
- **`packages/renderer` is pure.** No DOM, no async, no network — ESLint forbids the
  globals, and M2 renders it under `@napi-rs/canvas` in plain Node, which is the real
  proof. Break this and M8's server-side MP4 export becomes impossible.
- **Venue shapes stop at the adapter.** Everything above speaks core types only.
- **The cache depends on adapters, never the reverse.** Inverting it would make the
  graph circular and drag a native SQLite binding into every bundle touching an adapter.

## Cache

`DATABASE_URL` (default `file:.data/cache.db`) holds raw venue responses, not
reconstructed episodes — the §5 fold re-runs on every read, so a later correction fixes
cached data too. Fixture runs get their own file so synthetic numbers can never mix with
real ones.

## Data sources

Read-only, unauthenticated. No API key or private key is ever requested, stored or
logged, and nothing here places, modifies or cancels an order.

## Fixtures

`fixtures/hyperliquid/synthetic` is **generated and invented**. It is shaped like a
documented Hyperliquid response so the code paths run offline, and every output built
from it is stamped `SYNTHETIC DATA` — including the rendered PNG, because an export is
a screenshot someone posts as fact.

`fixtures/polymarket-perps/synthetic` and `fixtures/csv/synthetic` are invented the same
way and stamped the same way.

Real recordings come from `pnpm capture:hl <address>`, `pnpm capture:pm <address>` and
`pnpm capture:binance <trades.csv>`.

Regenerating a fixture drops that fixture's cache database. SPEC §10 caches a closed
candle forever, which is right for a venue and wrong for a file that just changed —
without it the next run is served the old bars and the fixture looks unchanged.

## CSV upload

Drop any exchange export on `/`. No particular header names are required: the mapping
step guesses from the header, then from what the values look like, and every column can
be changed. The file is stored server-side under a hash of its content *and* its
mapping, which is what makes the replay link shareable — and means two mappings of one
file are two different documents rather than one link whose meaning silently changes.

Candles come from Binance public klines, so each symbol needs a Binance symbol
(`BTC` → `BTCUSDT`, suggested but never assumed). For anything Binance does not list,
upload your own OHLCV file for it instead — SPEC §4.6's fallback, and no network is
touched for those symbols at all.

Funding shows `—`: a trades file carries no funding payments, so there are none to read.

## Polymarket Perps: what it cannot show

The adapter runs SPEC §4.4.1's **option A**. `/v1/info/position-fills` serves only the
*currently open* cycle for an instrument, so:

- A Perps position that has already closed is **not replayable**. Not "empty" — gone.
  The endpoint returns nothing for it and no other public endpoint backfills it.
- Every Perps episode therefore reads `OPEN`, and the browser and the landing page both
  say so before an address is typed.
- **Funding shows `—`, not `$0.00`.** Per-account funding charges are authenticated-only
  (§4.4.2), and printing zero would assert that none was paid. The net PnL excludes it
  and says that it does.
- Perps *fills* are never cached, though candles still are. The open cycle is mutable by
  definition: cache it and the app would keep serving a position that has since closed.

A username → wallet resolver (§4.5) is deliberately **not** written. CLAUDE.md requires
verifying with curl that a Gamma-resolved wallet works against the Perps API first, and
that host is unreachable from this environment. §4.5 is explicit that shipping it
unverified is the worse outcome: it would return "no positions" for a valid trader and
read as a bug in the app.
