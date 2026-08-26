# CLAUDE.md

## Read first

`SPEC.md` in this directory is the source of truth. Read it fully before writing
any code. If something here conflicts with SPEC.md, SPEC.md wins.

## How to work

**Build one milestone at a time.** SPEC.md §12 defines M1–M8 in order. Do not
start a milestone until the previous one runs and its tests pass. Do not
scaffold future milestones "while you're in there" — no placeholder files for
work not yet started.

At the start of a session, state which milestone you are on. At the end, state
what is done and what the next step is.

**Test-first for `packages/core`.** §5 (position reconstruction) and §6
(timeline) are pure functions and the highest-risk code in the project. Write
the failing test, then the implementation. This is not optional.

**Ask instead of assuming.** If the spec is ambiguous or a venue API returns
something the spec doesn't describe, stop and ask. Do not invent a plausible
field name and move on.

## Hard rules

- **Read-only.** Never write code that places, modifies, or cancels an order.
  Never request, store, or log a private key or seed phrase.
- **`renderFrame` stays pure.** No DOM APIs, no `window`/`document`, no async,
  no fetch. It must run unchanged under `@napi-rs/canvas` in Node. This is what
  makes server-side video export possible — breaking it breaks M8.
- **No charting libraries.** Not lightweight-charts, Chart.js, Recharts, or
  similar. Canvas 2D, drawn by us. See §7.
- **Adapters never leak.** Venue-specific shapes stop at the adapter boundary.
  `packages/core` and `packages/renderer` must not import from
  `packages/adapters` or know that Hyperliquid exists.
- **Zod every external response.** A silent `undefined` in the PnL fold produces
  a wrong number that looks right, which is worse than a crash.
- **No fabricated numbers in the HUD.** If a value is unavailable (leverage) or
  estimated (Perps funding), show it as unavailable or label it as an estimate.
  These outputs get exported as images and posted as fact.
- **Never guess at a venue's API contract.** If the docs are unclear, write a
  small script and check against the live endpoint before building on it.

## Verification before claiming done

- `pnpm test` passes, and new behaviour has a test.
- `pnpm typecheck` passes. No `any`, no `@ts-ignore`.
- For M1 specifically: reconstructed episode PnL matches what the venue's own UI
  shows for the same wallet. If it doesn't, the milestone is not done.

Do not report a milestone complete based on the code looking correct. Run it.

## Open decisions — do not resolve these alone

1. **Polymarket Perps history mode** (§4.4.1): option A, B, or C. Default to A.
2. **Address-space check** (§4.5): whether a Gamma-resolved wallet works against
   the Perps API. Verify with curl before writing the resolver.

If you reach either and no decision has been made, stop and ask.

## Commands

```bash
pnpm install
pnpm test          # vitest, watch off
pnpm typecheck
pnpm dev           # apps/web
pnpm episodes 0x…  # M1 CLI: print reconstructed episodes for an address
```
