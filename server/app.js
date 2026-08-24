import Fastify from 'fastify';

import { config } from './config/env.js';
import { modelList } from './db/models/index.js';
import authPlugin from './plugins/auth.js';
import dbPlugin from './plugins/db.js';
import errorHandler from './plugins/error-handler.js';
import filesPlugin from './plugins/files.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import realtimePlugin from './plugins/realtime.js';
import staticPlugin from './plugins/static.js';
import subsystemsPlugin from './plugins/subsystems.js';
import authRoutes from './routes/auth.js';
import callRoutes from './routes/calls.js';
import fileRoutes from './routes/files.js';
import healthRoutes from './routes/health.js';
import messengerRoutes from './routes/messenger.js';
import metaRoutes from './routes/meta.js';
import presenceRoutes from './routes/presence.js';
import userPictureRoutes from './routes/user-picture.js';
import { crudRoutes } from './routes/crud.js';

/**
 * The boot banner, one line per address Fastify ends up bound to.
 *
 * Fastify announces each of those itself, through the logger — which would put
 * the one thing a person watches for at startup in JSON among the plain lines
 * the rest of the boot prints. The text is ours (server/index.js hands it to
 * listen as its listenTextResolver) and the logger hook below recognises it by
 * this prefix and puts it on stdout instead.
 */
export const BOOT_BANNER = '🚀 Fastify backend service running at';

/**
 * Builds the Fastify instance without starting it, so tests can call
 * `app.inject()` against the same wiring the server uses.
 *
 * Model routes are not listed here on purpose: every model in
 * server/db/models/ gets its CRUD endpoints mounted automatically at
 * /api/<model>. Adding a model file is the whole job.
 */
export async function buildApp(opts = {}) {
  const app = Fastify({
    logger: {
      hooks: {
        logMethod(args, method) {
          if (typeof args[0] === 'string' && args[0].startsWith(BOOT_BANNER)) {
            console.log(args[0]);
            return;
          }
          method.apply(this, args);
        },
      },
    },
    // Behind Render's load balancer every request would otherwise appear to
    // come from the same address, which would put every user in one rate-limit
    // bucket. See config.trustProxy for why one hop rather than all of them.
    trustProxy: config.trustProxy,
    // Boot is network-bound rather than quick; see config.pluginTimeoutMs.
    pluginTimeout: config.pluginTimeoutMs,
    ...opts,
  });

  // First: everything below reports itself to it, including on the way down.
  await app.register(subsystemsPlugin);
  await app.register(errorHandler);
  // Before everything it guards, and before auth so a flood of bad passwords
  // is refused without the bcrypt it was trying to spend.
  await app.register(rateLimitPlugin);
  await app.register(dbPlugin);
  await app.register(authPlugin);
  // After auth: the WebSocket handshake reads the session cookie, and delivery
  // is decided by the same permissions the routes use.
  await app.register(realtimePlugin);
  await app.register(filesPlugin);
  await app.register(staticPlugin);

  // A catch-all flood guard over the API, generous enough that using the app
  // never touches it: a dashboard tab costs a handful of requests, and the
  // conversation itself runs on the socket. Anything approaching this ceiling
  // is a script. Static files and /ws are deliberately outside it.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    await app.rateLimit('api', (req) => `ip:${req.ip}`)(request, reply);
  });

  /*
   * Nothing that needs a working data layer is attempted without one.
   *
   * Every API route reads or writes a model, so the whole prefix goes at once
   * rather than each route discovering the problem for itself and failing
   * somewhere less legible. 503 and not 500: the request was fine, the server
   * is not, and Retry-After says the difference is expected to be temporary.
   *
   * Outside the prefix on purpose: the static files, the health endpoints and
   * the readiness report all still work, which is what makes a degraded
   * instance possible to look at.
   */
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;

    const down = app.subsystems.blocking();
    if (!down) return;

    reply.header('Retry-After', '30');
    return reply.status(503).send({
      ok: false,
      error: `The ${down} is unavailable, so this request cannot be served.`,
    });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(metaRoutes, { prefix: '/api' });
  await app.register(presenceRoutes, { prefix: '/api' });
  await app.register(callRoutes, { prefix: '/api' });
  await app.register(messengerRoutes, { prefix: '/api/messenger' });
  // Uploading and downloading, beside the generic CRUD the files model gets
  // below. They share the prefix and never the same route: the model declares
  // no create action, so POST /api/files is this one's alone.
  await app.register(fileRoutes, { prefix: '/api/files' });
  // Also alongside a model's CRUD routes: a picture is two writes at once — a
  // file row and the user pointed at it — so it is not one of them.
  await app.register(userPictureRoutes, { prefix: '/api/users' });

  for (const model of modelList) {
    await app.register(crudRoutes(model), { prefix: `/api/${model.name}` });
  }

  return app;
}
