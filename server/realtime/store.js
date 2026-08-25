/**
 * Who is connected, and how events reach them.
 *
 * Both halves are deliberately shaped like a key-value server rather than like
 * JavaScript: every method is async, connections are addressed by an opaque
 * string id, and nothing hands out a live object that a caller could mutate.
 * The in-memory implementation below is the whole of it today, and it only
 * works for one process — two instances would each know their own sockets.
 *
 * Swapping in Redis (or any KV with pub/sub) means implementing this same
 * interface and nothing else:
 *
 *   connect            HSET  presence:<connectionId>  ... + SADD presence:ids
 *   disconnect         DEL   presence:<connectionId>  + SREM presence:ids
 *   connections        SMEMBERS + HGETALL, or a SCAN over the keyset
 *   publish/subscribe  PUBLISH / SUBSCRIBE on one channel
 *
 * With that, presence covers every instance and a message published on one is
 * delivered to sockets held by another. Callers already await everything, so
 * none of them change.
 */

export function createMemoryRealtimeStore() {
  /** connectionId -> { userId, since, address } */
  const connections = new Map();
  const subscribers = new Set();

  return {
    /** What this implementation is, for the startup log. */
    kind: 'memory',

    /**
     * Records a socket that has just opened. Always somebody's: the handshake
     * refuses a connection with no session (plugins/realtime.js), so there is
     * no anonymous case and no `identify` to promote one — a socket opened
     * before signing in is closed rather than adopted.
     */
    async connect(connectionId, { userId = null, address = null } = {}) {
      connections.set(connectionId, {
        userId: userId === null ? null : Number(userId),
        since: new Date().toISOString(),
        address,
      });
    },

    async disconnect(connectionId) {
      connections.delete(connectionId);
    },

    /** Every live connection, as plain records. */
    async connections() {
      return [...connections.entries()].map(([connectionId, record]) => ({
        connectionId,
        ...record,
      }));
    },

    /**
     * Hands an event to every subscriber. Local only: with a KV backend this
     * becomes a PUBLISH and the subscription below a SUBSCRIBE, which is what
     * makes more than one instance possible.
     */
    async publish(event) {
      for (const handler of subscribers) {
        // One bad subscriber must not stop the others, and a publisher is
        // never made to wait on delivery.
        Promise.resolve()
          .then(() => handler(event))
          .catch(() => {});
      }
    },

    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
  };
}

/**
 * The store the server runs on. One implementation today; the argument for a
 * factory is that the choice belongs here rather than in the plugin, so a
 * `REALTIME_URL` branch is a change to this function alone.
 */
export function createRealtimeStore() {
  return createMemoryRealtimeStore();
}
