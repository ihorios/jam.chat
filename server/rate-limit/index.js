/**
 * Flood control: how often one caller may do one thing.
 *
 * A fixed window counter, which is the shape a key-value server gives you for
 * free — `INCR` a key, `EXPIRE` it on first touch, refuse when it goes past the
 * limit. The in-memory implementation below is deliberately written as that
 * same operation so swapping in Redis is this file and nothing else, exactly as
 * with the realtime store next door.
 *
 * A fixed window is not the most precise algorithm: a caller who spends their
 * whole allowance at the end of one window and again at the start of the next
 * gets twice the limit across that boundary. For flood control — stopping
 * somebody hammering login or flooding a peer with candidates — that is fine,
 * and it is worth far more than the sliding-window bookkeeping it would take to
 * close a gap nobody is exploiting.
 *
 * Nothing here decides policy. Callers name a policy and a key; what those mean
 * lives in config/env.js, so limits are tuned without touching code.
 */

/** How often expired buckets are swept out of memory. */
const PRUNE_INTERVAL_MS = 60 * 1000;

export function createMemoryRateLimiter() {
  /** key -> { count, resetAt } */
  const buckets = new Map();

  // Without this the map grows one entry per distinct key forever, which turns
  // the thing meant to absorb a flood into a way of causing one.
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, PRUNE_INTERVAL_MS);
  prune.unref?.();

  return {
    kind: 'memory',

    /**
     * Counts one attempt against `key` and says whether it may proceed.
     *
     * Returns `{ allowed, remaining, retryAfter }` — `retryAfter` in whole
     * seconds, ready for the header of the same name.
     */
    async hit(key, { limit, windowSeconds }) {
      const now = Date.now();
      const existing = buckets.get(key);

      // A window that has run out is a window that never happened.
      const bucket = existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + windowSeconds * 1000 };

      bucket.count += 1;
      buckets.set(key, bucket);

      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

      return {
        allowed: bucket.count <= limit,
        remaining: Math.max(0, limit - bucket.count),
        retryAfter,
        resetAt: bucket.resetAt,
      };
    },

    /** Forgets a key — a successful login need not count against the next one. */
    async reset(key) {
      buckets.delete(key);
    },

    /** For tests and for shutdown; the interval must not outlive the app. */
    close() {
      clearInterval(prune);
      buckets.clear();
    },
  };
}

/**
 * The limiter this process uses. One implementation today; the argument for a
 * factory is that the choice belongs here rather than in the plugin, so a
 * `REDIS_URL` branch is a change to this function alone — and, unlike the
 * in-memory version, a shared one would count a flood spread across several
 * instances as the single flood it is.
 */
export function createRateLimiter() {
  return createMemoryRateLimiter();
}
