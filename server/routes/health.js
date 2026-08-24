/**
 * Liveness and readiness, which are different questions.
 *
 * `/liveness` and `/healthz` answer "is this process running", and answer it
 * unconditionally. render.yaml points its healthCheckPath here on purpose: a
 * probe that failed while the database was unreachable would have the platform
 * replace an instance that is up and explaining itself with one that will fail
 * in exactly the same way, on a loop.
 *
 * `/readyz` answers "can it serve the API", which is where a broken subsystem
 * shows up — 503 and the reason, so a deploy can be looked at without reading
 * the logs. It is not wired to anything that restarts on a red answer.
 */
export default async function healthRoutes(fastify) {
  const alive = async () => ({ ok: 1 });

  fastify.get('/liveness', alive);
  fastify.get('/healthz', alive);

  fastify.get('/readyz', async (_request, reply) => {
    const down = fastify.subsystems.blocking();
    const body = { ok: !down, subsystems: fastify.subsystems.report() };
    return down ? reply.status(503).send(body) : body;
  });
}
