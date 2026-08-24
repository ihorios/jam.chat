/**
 * Which backing services are working, and why not when they are not.
 *
 * The application depends on things it does not control: a database, an object
 * store. Any of them can be unreachable at boot — a password rotated, a
 * firewall rule, a provider having a bad morning — and the question is what the
 * server should do about it.
 *
 * Not exit. A process that refuses to start says nothing to whoever is trying
 * to use it, takes the health endpoint down with it, and on most orchestrators
 * turns into a restart loop that hides the original error among a hundred
 * copies of itself. What is wanted instead is a server that starts, says
 * clearly and once what is broken, serves what it still can, and answers the
 * rest with a status code that means "not my client's fault".
 *
 * So each subsystem reports itself here, and the routes that need one are
 * refused while it is down rather than failing somewhere deeper with an error
 * about a null pool. Recovery is deliberately not automatic: the fault is
 * recorded, not retried, because a half-migrated schema retried on every
 * request is worse than one that stays down until somebody looks at it.
 */

/** A subsystem the server cannot serve its API without. */
export const REQUIRED = Object.freeze(['database']);

export function createSubsystems(log) {
  /** name -> { ok, error, at } */
  const state = new Map();

  return {
    /** Records a subsystem as working. `detail` is for the boot log only. */
    up(name, detail = null) {
      state.set(name, { ok: true, error: null, at: new Date().toISOString() });
      if (detail) log?.info({ subsystem: name }, detail);
    },

    /**
     * Records a subsystem as broken, with the reason.
     *
     * Logged at error level and exactly once, here, rather than by each caller:
     * this is the one line somebody reading the boot output has to find, and
     * repeating it per failed request would bury it.
     */
    down(name, err) {
      const message = err?.message || String(err);
      state.set(name, { ok: false, error: message, at: new Date().toISOString() });
      log?.error({ subsystem: name, err }, `Subsystem "${name}" is unavailable: ${message}`);
      console.error(`❌ ${name} is unavailable: ${message}`);
    },

    /** Is it working? Unknown counts as working — nothing has claimed it. */
    ok(name) {
      return state.get(name)?.ok !== false;
    },

    /** The first required subsystem that is down, or null. */
    blocking() {
      return REQUIRED.find((name) => !this.ok(name)) ?? null;
    },

    /** Everything known, for the readiness endpoint. */
    report() {
      return Object.fromEntries(
        [...state.entries()].map(([name, entry]) => [name, { ...entry }])
      );
    },
  };
}

/**
 * Runs `work`, giving up after `ms`.
 *
 * Bringing a subsystem up is network-bound, and the failure that matters here
 * is not an error but a wait: a database that accepts the connection and then
 * blocks on a lock will hang the boot until Fastify's own plugin timeout kills
 * the process — which is the outcome all of this exists to avoid. A deadline
 * turns that into an ordinary failure the caller can report and carry on from.
 *
 * The work is not cancelled, because it cannot be: a query already sent will
 * finish in its own time. What the deadline bounds is how long anybody waits
 * for it, so `label` is what says which one was abandoned if it later complains.
 */
export function withDeadline(ms, label, work) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not finish within ${ms}ms`)),
      ms
    );
    // Never the reason the process stays alive.
    timer.unref?.();
  });

  return Promise.race([work(), deadline]).finally(() => clearTimeout(timer));
}
