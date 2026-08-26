# Verifying M1

SPEC §12 defines M1 as done when *"the numbers match what Hyperliquid's own UI shows
for that wallet."* That check needs live venue data. This document is the exact
procedure, and the record of why it has not been run here.

## Status

**M1 is code-complete and its tests are green. It is NOT signed off.**

The environment this was built in blocks every venue API at the egress gateway:

```
$ curl -s -o /dev/null -w '%{http_code}' https://api.hyperliquid.xyz/info
000
# proxy log: "gateway answered 403 to CONNECT (policy denial)" — api.hyperliquid.xyz:443
```

`api.perpetuals.polymarket.com`, `gamma-api.polymarket.com` and `api.binance.com` are
blocked the same way. npm and GitHub are reachable, so everything except live venue
calls could be built and tested normally.

CLAUDE.md is explicit that a milestone is not complete because the code looks correct,
and that a venue's API contract must never be guessed at. So:

- Everything that does not need the network is done and verified: the §5 fold, the §6
  timeline, the adapter's pagination/validation/mapping, and 110 tests.
- The venue contract in `packages/adapters/src/hyperliquid/schemas.ts` is written from
  SPEC §4.3's field list. **It has not been checked against a live response.**
- No claim is made that the reconstructed numbers match Hyperliquid's UI.

## What is genuinely unverified

| Thing | Confidence | Why |
|---|---|---|
| §5 reconstruction fold | High | 300-seed fuzz test, every §11 case, notional reconciliation |
| §6 interval selection + frames | High | Unit-tested against the stated bounds |
| Fill field names (`px`, `sz`, `side`, `tid`, …) | High | Enumerated in SPEC §4.3 |
| `candleSnapshot` response shape | **Unverified** | SPEC gives the request, not the response |
| `userFunding` response shape | **Unverified** | Same |
| Real fills reconciling with the venue's UI | **Unverified** | Needs the network |

A mismatch in either unverified shape surfaces as a `VenueContractError` naming the
keys actually received — not as a wrong number. That was deliberate.

## Closing M1

Run these where `api.hyperliquid.xyz` is reachable.

```bash
pnpm install

# 1. Record the wallet's real fills, funding and candles.
pnpm capture:hl 0x393d0b87ed38fc779fd9611144ae649ba6082109

# 2. Run SPEC §5's sanity assertions against that real data.
pnpm verify:m1 0x393d0b87ed38fc779fd9611144ae649ba6082109 \
  --fixture 0x393d0b87ed38fc779fd9611144ae649ba6082109
```

`verify:m1` checks, mechanically:

1. **dir cross-check** — our derived open/close/flip agrees with Hyperliquid's own
   `dir` string on every fill (SPEC §4.3).
2. **closedPnl reconciliation** — our realized PnL agrees with the venue's reported
   value within 0.5% on every closing fill (SPEC §5).
3. **notional reconciliation** — sold minus bought equals realized PnL on every closed
   episode (SPEC §5).

Then it prints the episode table.

**Step 3 is human.** Open the wallet in Hyperliquid's UI and compare the table:
per-episode average entry, realized PnL, and fees. If they match, M1 is done. If they
do not, M1 is not done — and the delta is the bug, not a rounding artefact.

## If the capture fails

- **403 / "not in allowlist"** — egress policy, not the venue. The CLI says so and
  does not retry.
- **`VenueContractError`** — a real contract mismatch. The message lists the keys the
  venue actually sent. Fix `schemas.ts` against the live response; do not loosen the
  schema to make the error go away, because that is how a silent `undefined` reaches
  the PnL fold (SPEC §14).
- **`fill_history_truncated` warning** — the account has more than ~10,000 fills and
  Hyperliquid will not serve the older ones (SPEC §4.3). Episodes opened before the
  cutoff will have a wrong average entry. This is a venue limit, not a bug; the
  warning must stay visible in any UI built on top.
- **Zero fills** — check the address is the *main* account. Agent/API wallets return
  empty data (SPEC §4.3).

## Once real fixtures exist

Point the adapter tests at the captured fixture instead of the synthetic one
(`FIXTURE_DIR` in `packages/adapters/src/hyperliquid/adapter.test.ts`) and the
cross-checks in that file stop being circular: against the synthetic fixture they
confirm the plumbing, against a real one they confirm the venue agrees with us.
