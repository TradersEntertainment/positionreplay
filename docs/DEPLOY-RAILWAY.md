# Deploying to Railway

Follows SPEC §15 and §15.1. Read §15's constraints before changing anything here —
several of these settings are not preferences, they are the difference between a cache
that works and one that silently corrupts.

## The shape

Two services, one volume, no database service.

| Service | Root | Public | Volume |
|---|---|---|---|
| `@trade-replay/web` | repo root | **yes** | **yes**, `/data` |
| `@trade-replay/worker` | repo root | **no** | no |

**Delete any `@trade-replay/cli` service Railway created.** `apps/cli` is a command-line
tool — `episodes`, `render:still`, `verify:m1`. It has no server, so as a service it
starts, exits, and restarts forever.

**The volume goes on `web` only.** SPEC §15.1 step 5: "Volumes cannot be shared between
services on Railway, and sharing SQLite across processes over a mount corrupts it." The
worker reaches the queue over HTTP instead — that is what `RENDER_TRANSPORT=http` is for,
and it is why `web` holds the finished MP4s rather than the worker.

---

## 1. `web`

| Setting | Value |
|---|---|
| Build Command | `pnpm install --frozen-lockfile && pnpm --filter @trade-replay/web build` |
| Start Command | `pnpm --filter @trade-replay/web start` |
| Watch Paths | `apps/web/**`, `packages/**` |
| Healthcheck Path | `/api/health` |
| Replicas | **1** |

**Replica count 1 is a hard constraint while SQLite is the store** (SPEC §15). Two
replicas means two independent database files diverging silently, and the symptom is
"the cache sometimes misses" — nearly impossible to debug. It also multiplies the
in-process rate limiter by N, which turns into 429s from Hyperliquid that look like
their problem and are ours.

`next start` is **not** the start command. `output: 'standalone'` makes it serve a stale
build; the standalone server is the real one, and `build` copies `.next/static` and
`public` into it (Next does not, because it assumes a CDN).

### Volume
Mount path `/data`, 1 GB to start. Candle data is small and it is text.

### Variables
```
DATABASE_URL=file:/data/cache.db
RENDER_OUTPUT_DIR=/data/renders
RENDER_WORKER_TOKEN=<generate one>
NODE_ENV=production
```

`RENDER_WORKER_TOKEN` gates the endpoints the worker uses to claim jobs and upload
files. `web` is public, so those endpoints are **closed entirely when it is unset** —
a deployment that forgets it gets 503s from the worker, not an open door.

---

## 2. `worker`

| Setting | Value |
|---|---|
| Build Command | `pnpm install --frozen-lockfile && pnpm --filter @trade-replay/worker build` |
| Start Command | `pnpm --filter @trade-replay/worker start` |
| Watch Paths | `apps/worker/**`, `packages/**` |
| Public Networking | **disabled** |
| App Sleeping | **off** |
| Restart Policy | On Failure, ~10 retries |

### ffmpeg
`apps/worker/nixpacks.toml` already asks for it:

```toml
[phases.setup]
aptPkgs = ["ffmpeg"]
```

If Railway ignores that file, give the service its own Dockerfile. `src/preflight.ts`
checks for ffmpeg **and libx264** at boot and refuses to start without them — SPEC §15:
"a render worker that silently can't render is worse than one that won't boot." A crash
loop with `PREFLIGHT FAILED` in the log means the image lacks ffmpeg, not that the code
is broken.

### Variables
```
RENDER_TRANSPORT=http
RENDER_WORKER_TOKEN=<the same value as web>
WEB_URL=http://<web-service>.railway.internal:8080
NODE_ENV=production
```

Use Railway **shared variables** for `RENDER_WORKER_TOKEN` so the two cannot drift
(SPEC §15). `WEB_URL` should be the private network address — the worker has no reason
to leave Railway's network, and the public URL would bill egress for every poll.

Optional, with their defaults:

```
RENDER_POLL_MS=2000        # how often it asks for work
RENDER_LEASE_MS=120000     # how long a claim survives without progress
RENDER_MAX_FRAMES=3000     # refuses a replay longer than this
```

---

## 3. Verifying it actually works

In order — each step rules out one class of failure:

```bash
# 1. web is up and its database opened
curl https://<web>/api/health
# {"status":"ok","cache":"ready","database":"/data/cache.db","renderQueue":"ready"}

# 2. the worker booted (its log, first three lines)
#    [worker] ffmpeg version ...
#    [worker] queue via http https://.../api/render/worker ...
#    [worker] output /... , web http://...

# 3. the token matches — from anywhere, unauthenticated:
curl -X POST https://<web>/api/render/worker/claim
# {"error":"Not authorised."}      <- correct, the guard works
# {"error":"The worker API is disabled: ..."}  <- RENDER_WORKER_TOKEN unset on web
```

Then open a replay and press **Download MP4**. If it sits on "Queued on the render
worker…" forever, the worker is not reaching the queue — check `WEB_URL` and that both
services carry the same token.

---

## What is NOT set up here

- **No API keys.** SPEC §15: "No API keys are required for any read path in this spec —
  if a key or private key ever appears in the environment, something has gone wrong."
  `RENDER_WORKER_TOKEN` is a service-to-service secret, not a venue credential.
- **No Postgres.** SPEC §15 says skip it at first. Move to it *before* you ever need a
  second `web` replica, and move the rate limiter to Redis in the same migration —
  they are one change, not two. §10 goes through Drizzle precisely so that stays a
  dialect swap.
- **No object storage.** MP4s live on the volume. SPEC §9 Phase 2 ends at "presigned
  URL"; `/api/render/<id>/file` is standing in for that.
- **No Perps poller.** That is §4.4.1 option C, and the adapter runs option A.

## Known first-deploy failures

| Symptom | Cause |
|---|---|
| Page renders unstyled, chunks 404 | `next start` used instead of the standalone server |
| `cache: "unavailable"` in health | `DATABASE_URL` not pointing at the mounted volume |
| MP4 stuck on "Queued" | worker cannot reach `WEB_URL`, or the tokens differ |
| Worker crash loop, `PREFLIGHT FAILED` | no ffmpeg in the image |
| Downloads 410 "gone from disk" | `RENDER_OUTPUT_DIR` not on the volume, so it vanished on redeploy |
