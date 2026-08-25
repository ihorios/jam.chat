import { config } from './config/env.js';
import { buildApp, BOOT_BANNER } from './app.js';

/*
 * Building the app is meant to be unfailable: every plugin that talks to
 * something outside the process reports its own failure and carries on (see
 * server/subsystems.js). This catch is for the case that is left — a
 * programming error in a plugin, a bad configuration value — where there is no
 * server to serve an explanation from, and the only useful thing to do is put
 * the reason somewhere a person will find it and stop.
 */
let app;
try {
  app = await buildApp();
} catch (err) {
  console.error('❌ The server could not be built, so it will not start:', err);
  process.exit(1);
}

// Most orchestrators send SIGTERM before replacing an instance;
// close lets in-flight requests finish and releases the Postgres pool. How long
// it may take before the process stops waiting is config.shutdownTimeoutMs.

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    app.log.info(`Received ${signal}, shutting down.`);

    // Never hold the port hostage. If close() stalls — a wedged query, a
    // socket that will not die — give up and let the next start have it.
    // unref() so this timer alone cannot keep the process alive.
    const giveUp = setTimeout(() => {
      app.log.error(
        `Shutdown did not finish in ${config.shutdownTimeoutMs}ms; exiting anyway.`
      );
      process.exit(1);
    }, config.shutdownTimeoutMs);
    giveUp.unref();

    try {
      await app.close();
    } catch (err) {
      app.log.error(err);
    }
    clearTimeout(giveUp);
    process.exit(0);
  });
}

try {
  // The banner is printed by Fastify's own per-address announcement, in our
  // words — one line for each address it bound, rather than one line here plus
  // Fastify's for every address. See BOOT_BANNER.
  await app.listen({
    port: config.port,
    host: config.host,
    listenTextResolver: (address) => `${BOOT_BANNER} ${address}`,
  });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
