import fp from 'fastify-plugin';

/**
 * Single place that turns a thrown error into a response, so route handlers
 * can just throw ValidationError instead of repeating try/catch.
 */
async function errorHandler(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;

    if (status >= 500) fastify.log.error(error);
    else fastify.log.info({ err: error.message }, 'Rejected request');

    return reply.status(status).send({
      ok: false,
      error: status >= 500 ? 'Internal server error' : error.message,
    });
  });
}

export default fp(errorHandler, { name: 'error-handler' });
