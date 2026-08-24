import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Google's published signing keys, and the two spellings of its issuer. */
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Verifying the ID token Google hands the browser after a sign-in.
 *
 * The token proves who somebody is and nothing else. Roles and permissions
 * stay this application's business, read from its own users table on every
 * request — an identity provider able to grant permissions would be an
 * identity provider able to grant itself any of them.
 *
 * A factory rather than a module-level singleton so the tests can point one at
 * a key set of their own, and so an app with no client id configured never
 * builds one and never reaches the network.
 */
export function createGoogleVerifier({
  clientId,
  jwksUrl = GOOGLE_JWKS_URL,
  issuers = GOOGLE_ISSUERS,
}) {
  if (!clientId) throw new Error('createGoogleVerifier: `clientId` is required.');

  // Caches the keys and re-fetches when a token arrives bearing a key id it
  // has not seen, which is what makes Google's key rotation a non-event here.
  const keys = createRemoteJWKSet(new URL(jwksUrl));

  return async function verifyGoogleToken(token) {
    const { payload } = await jwtVerify(token, keys, {
      issuer: issuers,
      /*
       * The audience check is the one that matters most. Google signs ID
       * tokens for every application on the platform with the same keys, so a
       * token minted for somebody else's app carries a perfectly good
       * signature. `aud` is what says this one was minted for us.
       */
      audience: clientId,
      /*
       * Pinned deliberately. Left open, a token is verified with whichever
       * algorithm it nominates in its own header — which is the door "alg:
       * none" and HMAC-signed-with-the-public-key walk through.
       */
      algorithms: ['RS256'],
    });
    return payload;
  };
}

/**
 * The identity behind a verified token, or null when the token cannot stand in
 * for an account.
 *
 * The email address is what an account is matched on, so an unverified one is
 * refused outright: holding a Google account that merely claims somebody
 * else's address would otherwise be enough to be handed their account here.
 *
 * `picture` comes along for the ride so a first sign-in has a face to start
 * with. It is optional — the claim is absent for an account with no photo —
 * and is checked like any other URL before it is stored (users.normaliseLogo).
 */
export function identityFromClaims(claims) {
  const email = String(claims?.email || '').trim().toLowerCase();
  if (!email) return null;
  if (claims.email_verified !== true) return null;

  return {
    email,
    name: String(claims.name || '').trim(),
    picture: String(claims.picture || '').trim() || null,
  };
}
