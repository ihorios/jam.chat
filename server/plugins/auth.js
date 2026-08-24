import fp from 'fastify-plugin';
import fastifyCookie from '@fastify/cookie';
import bcrypt from 'bcryptjs';

import { config } from '../config/env.js';
import { permissionKey } from '../db/models/catalog.js';

export const SESSION_COOKIE = 'session';

/**
 * The scope a set of held permissions grants over one action on one model, or
 * null for none — broadest first, so the unscoped permission wins when both
 * are held. Shared with the realtime layer, which has to make exactly the same
 * decision about a socket that a route makes about a request.
 */
export function grantedScope(model, action, permissions = []) {
  for (const scope of model.scopesFor(action)) {
    if (permissions.includes(permissionKey(model.name, action, scope))) return scope;
  }
  return null;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Session handling and authorisation.
 *
 * The session cookie carries nothing but a signed user id. Identity, roles and
 * permissions are re-read from the database on every request, so a role change
 * or a deactivated account takes effect immediately instead of lingering until
 * the cookie expires.
 */
async function authPlugin(fastify) {
  await fastify.register(fastifyCookie, { secret: config.sessionSecret });

  fastify.decorateRequest('user', null);
  // 'any' or 'own', set by authorize() — how much of a model this request may
  // see. Routes read it to decide whether to filter by owner.
  fastify.decorateRequest('scope', null);

  fastify.decorate('startSession', (reply, user) => {
    reply.setCookie(SESSION_COOKIE, String(user.id), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      secure: config.isProduction,
      maxAge: config.sessionMaxAgeSeconds,
    });
  });

  fastify.decorate('endSession', (reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  });

  /** Verifies credentials. Returns the hydrated user, or null. */
  fastify.decorate('verifyCredentials', async (email, password) => {
    const raw = await fastify.models.users.findRawBy('email', String(email || ''));

    // Compare against a dummy hash when the user is unknown, so a missing
    // account and a wrong password take the same amount of time to reject.
    const hash = raw?.password_hash || '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const matches = await bcrypt.compare(String(password || ''), hash);

    if (!raw || !matches) return null;
    return fastify.models.users.findById(raw.id);
  });

  /** preHandler: requires a valid session; populates request.user. */
  fastify.decorate('authenticate', async (request) => {
    const cookie = request.cookies[SESSION_COOKIE];
    if (!cookie) throw httpError(401, 'Authentication required');

    const unsigned = request.unsignCookie(cookie);
    if (!unsigned.valid) throw httpError(401, 'Invalid session');

    const user = await fastify.models.users.findById(unsigned.value);
    if (!user) throw httpError(401, 'Session no longer valid');
    if (!user.is_active) throw httpError(403, 'This account is disabled');

    request.user = user;
  });

  /**
   * preHandler factory: requires a session allowed to perform `action` on
   * `model`, at either scope.
   *
   * The unscoped permission wins when both are held — it is the broader of the
   * two. The scope that applied is left on request.scope, because "may I?" and
   * "to which rows?" are the same question asked twice.
   */
  fastify.decorate('authorize', (model, action) => async (request) => {
    await fastify.authenticate(request);

    const scope = grantedScope(model, action, request.user.permissions);
    if (scope) {
      request.scope = scope;
      return;
    }

    // Named without the scope: mentioning the own-scoped variant would tell
    // an unprivileged caller more about the system than the refusal needs to.
    throw httpError(403, `Missing required permission: ${permissionKey(model.name, action)}`);
  });

  /**
   * preHandler factory for the routes that are not a model's — presence, say.
   * An exact permission, with no scope to resolve.
   */
  fastify.decorate('requirePermission', (permission) => async (request) => {
    await fastify.authenticate(request);
    if (!request.user.permissions.includes(permission)) {
      throw httpError(403, `Missing required permission: ${permission}`);
    }
  });

  /**
   * The signed-in user behind a raw request, or null. Used by the WebSocket
   * handshake, which cannot throw an HTTP error at a client that is not
   * finished connecting — an anonymous socket is a legitimate thing to have.
   */
  fastify.decorate('sessionUser', async (request) => {
    const cookie = request.cookies?.[SESSION_COOKIE];
    if (!cookie) return null;

    const unsigned = request.unsignCookie(cookie);
    if (!unsigned.valid) return null;

    const user = await fastify.models.users.findById(unsigned.value);
    return user?.is_active ? user : null;
  });
}

export default fp(authPlugin, { name: 'auth' });
