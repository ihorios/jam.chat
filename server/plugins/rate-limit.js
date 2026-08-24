import fp from 'fastify-plugin';

import { config } from '../config/env.js';
import { createRateLimiter } from '../rate-limit/index.js';

/**
 * Flood control, wired to routes.
 *
 * Two things are decorated. `fastify.limiter` is the counter itself, for the
 * places that are not HTTP requests — a WebSocket frame is not a route, and a
 * peer flooding another with candidates never touches a preHandler.
 * `fastify.rateLimit(policy)` is the preHandler factory routes use.
 *
 * Who a caller *is* is deliberately not always their address: an address is
 * shared by everyone behind one office router, so anything already behind a
 * session counts per session instead. Login and registration have no session
 * yet, which is exactly why they are the ones counted per address.
 */
async function rateLimitPlugin(fastify) {
  const limiter = createRateLimiter();
  fastify.decorate('limiter', limiter);

  /** The caller, for counting: their session if they have one, else their address. */
  const callerOf = (request) => (request.user ? `user:${request.user.id}` : `ip:${request.ip}`);

  /**
   * A preHandler that refuses once `policy`'s allowance is spent.
   *
   * `keyOf` names the bucket; the default is the caller alone, which is what
   * "per person, per policy" means.
   */
  fastify.decorate('rateLimit', (policyName, keyOf = callerOf) => {
    const policy = config.rateLimits[policyName];
    if (!policy) throw new Error(`Unknown rate limit policy "${policyName}".`);

    return async (request, reply) => {
      if (!config.rateLimitEnabled) return;

      const { allowed, retryAfter } = await limiter.hit(
        `${policyName}:${keyOf(request)}`,
        policy
      );
      if (allowed) return;

      request.log.warn(
        { policy: policyName, ip: request.ip, user: request.user?.id },
        'Rate limit exceeded'
      );

      // Retry-After is the part a well-behaved client acts on; the message is
      // for the person reading it. Neither says what the limit is — that only
      // helps somebody working out how to stay just under it.
      reply.header('Retry-After', String(retryAfter));

      const error = new Error(`Too many requests. Try again in ${retryAfter} seconds.`);
      error.statusCode = 429;
      throw error;
    };
  });

  /** Forgets a caller's attempts — what a successful login does to the failed ones. */
  fastify.decorate('forgetRateLimit', (policyName, request, keyOf = callerOf) =>
    limiter.reset(`${policyName}:${keyOf(request)}`));

  fastify.addHook('onClose', async () => limiter.close());

  // Startup state, in the same voice as the other backing services (see
  // server/db/index.js): one line on stdout, so the boot log says what is on
  // without having to read the config. Off is a warning rather than a note —
  // it only happens because somebody set RATE_LIMIT_ENABLED=false, and it
  // leaves login and registration with no flood control at all.
  if (config.rateLimitEnabled) {
    const policies = Object.entries(config.rateLimits)
      .map(([name, { limit, windowSeconds }]) => `${name} ${limit}/${windowSeconds}s`)
      .join(', ');
    console.log(`✅ Rate limiting on (${limiter.kind}): ${policies}.`);
  } else {
    console.warn('⚠️ Rate limiting is off.');
  }
}

export default fp(rateLimitPlugin, { name: 'rate-limit' });
