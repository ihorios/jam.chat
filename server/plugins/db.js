import fp from 'fastify-plugin';

import { config } from '../config/env.js';
import { connect, close, isPostgres } from '../db/index.js';
import { syncSchema } from '../db/schema.js';
import { createRepositories } from '../db/repository.js';
import { seed } from '../db/seed.js';
import { withDeadline } from '../subsystems.js';

/**
 * Brings the data layer up and exposes one repository per registered model as
 * `fastify.models.<name>`. Routes talk to repositories only, so they are
 * unaffected by which driver is in use.
 *
 * Nothing in here is allowed to stop the server from starting. A database that
 * is unreachable, a schema statement that fails, a seed that throws — each is
 * recorded against the `database` subsystem and the boot carries on, so the
 * process is up to say so and the API answers 503 rather than the client
 * getting a closed socket. See server/subsystems.js for why that is the
 * behaviour worth having, and app.js for the guard that enforces it.
 */
async function dbPlugin(fastify) {
  let connected = false;

  try {
    // Deadlined as one unit: connecting, creating the schema and seeding are
    // all round trips to the same place, and it is the total wait that decides
    // whether this plugin returns or Fastify kills the process for taking too
    // long. Comfortably inside config.pluginTimeoutMs, so a failure here is
    // reported by this catch rather than by avvio.
    await withDeadline(config.dbBootTimeoutMs, 'Database start-up', async () => {
      connected = await connect();
      if (connected) await syncSchema(fastify.log);
    });
  } catch (err) {
    fastify.subsystems.down('database', err);
  }

  /*
   * Built regardless, so that `fastify.models.users` is an object rather than a
   * crash on every route in the application. With the database down these are
   * the in-memory driver, and the guard in app.js is what keeps anything from
   * reaching them — writing to a store that vanishes on restart is the one
   * outcome worse than refusing the request.
   */
  const repositories = createRepositories();
  fastify.decorate('models', repositories);

  if (fastify.subsystems.ok('database')) {
    try {
      await withDeadline(config.dbBootTimeoutMs, 'Seeding', () => seed(repositories, fastify.log));
      fastify.subsystems.up('database');
      console.log(
        `✅ Data layer ready (${isPostgres() ? 'postgres' : 'in-memory'}): `
          + `${Object.keys(repositories).join(', ')}.`
      );
    } catch (err) {
      // The schema is there but its default rows are not, which leaves an
      // installation with no roles to grant and possibly no way in. Down rather
      // than degraded: serving that is more confusing than refusing to.
      fastify.subsystems.down('database', err);
    }
  }

  fastify.addHook('onClose', async () => {
    await close().catch((err) => fastify.log.warn({ err }, 'Closing the database pool failed'));
  });
}

// fp() keeps the `models` decorator on the root instance so sibling route
// plugins can reach it.
export default fp(dbPlugin, { name: 'db', dependencies: ['subsystems'] });
