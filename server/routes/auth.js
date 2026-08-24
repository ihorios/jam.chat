import { defaultRoleIds, googleAccount } from '../auth/accounts.js';
import { createGoogleVerifier, identityFromClaims } from '../auth/google.js';
import { config } from '../config/env.js';
import { normaliseLanguage } from '../db/models/users.js';

/** Session lifecycle. Mounted at /api/auth. */
export default async function authRoutes(fastify) {
  /**
   * Counted per address, because there is no session to count instead — and
   * tightly, because every attempt spends a bcrypt comparison whether or not
   * the email exists. That deliberate cost is what makes guessing slow; it is
   * also what makes an unlimited login endpoint somebody else's CPU budget.
   */
  fastify.post('/login', { preHandler: fastify.rateLimit('login') }, async (request, reply) => {
    const { email, password } = request.body || {};

    const user = await fastify.verifyCredentials(email, password);
    // One message for both unknown email and wrong password: distinguishing
    // them tells an attacker which addresses are registered.
    if (!user) return reply.status(401).send({ ok: false, error: 'Invalid email or password' });
    if (!user.is_active) {
      return reply.status(403).send({ ok: false, error: 'This account is disabled' });
    }

    // Signing in successfully clears the count: somebody who mistyped their
    // password twice and then got it right is not who this is aimed at.
    await fastify.forgetRateLimit('login', request);

    fastify.startSession(reply, user);
    return { ok: true, user };
  });

  /**
   * Public self-registration. Deliberately not POST /api/users, which requires
   * the users:create permission — this is the one write an anonymous caller
   * may perform, so it is kept narrow.
   */
  fastify.post('/register', { preHandler: fastify.rateLimit('register') }, async (request, reply) => {
    const { email, first_name, last_name, password, language } = request.body || {};

    const user = await fastify.models.users.create({
      email,
      first_name,
      last_name,
      password,
      // The language the sign-up page was being read in. Normalised rather
      // than trusted: it arrives from a browser like any other field.
      language: normaliseLanguage(language),
      // Destructuring above is the whitelist: `roles`, `is_active` and
      // `email_confirmed` are pinned here so a crafted body cannot grant itself
      // permissions, resurrect a disabled account, or declare its own address
      // proven.
      is_active: true,
      // Nobody has proven this address yet — it was typed into a form. An
      // administrator may set it, and a Google sign-in on the same address will.
      email_confirmed: false,
      // The ordinary account role, which is the messenger and their own
      // profile. Being able to sign in and see nothing at all is not what
      // somebody who just registered is meant to find.
      roles: await defaultRoleIds(fastify.models, request.log),
    });

    fastify.startSession(reply, user);
    return reply.status(201).send({ ok: true, user });
  });

  /**
   * Sign in with Google.
   *
   * The browser signs in with Google directly and arrives here with the ID
   * token that came out of it. All this endpoint decides is who the caller is;
   * what they may do is read from their roles, exactly as for a password
   * sign-in — a first-time address gets an account on the same footing
   * self-registration leaves somebody on, and no more. Proving an identity to
   * Google is not a way to be granted anything here.
   *
   * What the identity does settle is the address itself: Google will only put a
   * verified one in a token, so such an account is email-confirmed, and its
   * account picture becomes the logo it starts with. See auth/accounts.js.
   *
   * Rate limited on the login policy. It is cheaper than bcrypt but it is
   * still an unauthenticated endpoint that will create a row.
   *
   * Only mounted when a Google client id is configured.
   */
  if (config.googleClientId) {
    const verifyGoogleToken = createGoogleVerifier({ clientId: config.googleClientId });

    fastify.post('/google', { preHandler: fastify.rateLimit('login') }, async (request, reply) => {
      const { token, language } = request.body || {};
      if (!token) {
        return reply.status(400).send({ ok: false, error: 'A sign-in token is required' });
      }

      let claims;
      try {
        claims = await verifyGoogleToken(String(token));
      } catch (err) {
        // Logged rather than returned: which of signature, issuer, audience,
        // algorithm or expiry failed is useful here and of interest to nobody
        // else.
        request.log.warn(`Rejected a Google ID token: ${err.message}`);
        return reply.status(401).send({ ok: false, error: 'Invalid or expired sign-in' });
      }

      const identity = identityFromClaims(claims);
      if (!identity) {
        return reply
          .status(403)
          .send({ ok: false, error: 'That account has no verified email address' });
      }

      const { user, created } = await googleAccount(fastify.models, identity, {
        language,
        log: request.log,
      });
      if (created) request.log.info(`Created ${identity.email} from a Google sign-in.`);

      if (!user.is_active) {
        return reply.status(403).send({ ok: false, error: 'This account is disabled' });
      }

      await fastify.forgetRateLimit('login', request);
      fastify.startSession(reply, user);
      return { ok: true, user };
    });
  }

  fastify.post('/logout', async (request, reply) => {
    fastify.endSession(reply);
    return { ok: true };
  });

  fastify.get('/me', { preHandler: fastify.authenticate }, async (request) => ({
    ok: true,
    user: request.user,
  }));
}
