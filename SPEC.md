# SPEC.md — Trade Replay

> Replay any trader's position from open to close as an animated, time-lapse chart.
> Interactive in the browser, exportable as video/GIF for sharing.

---

## 0. One-liner

Give the app a wallet address (or a CSV). It finds every completed **position episode**, and lets you play back the price action from the moment the position opened until it closed — with entry line, scale-in/scale-out markers, and live-updating PnL / fees / funding.

---

## 1. Core concepts (use these names in code)

| Term | Meaning |
|---|---|
| `Fill` | A single execution. Normalized across venues. |
| `PositionEpisode` | A contiguous span where net size on one instrument goes `0 → non-zero → 0`. This is the unit that gets replayed. A flip (long→short in one fill) closes one episode and opens the next at the same timestamp. |
| `PriceSeries` | OHLCV candles (perps) or a `(t, price)` line (Polymarket). Common interface, two shapes. |
| `Frame` | One rendered step of the replay. `frames[i]` = position state as of `series[i].time`. |
| `ReplayState` | Everything the renderer needs for one frame. Serializable, no DOM refs. |
| `Adapter` | Venue-specific module that produces `Fill[]` + `PriceSeries`. |

**Non-negotiable rule:** the renderer never touches an adapter, an API, or React state. It receives a `ReplayState` and a canvas context. This is what makes video export possible.

---

## 2. Tech stack

- **Monorepo:** pnpm workspaces + Turborepo
- **Web:** Next.js 15 (App Router), TypeScript strict, Tailwind v4
- **Core logic:** plain TypeScript, zero deps, 100% unit-testable (Vitest)
- **Charting:** custom Canvas 2D renderer. **Do not use lightweight-charts / Chart.js / Recharts.** See §7.
- **Export MVP:** in-browser `MediaRecorder` on `canvas.captureStream()` → WebM, plus `gif.js` worker for GIF
- **Export V2:** Node worker, `@napi-rs/canvas` (or Puppeteer) → PNG frames → `ffmpeg` → MP4 (H.264, yuv420p — required for X/Twitter)
- **Cache/store:** SQLite (`better-sqlite3`) via Drizzle, on a Railway persistent volume. Drizzle is here so the Postgres migration is cheap later — see §15.
- **Validation:** Zod on every external API response boundary
- **Deploy:** Railway, one project, multiple services. See §15.

---

## 3. Repo structure

```
trade-replay/
├─ packages/
│  ├─ core/                    # pure TS, no I/O, no DOM
│  │  ├─ types.ts              # Fill, PositionEpisode, PriceSeries, ReplayState
│  │  ├─ episodes.ts           # fills[] -> PositionEpisode[]
│  │  ├─ pnl.ts                # avg entry, realized, unrealized, fees, funding
│  │  ├─ timeline.ts           # episode + series -> Frame[]
│  │  └─ *.test.ts
│  ├─ renderer/                # pure draw, works in browser AND node-canvas
│  │  ├─ render.ts             # renderFrame(ctx, state, theme, layout)
│  │  ├─ layers/               # grid, candles, entryLine, markers, hud, watermark
│  │  ├─ scale.ts              # eased auto-scaling y-axis + x compression
│  │  └─ theme.ts
│  └─ adapters/
│     ├─ types.ts              # Adapter interface
│     ├─ hyperliquid/
│     ├─ polymarket-perps/
│     └─ csv/
├─ apps/
│  ├─ web/                     # Next.js (Railway service: web)
│  └─ worker/                  # Node: ffmpeg render jobs + optional Perps poller
```

---

## 4. Data layer

### 4.1 Adapter interface

```ts
export interface Adapter {
  id: 'hyperliquid' | 'polymarket-perps' | 'csv';

  /** Validate + normalize whatever the user typed/uploaded. */
  parseInput(raw: string | File): Promise<AdapterInput>;

  /** All fills for this account, newest-first NOT guaranteed — core sorts. */
  fetchFills(input: AdapterInput, range?: TimeRange): Promise<Fill[]>;

  /** Price data covering [from, to], at the requested granularity. */
  fetchSeries(req: SeriesRequest): Promise<PriceSeries>;

  /** Optional: perp funding payments inside the window. */
  fetchFunding?(input: AdapterInput, range: TimeRange): Promise<FundingEvent[]>;
}
```

### 4.2 Normalized types

```ts
type Side = 'buy' | 'sell';

interface Fill {
  id: string;            // venue-unique; dedupe key
  ts: number;            // epoch ms
  instrument: string;    // "HYPE-PERP" | "pm:1" (perps instrument_id) | "BTCUSDT"
  displayName: string;   // "HYPE PERP" | "BTC-PERP"
  side: Side;
  price: number;
  size: number;          // absolute, in base units / shares
  fee: number;           // positive = paid
  closedPnl?: number;    // venue-reported realized PnL for this fill, if available
  dir?: string;          // venue's own label e.g. "Open Long"
  raw: unknown;          // keep original for debugging
}

interface PositionEpisode {
  id: string;
  instrument: string;
  displayName: string;
  venue: Adapter['id'];
  direction: 'long' | 'short';
  openedAt: number;
  closedAt: number | null;   // null = still open
  fills: Fill[];             // chronological, includes both open and close legs
  peakSize: number;
  avgEntry: number;          // final weighted avg entry
  realizedPnl: number;
  totalFees: number;
  totalFunding: number;
  boughtNotional: number;
  soldNotional: number;
}
```

### 4.3 Hyperliquid adapter

Base: `POST https://api.hyperliquid.xyz/info`, JSON body, **no auth, no API key**.

- **Fills:** `{"type":"userFillsByTime","user":"0x...","startTime":<ms>,"endTime":<ms>,"aggregateByTime":true}`
  - Max **2000 fills per response** → paginate by advancing `startTime` to `lastFill.time + 1`.
  - **Hard limit: only the most recent ~10,000 fills are available via API.** For heavy traders / old trades this will silently truncate. Detect it (asked-for range vs. oldest returned fill) and show an explicit warning in the UI: *"Fill history unavailable before <date> — Hyperliquid API limit."* For a future backfill, HL publishes historical data to an S3 bucket.
  - `aggregateByTime: true` merges partial fills from one crossing order — **use it**, it makes markers much cleaner.
  - Fill fields to map: `coin, px, sz, side ("A"=sell/ask, "B"=buy/bid), time, startPosition, dir, closedPnl, fee, feeToken, hash, oid, tid, crossed`.
  - `dir` is a free lunch: it already says `"Open Long"` / `"Close Long"` / `"Long > Short"` etc. **Use it as a cross-check against our own reconstruction, not as the source of truth** — assert they agree in tests.
- **Candles:** `{"type":"candleSnapshot","req":{"coin":"HYPE","interval":"1h","startTime":<ms>,"endTime":<ms>}}`
  - Max **5000 candles** per response, and only the most recent 5000 exist for a given interval. Long-held positions on `1m` will not fit → interval auto-selection in §6.1 must respect this.
  - Intervals: `1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1M`
  - HIP-3 markets need a dex prefix (`"xyz:XYZ100"`). Handle the prefix if present in `coin`.
- **Funding:** `{"type":"userFunding","user":"0x...","startTime":<ms>,"endTime":<ms>}` — same 2000-item pagination.
- **Rate limits:** IP-based weight budget (~1200/min). `userFills*` and `userFunding` cost extra weight *per 20 items returned*; `candleSnapshot` *per 60 items returned*. Implement a token-bucket limiter in the adapter and **always cache candles to SQLite keyed by `(coin, interval, bucketStart)`** — candle data is immutable once closed.
- **Gotcha:** always query the *main* account address. Agent/API wallet addresses return empty or wrong data.
- **Leverage is not in the fill data.** HL gives current leverage via `clearinghouseState`, but not historical. So: derive nothing. Show leverage as a **user-editable overlay field** (default hidden). Do not fabricate a number in the HUD.

### 4.4 Polymarket **Perps** adapter

> This is Polymarket **Perps** (`https://api.perpetuals.polymarket.com`), NOT the
> prediction-market CLOB. Different host, different auth, different data model.
> Perps are perpetual contracts tracking crypto / index / equity / commodity
> underlyings. They do not expire and do not resolve. Collateral is pUSD.
> Instruments are identified by **integer `instrument_id`**, not by symbol string.
> Perps is in early access and gated behind a referral code — but the read
> endpoints below are unauthenticated.

#### 4.4.1 ⚠️ THE BLOCKER — read this before writing any Perps code

**There is no public endpoint for closed-position fill history.** This directly
conflicts with the "paste any address" product goal. Verified against the docs:

| Endpoint | Auth | What it actually gives us |
|---|---|---|
| `GET /v1/info/position-fills?address=&instrument_id=` | **public** (`security: []`) | Every fill in the account's **current open position cycle only.** Returns an empty page if the account is flat. |
| `GET /v1/info/public-portfolio?address=` | **public** | Equity + **open** positions only |
| `GET /v1/info/fills` (Get Fills) | **authenticated** | Full fill history — but only for *your own* account, via a proxy API secret |

So, for an arbitrary address, we can replay a position **only while it is still
open.** The moment it closes, that history becomes unreachable. A closed
Hyperliquid trade is replayable forever; a closed Perps trade is not.

Three ways out — pick one explicitly, do not let this get decided by accident:

- **(A) Open positions only.** Perps addresses show currently-open positions,
  replayable up to now. Honest, small, ships immediately. Label it in the UI.
- **(B) Own-account mode.** User authenticates with their own proxy credentials
  and gets full history for themselves. Requires handling an API secret →
  server-side only, never in the browser, never persisted in plaintext. Breaks
  the "any address" promise but is the only route to *complete* history.
- **(C) Build our own index.** Poll `/v1/info/position-fills` for a watchlist of
  addresses on a schedule (and/or consume the public trades WebSocket), persist
  every fill we see. History accrues from the day we start; nothing before that.
  This is the real long-term answer for a public product, and it is a genuine
  backend, not a weekend feature.

**Recommendation: ship (A) in M6, design the storage schema so (C) is a later
add, treat (B) as optional.** Note (C) only works if the position is caught
while open, so the poller must run continuously and cheaply.

Also flag: cycle discovery for positions inherited from a gateway snapshot is
capped at 250,000 account-history rows and returns **413** for cycles older than
that bound. Handle 413 as "history too old", not as a generic failure.

#### 4.4.2 Public endpoints we use

Base: `https://api.perpetuals.polymarket.com`

- `GET /v1/info/instruments` → `instrument_id, symbol ("BTC-PERP"), category,
  base_asset, quote_asset, funding_interval, quantity_decimals, price_decimals,
  max_leverage, isolated_only, risk_tiers[]`.
  **Fetch once at boot and cache a `symbol ↔ instrument_id` map.** Every other
  Perps call needs the integer id.
- `GET /v1/info/klines?instrument_id=&interval=&start_timestamp=&end_timestamp=`
  → `{ data: [[ts, o, h, l, c, volume, trades], ...], more: bool }`.
  **Max 1000 candles per request**, `more` flag drives continuation. Note the
  tuple-array shape — not objects like Hyperliquid.
- `GET /v1/info/mark-history?instrument_id=&interval=1s&start_timestamp=` →
  `{ data: [[bucket_open_ms, last_mark_price], ...], more }`. Max 1000 points.
  **`1s` granularity is available here** — this is the fix for very short
  positions (spec §11 case 6) where 1m candles give you four bars. Only buckets
  containing at least one mark update are returned, so the series is sparse:
  forward-fill before rendering.
  Mark price (not last trade price) is what drives margin and liquidation, so
  for a PnL replay this is arguably the *more correct* series. Consider making
  it the default and candles the toggle.
- `GET /v1/info/funding?instrument_id=&start_timestamp=&end_timestamp=` →
  funding **rate** history, max 100 per request. This is the rate, not the
  account's paid amount — per-account funding charges are authenticated only.
  So `episode.totalFunding` is an *estimate* for Perps unless in mode (B).
  Label it as such in the HUD; do not silently present an estimate as a fact.
- `GET /v1/info/trades?instrument_id=` → public tape, max 100 per request.
- `GET /v1/info/tickers` → snapshot; may be up to 10s stale, and returns **503
  rather than stale data** when that bound can't be met. Treat 503 as transient,
  retry with backoff.

#### 4.4.3 Fill shape (`AccountTradeData`)

`trade_id, order_id, instrument_id, side ("long"|"short"), price, quantity,
taker, fee, fee_asset, previous_size, previous_entry_price, pnl, timestamp,
liquidation, adl, hash`

Three things here are gifts — use them:

- **`previous_size` + `previous_entry_price`** give the exact position state
  *before* each fill. This is a direct oracle for our reconstruction (§5):
  assert our computed `netSize`/`avgEntry` equals these on every fill. Better
  validation than anything Hyperliquid offers.
- **`pnl`** is the venue's realized PnL for the fill. Same rule as HL: prefer it,
  log deltas.
- **`liquidation` and `adl` booleans.** Render these as visually distinct
  markers — a liquidation is the single most interesting frame in a replay, and
  no other venue in this spec hands it to us as a flag. Do not collapse them
  into a generic "close" marker.

Note `side` is `"long"`/`"short"`, not buy/sell — map to our `Side` at the
adapter boundary, and be careful: a `"long"` fill can be *closing* a short.
Determine open vs. close from `previous_size`, not from `side`.

Prices and quantities are **decimal strings**. Parse deliberately (respect
`price_decimals` / `quantity_decimals` from the instrument), and consider
keeping them as scaled integers through the PnL fold.

#### 4.4.4 Rate limits

Per-IP token bucket, and endpoints carry explicit request weights
(`position-fills` is weight 10, dropping to 1 when served from its 2s cache).
`429` responses carry a `Retry-After` header in whole seconds and an `error`
field distinguishing `ip_rate_limited` from `action_rate_limited` — **honor
`Retry-After`**, don't use blind exponential backoff when the server told us the
number. Also handle `408` (body timeout) and `413`.

#### 4.4.5 What is NOT in scope

The old prediction-market CLOB (`clob.polymarket.com`, `gamma-api`,
`data-api`, 0–1 outcome tokens, `prices-history`, market resolution) is a
**separate venue** and is out of scope for v1. If it's added later it becomes a
fourth adapter (`polymarket-predictions`) — its price series is a line in
0.00–1.00 with resolution-based closes, so the `PriceSeries` union in §4.2 stays
as designed. Do not mix the two behind one adapter.


### 4.5 Identity resolution (username → address)

The input box accepts more than a raw `0x...`. Sniff the input and route it:

```
/^0x[a-fA-F0-9]{40}$/     -> address, use directly
/\.eth$/                  -> ENS, resolve via a mainnet RPC (viem `getEnsAddress`)
otherwise                 -> treat as a Polymarket username, resolve via search
```

**Polymarket username lookup** (public, no auth):

```
GET https://gamma-api.polymarket.com/public-search?q=<query>
-> { events: [...], tags: [...], profiles: [{ pseudonym, wallet }], pagination }
```

Take `profiles[]`. If more than one match, **show a disambiguation list rather
than silently picking `profiles[0]`** — rendering the wrong trader's position
under someone's name is the worst failure mode this app has.

**Reverse direction** (address → display name/avatar):
`GET https://gamma-api.polymarket.com/profile/...` (see the "Get public profile
by wallet address" reference). Use it to put a name and avatar in the HUD — it
makes the exported image far more shareable than a truncated hex string.

#### ⚠️ Unverified assumption — test this before building on it

The `wallet` returned by Gamma search is the **Predictions**-side profile
address. Perps is a separate system with its own proxy accounts and pUSD
collateral, and **the docs do not state that these are the same address.**

Verify empirically before writing the resolver:

```bash
# 1. resolve a known perps trader's name
curl "https://gamma-api.polymarket.com/public-search?q=<known_trader>"
# 2. feed the returned wallet to the Perps API
curl -G "https://api.perpetuals.polymarket.com/v1/info/public-portfolio" \
  --data-urlencode "address=<wallet_from_step_1>"
```

- Non-empty portfolio → same address space, resolver works as designed.
- Empty → the two are distinct. Username→Perps mapping then needs another route
  (a Perps-side profile endpoint, or user-supplied address only). **Do not ship
  a resolver that silently returns "no positions" for a valid trader** — that
  reads as a bug in our app, not as an address mismatch.

**Hyperliquid has no username system.** Address or ENS only. Do not build a UI
affordance implying otherwise; if the venue is HL and the input isn't an address
or ENS, say so plainly.

Cache resolutions (`query → address`) with a TTL — usernames are mutable, so a
permanent cache will eventually serve a stale mapping.

### 4.6 CSV adapter

Accept a permissive CSV, map columns via a UI step (don't hard-require header names).

Required: `timestamp` (ISO8601 or epoch s/ms — sniff it), `symbol`, `side`, `price`, `size`
Optional: `fee`, `leverage`, `note`

Price data for CSV trades comes from **Binance public klines** (`GET https://api.binance.com/api/v3/klines?symbol=&interval=&startTime=&endTime=&limit=1000`, no auth, paginate). Provide a symbol-mapping step (`BTC` → `BTCUSDT`). If mapping fails or the symbol is unknown, fall back to letting the user upload their own OHLCV CSV.

---

## 5. Position reconstruction (`packages/core/episodes.ts`)

The single most important and most bug-prone part. Write this test-first.

```
Algorithm:
1. Sort fills by (ts asc, id asc). Dedupe by id.
2. Group by instrument.
3. For each group, fold left maintaining: netSize (signed), avgEntry, realized, fees.
4. For each fill:
   signedDelta = side === 'buy' ? +size : -size
   
   a) If netSize === 0:
        -> START new episode. direction = sign(signedDelta).
   
   b) Else if sign(signedDelta) === sign(netSize):   // SCALE IN
        avgEntry = (avgEntry*|netSize| + price*|signedDelta|) / (|netSize| + |signedDelta|)
        netSize += signedDelta
   
   c) Else:                                          // REDUCE / CLOSE / FLIP
        closedQty = min(|signedDelta|, |netSize|)
        pnl = (price - avgEntry) * closedQty * (netSize > 0 ? +1 : -1)
        realized += fill.closedPnl ?? pnl        // prefer venue value, log any mismatch > 0.5%
        netSize += signedDelta
        
        if netSize === 0:  -> CLOSE episode at fill.ts
        if sign flipped:   -> CLOSE episode at fill.ts, then IMMEDIATELY START a new
                              episode with the remainder, same ts, avgEntry = price
   
   fees += fill.fee   (attribute to the currently open episode)

5. If netSize !== 0 at the end -> episode.closedAt = null (still open).
6. Attribute FundingEvents to whichever episode was open at that timestamp.
```

**Float safety:** never compare sizes with `=== 0`. Use an epsilon derived from the instrument's size decimals (`Math.abs(netSize) < 1e-9`). Better: do all size/price math in scaled integers if it turns out flaky. Add a fuzz test that replays random fill sequences and asserts `netSize` returns to exactly zero.

**Sanity assertions (fail loudly in dev):**
- Our computed `realized` vs. sum of `fill.closedPnl` — within 0.5%
- Our derived open/close direction vs. HL's `dir` string — exact match
- `boughtNotional - soldNotional` reconciles with realized + holding value

---

## 6. Replay timeline (`packages/core/timeline.ts`)

### 6.1 Interval auto-selection

```
duration = (closedAt ?? now) - openedAt
padBefore = duration * 0.15    // show context before entry
padTarget = duration * 0.05    // small tail after exit
targetFrames = 200             // tune: 120..400

pick the venue interval whose count over (duration + pads) is closest to
targetFrames, while satisfying:
  - resulting count <= 5000 (HL hard cap)
  - resulting count >= 40   (else the replay looks like a slideshow)
```

Expose an interval override in the UI. Show the picked interval in the HUD.

### 6.2 Frame generation

`buildFrames(episode, series, funding) -> Frame[]`

For frame `i` (covering `series[i]`):
```ts
interface Frame {
  t: number;                    // series[i] close time
  visibleUpTo: number;          // index i
  markPrice: number;            // series[i].close (or .p for line)
  netSize: number;              // signed, as of t
  avgEntry: number;
  realized: number;
  unrealized: number;           // (mark - avgEntry) * netSize   [sign-aware]
  fees: number;
  funding: number;
  totalPnl: number;             // realized + unrealized - fees + funding
  holdingValue: number;         // |netSize| * mark
  bought: number; sold: number;
  newFills: Fill[];             // fills landing inside this bar -> pop markers
  isFinal: boolean;
}
```

Precompute the whole `Frame[]` array up front. **Do not compute PnL inside the render loop** — the export path must be able to jump to an arbitrary frame index deterministically.

### 6.3 Playback controller

- `play() / pause() / seek(i) / setSpeed(0.5|1|2|4)`
- Fixed timestep: advance `framesPerSecond = 24 * speed` decoupled from rAF, using an accumulator. Same clock math is reused by the exporter, just driven by a counter instead of wall time.
- Optional easing: slow down to 0.3x for the last ~10% of frames (the "climax") — a small touch that makes exports much more watchable. Toggleable.

---

## 7. Renderer (`packages/renderer`)

**This is the architectural keystone. Read this before writing any chart code.**

```ts
export function renderFrame(
  ctx: CanvasRenderingContext2D,   // works for browser Canvas AND @napi-rs/canvas
  frame: Frame,
  episode: PositionEpisode,
  series: PriceSeries,
  scale: ScaleState,               // mutable, eased — see below
  theme: Theme,
  layout: { width: number; height: number; dpr: number }
): void
```

Constraints:
- **No DOM APIs.** No `document`, no `window`, no CSS. Fonts are registered by the host (browser: `document.fonts.load`; node: `GlobalFonts.registerFromPath`).
- **No async.** Everything needed is in the args.
- Pure w.r.t. output: same args → same pixels. `ScaleState` is the one mutable thing, passed in and stepped explicitly.

### 7.1 Layers (draw in this order)

1. `background` — flat dark fill
2. `grid` — horizontal price gridlines + right-side axis labels, x-axis date ticks
3. `entryLine` — dashed horizontal at `avgEntry`, with a pill label on the right edge showing the price. Redraws position as avg entry moves on scale-in.
4. `series` — candles (`kind:'ohlcv'`) or a filled area line (`kind:'line'`), clipped to `visibleUpTo`
5. `markers` — a dot + label per fill (`OPEN LONG $13.9M 5x`). Fade-in over ~8 frames when new. Collision-avoid labels vertically.
6. `hud` — top-left: instrument, address (truncated), direction + size. Top-right: **total PnL, huge, green/red.** Bottom bar: BOUGHT / SOLD / FEES / REALIZED / UNREALIZED / HOLDING.
7. `watermark` — small centered domain string at the top of the chart area

### 7.2 Scaling (this is what makes it feel good)

Naive re-fit every frame = jittery garbage. Instead:

```ts
// target from visible data + entry line, with 8% padding
const target = computeBounds(series, 0, visibleUpTo, avgEntry);
// exponential smoothing toward the target
scale.min += (target.min - scale.min) * 0.12;
scale.max += (target.max - scale.max) * 0.12;
```

Same idea for the x-axis: as bars accumulate, bar width shrinks. Either
(a) fixed full-episode x-domain from frame 0 (bars appear left→right into empty space), or
(b) growing domain (bars compress as they accumulate).
**Ship (b) as default, (a) as an option** — (b) is what the reference screenshots do.

### 7.3 Visual identity

Monospace throughout (JetBrains Mono / IBM Plex Mono — bundle the woff2/ttf, needed by both browser and node). Near-black background, teal/red candles, no gradients, no rounded corners, no shadows. It should look like a terminal, not a dashboard. Theme lives in one `theme.ts` object so a light theme is a config swap.

---

## 8. Web app

Routes:
- `/` — input: wallet address, venue toggle (auto-detect from address format is nice-to-have), or CSV drop zone
- `/a/[venue]/[address]` — **episode list**: table of reconstructed episodes, sortable by PnL / duration / size / date. Sparkline per row. Clicking one opens the player.
- `/r/[replayId]` — **player**: canvas + transport controls (play/pause, scrubber, speed, interval override), export panel, share button
- `/api/*` — route handlers proxying each adapter (keeps rate-limiting and caching server-side, avoids CORS surprises)

Next.js must be built with `output: 'standalone'` for Railway.

Player UX details that matter:
- Scrubber shows fill markers as ticks along the track
- Hovering the canvas pauses and seeks to that x position
- Keyboard: space = play/pause, ←/→ = ±1 frame, shift+←/→ = ±10
- Deep link encodes `{venue, address, instrument, openedAt}` → resolves to the same episode later. Do **not** use array indices in URLs.

---

## 9. Export

### Phase 1 — client only (do this first)
```
canvas.captureStream(60) -> MediaRecorder(mimeType:'video/webm;codecs=vp9') -> Blob -> download
```
Run the replay at a fixed timestep driven by rAF while recording. Also offer GIF via `gif.js` (worker-based, downsample to 15fps / 640px wide or the file is unusable).

Caveat to surface in the UI: WebM is not ideal for X. Offer "Download MP4" which routes to Phase 2 when available.

### Phase 2 — server render worker
```
POST /render { replaySpec } -> jobId
worker: for i in 0..frames.length:
          renderFrame(nodeCanvasCtx, frames[i], ...)
          write frame-%05d.png
        ffmpeg -r 30 -i frame-%05d.png -c:v libx264 -pix_fmt yuv420p -crf 18 out.mp4
-> presigned URL
```
Because `renderFrame` is shared, **server output is pixel-identical to the browser preview.** That's the whole payoff of §7.

Add: 1080x1080 (square, best for X timeline) and 1920x1080 presets. Layout must be resolution-independent — no hardcoded pixel positions, derive from `layout.width/height`.

---

## 10. Caching & limits

- `candles(venue, instrument, interval, bucketStart)` → immutable once the bar closes. Cache forever. Only the most recent (still-open) bar is volatile.
- `fills(venue, address)` → cache with a `lastSyncedTs`; on refetch only request `startTime = lastSyncedTs`.
- Per-venue token-bucket limiter, shared across requests in-process.
- Every adapter call goes through a `withRetry` helper: exponential backoff on 429/5xx, respect `Retry-After`, max 4 attempts.

---

## 11. Known edge cases — write a test for each

1. Position never closes (still open) → replay runs to now, `unrealized` label instead of final
2. Flip in a single fill (`Long > Short`) → two episodes, same timestamp
3. Scale-in *after* a partial close
4. Two episodes on the same instrument within the same candle → interval must step down or they'll merge visually
5. Position open for months → 1m candles impossible, must fall back to 4h/1d
6. Position open for 90 seconds → on HL, sub-minute resolution is unavailable; warn and use 1m. On Perps, switch to `mark-history` at `1s` and forward-fill the sparse buckets.
7. Perps position closes between two polls in mode (C) → cycle is gone from the API; we must have already persisted it, or the episode is lost. Test the poller's gap behaviour explicitly.
8. Fills exist but `candleSnapshot` returns nothing for that range (delisted/HIP-3 market) → clear error, not a blank canvas
9. HL fill history truncated at the 10k limit → explicit UI warning, don't render a wrong "avg entry"
10. Address with zero fills / invalid address / ENS that doesn't resolve
12. Username resolves to multiple profiles → disambiguation UI, never auto-pick
13. Username resolves to an address the Perps API doesn't recognise → say "no Perps account found for this name", not "no positions"
11. Fee token is not USDC (HL `feeToken`) → either convert or exclude from the PnL sum and label it

---

## 12. Build order

Each milestone must be independently runnable and demoable. Don't skip ahead.

**M1 — core, headless (no UI at all)**
`packages/core` + `adapters/hyperliquid`. A CLI script: `pnpm episodes 0x082e...` prints a table of reconstructed episodes with PnL. Tests green, including the `dir`-field cross-check and the fuzz test.
*Done when:* the numbers match what Hyperliquid's own UI shows for that wallet.

**M2 — static render**
`packages/renderer` + a Node script that renders **one** frame (the final frame of a chosen episode) to `out.png`. No animation, no browser.
*Done when:* `out.png` looks like the reference screenshot.

**M3 — interactive player**
Next.js page, canvas, rAF loop over `Frame[]`, transport controls, eased scaling.
*Done when:* you can play/pause/scrub a Hyperliquid episode end-to-end and it feels smooth.

**M4 — episode browser**
`/a/[venue]/[address]` list view, caching layer, SQLite.

**M5 — client-side export**
MediaRecorder WebM + GIF.

**M6 — Polymarket Perps adapter**
Open-positions-only mode (option A in §4.4.1). Instrument id map, klines + mark-history
series, `previous_size`/`previous_entry_price` assertions wired into the §5 tests,
liquidation/ADL markers. **Decide A/B/C explicitly before starting.**

**M7 — CSV adapter**
Column mapping UI + Binance klines.

**M8 — server MP4 render worker**
Only after M1–M7 are stable.

---

## 13. Explicitly out of scope (v1)

- Placing trades / any write operation. **Read-only, forever. Never ask for a private key.**
- Real-time / live-updating replays
- Portfolio-level (multi-position) replays
- User accounts, auth, payments
- Mobile-optimized player (desktop-first; make it not-broken on mobile, that's all)

---

## 14. Notes for the implementer

- Every external response goes through a Zod schema. Venue APIs change without warning and a silent `undefined` in the PnL fold produces a plausible-looking wrong number, which is worse than a crash.
- When our computed PnL disagrees with the venue's reported `closedPnl`, **trust the venue and log the delta.** Do not silently pick one.
- Perps `totalFunding` is an estimate derived from public funding *rates*, not the account's actual charges. Anywhere an estimated number reaches the HUD or an exported image, mark it. An export is a screenshot someone posts as fact.
- Resist adding indicators, drawing tools, or a second chart type. The product is one thing: the replay.

---

## 15. Deployment (Railway)

One Railway project, services below. Nothing here needs Vercel, Fly, Turso, or
Upstash — that was the earlier Vercel-shaped plan and it no longer applies.

### Services

| Service | What it is | Notes |
|---|---|---|
| `web` | Next.js, `output: 'standalone'` | Public. Serves the app and `/api/*` adapter proxies. |
| `worker` | Long-running Node process | ffmpeg render jobs (M8) and, if Perps option C is chosen, the fill poller. **Not** publicly exposed. |
| `postgres` | Railway Postgres | Only if/when you outgrow SQLite. Skip at first. |

### Storage

SQLite lives on a **Railway persistent volume** mounted at e.g. `/data`, with
`DATABASE_URL=file:/data/cache.db`. Both services need the same data, so either
mount the volume on `web` and have `worker` talk to it over an internal HTTP
endpoint, **or** put the DB in Postgres from the start. Do not mount one volume
into two services and hope — SQLite over a shared mount across processes is a
corruption story.

**Hard constraint: `web` runs at replica count 1 while SQLite is the store.**
Two replicas means two independent database files diverging silently, and the
symptom is "the cache sometimes misses", which is nearly impossible to debug.
If horizontal scale is ever needed, migrate to Postgres *first*. This is why
§10 goes through Drizzle rather than raw SQL.

### Rate limiting

With a single `web` replica, the in-process token bucket in §10 is correct as
written. **If replica count ever goes above 1, that limiter silently becomes
N× more permissive** and Hyperliquid/Polymarket will start returning 429s that
look like their problem and are ours. Move the bucket to Redis at the same time
you move to Postgres — treat them as one migration, not two.

### ffmpeg

Install in the `worker` image (`apt-get install -y ffmpeg`, or a base image that
ships it). `@napi-rs/canvas` ships prebuilt binaries and needs no system deps.
Verify both exist at container start and fail loudly if not — a render worker
that silently can't render is worse than one that won't boot.

### Render jobs

Railway has no managed queue. For expected volume, a SQLite/Postgres-backed job
table polled by `worker` every few seconds is sufficient and far simpler than
adding a broker. Keep jobs idempotent and store output to object storage (or a
volume) rather than streaming from memory.

### Perps poller (only if §4.4.1 option C)

Runs in `worker` on an interval, not on cron: an open position closed between
polls is gone permanently, so the interval is a data-loss window, not a
freshness setting. Size it deliberately and record the poll interval alongside
the data so gaps are explainable later.

### Environment

`web` and `worker` share adapter config. Use Railway shared variables so they
cannot drift. No API keys are required for any read path in this spec — if a
key or private key ever appears in the environment, something has gone wrong
(see CLAUDE.md, read-only rule).

### 15.1 Setup checklist — do these in order

**1. Create an empty project**
Railway → New Project → Empty Project. Do not use a template; the monorepo
layout in §3 doesn't match any of them.

**2. Add the `web` service**
Deploy from the GitHub repo. Then in Settings:

| Setting | Value |
|---|---|
| Root Directory | `/` (the monorepo root — the build needs the workspace) |
| Build Command | `pnpm install --frozen-lockfile && pnpm turbo build --filter=web` |
| Start Command | `node apps/web/.next/standalone/apps/web/server.js` |
| Watch Paths | `apps/web/**`, `packages/**` |
| Healthcheck Path | `/api/health` (add a route that returns 200 + a DB ping) |
| Replicas | **1** — see the SQLite constraint above |
| App Sleeping | off |

`next.config.js` must set `output: 'standalone'` or the start command won't
exist.

**3. Add the `worker` service**
Same repo, separate service. Settings:

| Setting | Value |
|---|---|
| Build Command | `pnpm install --frozen-lockfile && pnpm turbo build --filter=worker` |
| Start Command | `node apps/worker/dist/index.js` |
| Watch Paths | `apps/worker/**`, `packages/**` |
| Public Networking | **disabled** — nothing outside should reach it |
| App Sleeping | off (a sleeping poller loses data; see §15) |
| Restart Policy | On Failure, ~10 retries |

**4. Get ffmpeg into the `worker` image**
Nixpacks won't install it. Either add `apps/worker/nixpacks.toml`:

```toml
[phases.setup]
aptPkgs = ["ffmpeg"]
```

or give `worker` its own Dockerfile. Verify at boot:

```ts
// apps/worker/src/preflight.ts — run before accepting any job
execSync('ffmpeg -version');           // throws if missing
require('@napi-rs/canvas');            // prebuilt, no system deps
```

Fail the process if either is missing. A render worker that boots and then
silently cannot render is much worse than one that refuses to start.

**5. Add the volume (only if staying on SQLite)**
Attach a volume to **`web` only**, mount path `/data`. Volumes cannot be shared
between services on Railway, and sharing SQLite across processes over a mount
corrupts it — this is the constraint that forces the "worker asks web over HTTP"
shape in §15, or Postgres.

Start at 1 GB. Candle data is small; it is text and it compresses.

**6. Variables**
Set these as **project-level shared variables** so `web` and `worker` cannot
drift apart:

```
NODE_ENV=production
DATABASE_URL=file:/data/cache.db
LOG_LEVEL=info
HL_API_BASE=https://api.hyperliquid.xyz
PM_PERPS_API_BASE=https://api.perpetuals.polymarket.com
PM_GAMMA_API_BASE=https://gamma-api.polymarket.com
REPLAY_TARGET_FRAMES=200
```

Railway injects `PORT` — **read it, never hardcode a port.** If you later add
Postgres, reference it rather than copying the string:
`DATABASE_URL=${{Postgres.DATABASE_URL}}`.

No secrets belong here. Every read path in this spec is unauthenticated. If a
private key or API secret ever shows up in this list, something has gone wrong
(CLAUDE.md, read-only rule) — the one legitimate exception is Perps option B,
which is server-side only and must never reach the browser.

**7. Service-to-service calls**
Use `http://web.railway.internal:${PORT}` from `worker`. Two things bite here:

- Private networking is **IPv6-only**. The listener must bind `::`, not
  `127.0.0.1` and not `0.0.0.0` alone, or the connection is refused with no
  useful error.
- Private DNS takes a moment to come up at boot. Retry the first call rather
  than crashing on it.

Internal traffic doesn't leave Railway and isn't billed as egress.

**8. Domain**
Generate a Railway domain on `web` to test, then attach a custom one. Leave
`worker` with no domain at all.

**9. Deploy order**
Deploy `web` first and confirm the healthcheck goes green. `worker` without a
reachable `web` will retry-loop, and it will look like a worker bug when it is
just ordering.

### 15.2 Railway gotchas, ranked by how long they'll cost you

1. **Not binding to `process.env.PORT` on `0.0.0.0`/`::`.** The single most
   common Railway deploy failure. Healthcheck times out, logs look fine.
2. **Replicas > 1 with SQLite.** Silent divergence, not an error. Covered above,
   repeated because the setting is one click away.
3. **Missing watch paths.** Every push rebuilds every service. Wastes build
   minutes and makes the deploy history useless for bisecting.
4. **App Sleeping on `worker`.** In Perps option C, a sleeping poller is not
   slow — it is permanent data loss, because closed position cycles are
   unrecoverable (§4.4.1).
5. **ffmpeg assumed present.** Nixpacks gives you Node, not media tooling.
6. **Committing `.env`.** Use Railway variables. Add `.env*` to `.gitignore`
   before the first push, not after.

### 15.3 When to move to Postgres

Move when any of these become true — and move *before* they become urgent:

- You need more than one `web` replica
- The volume is filling up (heavy trader backfills, many cached instruments)
- You want `worker` to read the cache directly instead of via `web`
- Multiple people need to query the data

The migration is a Drizzle dialect swap plus regenerated migrations, provided
nothing has reached past Drizzle into raw SQLite SQL. Keep it that way.
