import { config } from '../config/env.js';
import { iceServersFor } from '../realtime/ice.js';

/**
 * What a browser needs before it can place a call. Mounted at /api.
 *
 * A session and nothing more: anybody who may be in a group may call it, and
 * the frames themselves are guarded on the socket. What this must not be is
 * public — the credentials it hands out buy relay bandwidth.
 *
 * Fetched per call rather than baked into the bundle, because the credentials
 * expire. That is the entire point of them.
 */
export default async function callRoutes(fastify) {
  fastify.get(
    '/calls/ice',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      // Credentials are minted for this user and this hour: never cache them
      // in front of the server, and never in the browser past their expiry.
      reply.header('Cache-Control', 'no-store');

      return { ok: true, ...iceServersFor(config, request.user.id) };
    }
  );
}
