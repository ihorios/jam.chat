import fp from 'fastify-plugin';

import { createSubsystems } from '../subsystems.js';

/**
 * Registered before anything that can fail, so every other plugin has somewhere
 * to report itself to. Holds no resources and cannot fail on its own.
 */
async function subsystemsPlugin(fastify) {
  fastify.decorate('subsystems', createSubsystems(fastify.log));
}

export default fp(subsystemsPlugin, { name: 'subsystems' });
