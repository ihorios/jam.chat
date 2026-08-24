/**
 * Who is connected right now. Mounted at /api.
 *
 * A connection is a WebSocket, not a person: one user with three tabs open is
 * three connections and one entry under `users`. Anonymous connections are
 * counted but not named — there is nothing to name them with, which is rather
 * the point of reporting them separately.
 *
 * Gated on the unscoped users:read, the same permission that lets somebody see
 * the user list at all; who is online is the same class of information.
 */
export default async function presenceRoutes(fastify) {
  fastify.get(
    '/presence',
    { preHandler: fastify.requirePermission('users:read') },
    async () => {
      const connections = await fastify.realtime.connections();

      const byUser = new Map();
      for (const connection of connections) {
        if (connection.userId === null) continue;
        const entry = byUser.get(connection.userId) || { connections: 0, since: connection.since };
        entry.connections += 1;
        // The oldest of their sockets: how long they have been here, not how
        // long this particular tab has.
        if (connection.since < entry.since) entry.since = connection.since;
        byUser.set(connection.userId, entry);
      }

      const users = await fastify.models.users.findByIds([...byUser.keys()]);
      const authenticated = connections.filter((c) => c.userId !== null).length;

      return {
        ok: true,
        total: connections.length,
        authenticated,
        anonymous: connections.length - authenticated,
        // Distinct people, the same figure the socket's presence frame carries.
        people: byUser.size,
        // One row per signed-in person, not per socket.
        users: users.map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          connections: byUser.get(user.id).connections,
          since: byUser.get(user.id).since,
        })),
      };
    }
  );
}
