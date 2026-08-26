import { describe, expect, it } from 'vitest';
import { createTokenBucket } from './limiter.js';
import { HttpError, VenueUnreachableError } from './types.js';
import { withRetry } from './withRetry.js';

/** A controllable clock so limiter/backoff tests are instant and deterministic. */
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    slept,
  };
}

describe('createTokenBucket', () => {
  it('permits requests while capacity remains', async () => {
    const clock = fakeClock();
    const bucket = createTokenBucket({ capacity: 100, refillPerMinute: 100, ...clock });

    await bucket.take(40);
    await bucket.take(40);

    expect(clock.slept).toEqual([]);
  });

  it('waits when the budget is exhausted, then proceeds', async () => {
    const clock = fakeClock();
    const bucket = createTokenBucket({ capacity: 100, refillPerMinute: 60_000, ...clock });

    await bucket.take(100);
    await bucket.take(10); // needs 10 more tokens; refill is 1/ms

    expect(clock.slept.length).toBe(1);
    expect(clock.slept[0]).toBeGreaterThanOrEqual(10);
  });

  it('refills over time so a later request is free again', async () => {
    const clock = fakeClock();
    const bucket = createTokenBucket({ capacity: 100, refillPerMinute: 6_000, ...clock });

    await bucket.take(100);
    clock.advance(60_000); // a full minute of refill
    await bucket.take(50);

    expect(clock.slept).toEqual([]);
  });

  it('rejects a request larger than the bucket can ever hold', async () => {
    const clock = fakeClock();
    const bucket = createTokenBucket({ capacity: 100, refillPerMinute: 100, ...clock });

    await expect(bucket.take(101)).rejects.toThrow(/exceeds/i);
  });
});

describe('withRetry (SPEC §10)', () => {
  const opts = (clock: ReturnType<typeof fakeClock>) => ({ sleep: clock.sleep, maxAttempts: 4 });

  it('returns the first successful result without sleeping', async () => {
    const clock = fakeClock();
    const result = await withRetry(async () => 'ok', opts(clock));

    expect(result).toBe('ok');
    expect(clock.slept).toEqual([]);
  });

  it('retries on 429 and eventually succeeds', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new HttpError(429, 'u', 'slow down');
      return 'ok';
    }, opts(clock));

    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(clock.slept).toHaveLength(2);
  });

  it('honours Retry-After instead of guessing a backoff', async () => {
    const clock = fakeClock();
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls === 1) throw new HttpError(429, 'u', 'slow down', 7_000);
      return 'ok';
    }, opts(clock));

    // SPEC §4.4.4: "honor Retry-After, don't use blind exponential backoff when the
    // server told us the number."
    expect(clock.slept).toEqual([7_000]);
  });

  it('retries on 5xx', async () => {
    const clock = fakeClock();
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls === 1) throw new HttpError(503, 'u', 'transient');
      return 'ok';
    }, opts(clock));

    expect(calls).toBe(2);
  });

  it('does NOT retry a 4xx that is our fault', async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new HttpError(400, 'u', 'bad request');
      }, opts(clock)),
    ).rejects.toThrow(/400/);

    expect(calls).toBe(1);
  });

  it('does not retry an error the adapter raised deliberately', async () => {
    const clock = fakeClock();
    let calls = 0;

    // A schema mismatch, a 413, an unusable instrument: the venue has already given its
    // answer, and asking three more times only multiplies the load.
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error('venue contract mismatch');
      }, opts(clock)),
    ).rejects.toThrow(/contract mismatch/);

    expect(calls).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  it('still retries a transport failure', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw new VenueUnreachableError('https://venue.example', new Error('socket hangup'));
      return 'ok';
    }, opts(clock));

    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new HttpError(500, 'u', 'always down');
      }, opts(clock)),
    ).rejects.toThrow(/500/);

    expect(calls).toBe(4);
    expect(clock.slept).toHaveLength(3);
  });

  it('backs off exponentially when the server gives no hint', async () => {
    const clock = fakeClock();
    await expect(
      withRetry(async () => {
        throw new HttpError(500, 'u', 'down');
      }, { ...opts(clock), baseDelayMs: 100, jitter: false }),
    ).rejects.toThrow();

    expect(clock.slept).toEqual([100, 200, 400]);
  });
});
