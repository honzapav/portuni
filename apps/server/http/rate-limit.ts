// Sliding-window rate limiter for the hosted HTTP server.
//
// Bucketed approach: a 60-second window is divided into 6 buckets of 10s each.
// Each key maintains a ring-buffer of bucket counts. On each check, stale
// buckets are zeroed and the sum is compared to the limit. This gives O(1)
// memory per key and O(1) time per check with deterministic bucket alignment.
//
// Keys are sha256 hashes of bearer tokens (to avoid keeping plaintext tokens
// in memory) or ip:<address> / "anon" for unauthenticated requests.

import { createHash } from "node:crypto";

const WINDOW_MS = 60_000;
const BUCKET_COUNT = 6;
const BUCKET_MS = WINDOW_MS / BUCKET_COUNT; // 10_000 ms each

interface KeyState {
  // Counts per bucket index (0..BUCKET_COUNT-1)
  buckets: number[];
  // Timestamp (ms) at the start of each bucket slot
  bucketTimes: number[];
}

export interface RateLimiter {
  check(key: string): { allowed: boolean; retryAfterSeconds: number };
}

export function createRateLimiter(opts: {
  limitPerMinute: number;
  now?: () => number;
}): RateLimiter {
  const { limitPerMinute } = opts;
  const now = opts.now ?? (() => Date.now());

  if (limitPerMinute <= 0) {
    // Disabled: always allow
    return {
      check(_key: string) {
        return { allowed: true, retryAfterSeconds: 0 };
      },
    };
  }

  const state = new Map<string, KeyState>();

  // Periodically prune stale keys (ones with no requests in the last 60s).
  // We call this lazily inside check() so the limiter does not hold a timer
  // reference that would prevent the process from exiting cleanly in tests.
  let lastPruneAt = 0;
  function pruneStaleKeys(nowMs: number): void {
    // Only prune at most once per WINDOW_MS
    if (nowMs - lastPruneAt < WINDOW_MS) return;
    lastPruneAt = nowMs;
    for (const [key, ks] of state) {
      const maxBucketTime = Math.max(...ks.bucketTimes);
      if (nowMs - maxBucketTime > WINDOW_MS) {
        state.delete(key);
      }
    }
  }

  function getBucketIndex(nowMs: number): number {
    return Math.floor(nowMs / BUCKET_MS) % BUCKET_COUNT;
  }

  function getOrCreate(key: string): KeyState {
    let ks = state.get(key);
    if (!ks) {
      ks = {
        buckets: new Array<number>(BUCKET_COUNT).fill(0),
        bucketTimes: new Array<number>(BUCKET_COUNT).fill(0),
      };
      state.set(key, ks);
    }
    return ks;
  }

  return {
    check(key: string): { allowed: boolean; retryAfterSeconds: number } {
      const nowMs = now();
      pruneStaleKeys(nowMs);

      const ks = getOrCreate(key);
      const currentBucket = getBucketIndex(nowMs);

      // Expire buckets whose recorded time is outside the rolling 60s window
      for (let i = 0; i < BUCKET_COUNT; i++) {
        if (nowMs - ks.bucketTimes[i] >= WINDOW_MS) {
          ks.buckets[i] = 0;
          ks.bucketTimes[i] = 0;
        }
      }

      // Count requests in active buckets
      const total = ks.buckets.reduce((a, b) => a + b, 0);

      if (total >= limitPerMinute) {
        // Find the oldest active bucket timestamp to compute when capacity
        // will free up (i.e. the first bucket to expire).
        let oldestActive = nowMs;
        for (let i = 0; i < BUCKET_COUNT; i++) {
          if (ks.buckets[i] > 0 && ks.bucketTimes[i] < oldestActive) {
            oldestActive = ks.bucketTimes[i];
          }
        }
        const retryAfterMs = oldestActive + WINDOW_MS - nowMs;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        };
      }

      // Record the request in the current bucket, stamping it with the
      // alignment time for this bucket slot so expiry is deterministic.
      const bucketAlignedTime = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;
      if (ks.bucketTimes[currentBucket] !== bucketAlignedTime) {
        // Bucket rolled over: reset count
        ks.buckets[currentBucket] = 0;
        ks.bucketTimes[currentBucket] = bucketAlignedTime;
      }
      ks.buckets[currentBucket]++;

      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

// Test seam: allows tests to reset the cached limiter so they can vary
// PORTUNI_RATE_LIMIT_PER_MIN at server boot time without being foiled by
// module-level caching. Production code never calls this.
let cachedLimiter: RateLimiter | null = null;

export function resetRateLimiterForTesting(): void {
  cachedLimiter = null;
}

export function getOrCreateLimiter(): RateLimiter {
  if (!cachedLimiter) {
    const limit = Number(process.env.PORTUNI_RATE_LIMIT_PER_MIN ?? 0);
    cachedLimiter = createRateLimiter({ limitPerMinute: limit });
  }
  return cachedLimiter;
}

// Derive a rate-limit key from the request context.
// Bearer tokens are hashed (sha256 hex) to avoid plaintext token storage.
// Falls back to ip:<remoteAddress>, then "anon".
export function rateLimitKey(
  authorizationHeader: string | undefined,
  remoteAddress: string | undefined,
): string {
  if (authorizationHeader?.startsWith("Bearer ")) {
    const token = authorizationHeader.slice("Bearer ".length).trim();
    if (token.length > 0) {
      const hash = createHash("sha256").update(token).digest("hex");
      return `bearer:${hash}`;
    }
  }
  if (remoteAddress) {
    return `ip:${remoteAddress}`;
  }
  return "anon";
}
