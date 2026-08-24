import http from 'node:http';

import t from 'tap';
import { SignJWT, exportJWK, generateKeyPair, generateSecret } from 'jose';

import { createGoogleVerifier, identityFromClaims } from '../../server/auth/google.js';

/**
 * The ID token verifier, against a key set of this test's own rather than
 * Google's.
 *
 * These are the checks standing between a stranger and somebody else's
 * account, so they are exercised against forged tokens rather than trusted to
 * a library call that looks right.
 */

/** A throwaway JWKS endpoint, so the verifier does real key discovery. */
async function jwksServer(t, keys) {
  const body = JSON.stringify({ keys });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  return `http://127.0.0.1:${port}/certs`;
}

const CLIENT_ID = '1234.apps.googleusercontent.com';
const ISSUER = 'https://accounts.google.com';

async function fixture(t) {
  // RS256, which is what Google signs ID tokens with.
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig', kid: 'test-key' };
  const jwksUrl = await jwksServer(t, [jwk]);

  const sign = (
    claims = {},
    { key = privateKey, alg = 'RS256', issuer = ISSUER, audience = CLIENT_ID } = {}
  ) =>
    new SignJWT({ email: 'user@example.com', email_verified: true, name: 'Ada Lovelace', ...claims })
      .setProtectedHeader({ alg, kid: 'test-key' })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('google-user-1')
      .setExpirationTime('1h')
      .sign(key);

  const verify = createGoogleVerifier({ clientId: CLIENT_ID, jwksUrl });
  return { sign, verify, privateKey };
}

t.test('a token signed by the advertised key is accepted', async (t) => {
  const { sign, verify } = await fixture(t);

  const claims = await verify(await sign());
  t.equal(claims.email, 'user@example.com');
  t.equal(claims.sub, 'google-user-1');
});

t.test('the bare issuer spelling is accepted too', async (t) => {
  const { sign, verify } = await fixture(t);

  // Google uses both forms; refusing one would reject genuine tokens.
  const claims = await verify(await sign({}, { issuer: 'accounts.google.com' }));
  t.equal(claims.iss, 'accounts.google.com');
});

t.test("a token minted for another application is refused", async (t) => {
  const { sign, verify } = await fixture(t);

  // The signature is genuinely Google's — every app on the platform gets one
  // from the same keys. The audience is the only thing that says it is ours.
  await t.rejects(
    verify(await sign({}, { audience: '9999.apps.googleusercontent.com' })),
    'a real Google token for somebody else is still not a way in'
  );
});

t.test('a token signed by a different key is refused', async (t) => {
  const { sign, verify } = await fixture(t);
  const other = await generateKeyPair('RS256');

  await t.rejects(
    verify(await sign({}, { key: other.privateKey })),
    'a valid signature from the wrong key proves nothing'
  );
});

t.test('a token from another issuer is refused', async (t) => {
  const { sign, verify } = await fixture(t);

  await t.rejects(
    verify(await sign({}, { issuer: 'https://accounts.google.com.evil.test' })),
    'a lookalike issuer is not the issuer'
  );
});

t.test('an expired token is refused', async (t) => {
  const { verify, privateKey } = await fixture(t);

  const expired = await new SignJWT({ email: 'user@example.com', email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(privateKey);

  await t.rejects(verify(expired), 'expiry is enforced');
});

t.test('an HMAC-signed token is refused whatever it claims', async (t) => {
  const { verify } = await fixture(t);
  const secret = await generateSecret('HS256');

  const forged = await new SignJWT({ email: 'user@example.com', email_verified: true })
    .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);

  // The algorithm allow-list is the whole defence here: without it a verifier
  // takes the header's word for how to check the signature.
  await t.rejects(verify(forged), 'only RS256 is accepted');
});

t.test('identityFromClaims insists on a verified address', async (t) => {
  t.same(
    identityFromClaims({
      email: 'Ada@Example.com',
      email_verified: true,
      name: 'Ada Lovelace',
      picture: 'https://lh3.googleusercontent.com/a/ada',
    }),
    {
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      picture: 'https://lh3.googleusercontent.com/a/ada',
    },
    'the address is lower-cased, since it is what an account is matched on'
  );

  t.same(
    identityFromClaims({ email: 'a@b.test', email_verified: true }),
    { email: 'a@b.test', name: '', picture: null },
    'a provider that sends neither name nor picture is still an identity'
  );

  t.equal(identityFromClaims({ email: 'a@b.test', email_verified: false }), null, 'unverified');
  t.equal(identityFromClaims({ email: 'a@b.test' }), null, 'no claim at all is not a yes');
  t.equal(identityFromClaims({ email_verified: true }), null, 'no address');
  t.equal(identityFromClaims(null), null, 'no claims');
});

t.test('a verifier without a client id is a mistake, not a default', async (t) => {
  // Left optional, an unset environment variable would silently disable the
  // audience check — the one that matters most here.
  t.throws(() => createGoogleVerifier({}), /clientId/);
});
