import fp from 'fastify-plugin';

/**
 * Single place that turns a thrown error into a response, so route handlers
 * can just throw ValidationError instead of repeating try/catch.
 *
 * A 5xx does not return its message: a client error is advice, and a server
 * error is usually a stack trace with somebody's connection string in it.
 *
 * `error.expose` is the exception, and it is deliberately something an error
 * has to ask for. Some server failures *are* advice — a bucket that would not
 * delete an object, so the file was left alone and the caller should try again
 * — and "Internal server error" tells that person nothing they can act on.
 */
async function errorHandler(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;

    if (status >= 500) fastify.log.error(error);
    else fastify.log.info({ err: error.message }, 'Rejected request');

    return reply.status(status).send({
      ok: false,
      error: status < 500 || error.expose ? error.message : 'Internal server error',
    });
  });
}

export default fp(errorHandler, { name: 'error-handler' });
