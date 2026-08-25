# OAuth — Sign in with Google

Google is the identity provider. The accounts, roles and session cookie remain
this application's.

```
browser ──sign in──▶ Google
browser ◀──ID token── Google
browser ──POST /api/auth/google { token }──▶ server
                                             ├─ verify signature, issuer, audience, algorithm
                                             ├─ require email_verified
                                             ├─ find or create the account
                                             └─ start an ordinary session cookie
```

**Proving an identity to Google is not a way to be granted anything here.** A
first-time address gets an account on exactly the footing self-registration
leaves somebody on, and no more.

---

## 1. Configuration

Two variables, the same value, configured separately:

| Variable | Read by | Why separate |
| :--- | :--- | :--- |
| `GOOGLE_CLIENT_ID` | the server, at runtime | verifies the token's `aud` |
| `VITE_GOOGLE_CLIENT_ID` | the client, **at build time** | baked into the bundle, so it cannot be read from the server's config |

A client id is public — it is published to every browser that loads the sign-in
button — so there is nothing lost by having it in the bundle.

**With `GOOGLE_CLIENT_ID` unset the route is never mounted:**

```js
if (config.googleClientId) {
  const verifyGoogleToken = createGoogleVerifier({ clientId: config.googleClientId });
  fastify.post('/google', …);
}
```

An installation that does not want Google sign-in does not have an unused way
in. On the client, `GOOGLE_CLIENT_ID &&` guards the button, so the form is simply
the only route in.

There is **no client secret**. This is the ID-token flow, not the authorization
code flow: the browser completes sign-in with Google directly and the server only
ever verifies the resulting assertion. Nothing is exchanged server-to-server, so
there is no secret to keep.

---

## 2. Verifying the token

`server/auth/google.js`.

```js
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
```

Two spellings of the issuer, because Google uses both.

```js
const keys = createRemoteJWKSet(new URL(jwksUrl));

const { payload } = await jwtVerify(token, keys, {
  issuer: issuers,
  audience: clientId,
  algorithms: ['RS256'],
});
```

`createRemoteJWKSet` caches the keys and re-fetches when a token arrives bearing
a key id it has not seen, which makes Google's key rotation a non-event.

### The two checks that matter most

**`audience`.** Google signs ID tokens for *every application on the platform*
with the same keys, so a token minted for somebody else's app carries a perfectly
good signature. `aud` is what says this one was minted for us. Without this check,
any Google developer could sign in as anyone.

**`algorithms: ['RS256']`.** Pinned deliberately. Left open, a token is verified
with whichever algorithm it nominates *in its own header* — which is the door
`alg: none` and HMAC-signed-with-the-public-key walk through.

`jwtVerify` also enforces `exp` and `nbf`.

### A factory, not a singleton

```js
export function createGoogleVerifier({ clientId, jwksUrl = …, issuers = … })
```

So the tests can point one at a key set of their own, and so an app with no
client id configured never builds one and never reaches the network.

---

## 3. From claims to an identity

```js
export function identityFromClaims(claims) {
  const email = String(claims?.email || '').trim().toLowerCase();
  if (!email) return null;
  if (claims.email_verified !== true) return null;
  return { email, name: …, picture: … };
}
```

**`email_verified !== true` is refused outright.** The address is what an account
is matched on, so holding a Google account that merely *claims* somebody else's
address would otherwise be enough to be handed their account here. The strict
`!== true` matters: Google has historically sent this as both a boolean and the
string `"true"`, and only the boolean is accepted.

The address is lower-cased, matching how `findRawBy` compares it.

`picture` comes along so a first sign-in has a face to start with. It is optional
— the claim is absent for an account with no photo.

The route returns **403** for a null identity: *"That account has no verified
email address."*

---

## 4. Creating or linking the account

`server/auth/accounts.js`. Both ways in — a password sign-up and a Google
sign-in — land in this module, so the two cannot drift apart on what a new
account starts with.

### A new account

```js
const user = await users.create({
  email: identity.email,
  first_name: first || identity.email.split('@')[0],
  last_name: rest.join(' ') || null,
  password: unusablePassword(),
  is_active: true,
  email_confirmed: true,
  logo: pictureOrNull(identity.picture, log),
  language: normaliseLanguage(language),
  roles: await defaultRoleIds(repositories, log),
});
```

Four decisions worth naming:

**The unusable password.**

```js
const unusablePassword = () => `${randomBytes(24).toString('base64url')}Aa1!`;
```

A row still needs one. It is long enough to be unguessable and shaped to satisfy
`PASSWORD_RULES` so the model accepts it. The point is that password sign-in for
such an account is **impossible**, not that the value is ever used. There is no
way to retrieve or reset it to something known — that would require a password
reset flow, which does not exist.

**`email_confirmed: true`.** Google verified the address before it would put it
in a token, and `identityFromClaims` refuses one that says otherwise. There is
nothing left for this application to confirm.

**The name.** Providers are not obliged to send one, so the local part of the
address is used as a placeholder — a better one than an empty required field.
`name` is split on whitespace: first token to `first_name`, the rest to
`last_name`.

**The role.** `DEFAULT_ROLE = 'user'`, looked up **by name on each use** rather
than by a cached id, because roles are seeded rows and an installation may have
edited this one. If it has been deleted the account starts with no roles and a
warning is logged.

### An existing account

An account that already exists **keeps everything it has.** Two things are filled
in:

```js
const patch = {};
if (!existing.email_confirmed) patch.email_confirmed = true;
const picture = pictureOrNull(identity.picture, log);
if (!existing.logo && !existing.logo_file && picture) patch.logo = picture;
```

The address is now proven, and a picture where there was none. **A logo the
person set is theirs and is left alone** — signing in again is not a reason to
overwrite it with whatever Google currently holds. The `logo_file` check means an
uploaded picture also counts as "has one".

This is the account-linking rule, and it is deliberately simple: **same address,
same account.** A password account and a Google sign-in on the same address are
the same person. That is safe here precisely because the address is verified;
without `email_verified`, this would be an account takeover.

### The picture is checked like any other URL

```js
function pictureOrNull(picture, log) {
  if (!picture) return null;
  try { return normaliseLogo(picture); }
  catch (err) { log?.warn(…); return null; }
}
```

`normaliseLogo` refuses anything but `http(s)` — a logo is rendered as an
`<img src>`, and `javascript:` or `data:` in that position is a script or a
payload. The claim is only as trustworthy as the token it rode in on.

**Dropped rather than raised:** whether somebody can sign in must not turn on
whether their picture is usable.

---

## 5. The route

```js
fastify.post('/google', { preHandler: fastify.rateLimit('login') }, async (request, reply) => {
```

Rate limited on the `login` policy. It is cheaper than bcrypt, but it is still an
unauthenticated endpoint that will create a row.

| Failure | Status | Body |
| :--- | :--- | :--- |
| no token | 400 | `A sign-in token is required` |
| verification threw | 401 | `Invalid or expired sign-in` |
| unverified email | 403 | `That account has no verified email address` |
| account disabled | 403 | `This account is disabled` |

The verification failure is deliberately vague to the client and specific in the
log:

```js
request.log.warn(`Rejected a Google ID token: ${err.message}`);
```

Which of signature, issuer, audience, algorithm or expiry failed is useful to
whoever runs the server and of interest to nobody else.

On success: `forgetRateLimit`, `startSession`, and the same `{ ok: true, user }`
a password login returns. From that point the session is indistinguishable from
any other.

---

## 6. The client

`src/pages/LoginPage.jsx`.

```jsx
<GoogleOAuthProvider key={googleLocale} clientId={GOOGLE_CLIENT_ID} locale={googleLocale}>
  <GoogleLogin
    onSuccess={handleGoogle}
    onError={() => setError(t('auth.googleFailed'))}
    theme="filled_black" shape="pill" text="continue_with"
    width={googleWidth}
  />
</GoogleOAuthProvider>
```

**Google renders and owns the button.** There is no styling of ours on it, which
is a condition of using the sign-in flow. Two things *are* ours:

**The locale.** Left unset, the button follows the browser — or the visitor's
Google account — which is how an English UI ended up with a Ukrainian button. The
`key` is what makes a language switch take effect: the provider memoises its
context on `clientId` and script-loaded alone, so a new `locale` prop would never
reach the button. Remounting rebuilds the context and reloads Google's script
with the matching `?hl=`.

**The width.** Google renders at a width in pixels and will not take a
percentage, so it is measured from the container with a `ResizeObserver` and
clamped to Google's own accepted range (200–400 px).

`handleGoogle` hands the credential to `AuthContext`:

```js
const data = await api('/api/auth/google', {
  method: 'POST',
  body: { token, language: i18n.resolvedLanguage },
});
```

`language` is only used if this is a first sign-in and the account is being
created. **Nothing here is trusted to say who the user is** — the server decides
whether the token is genuine and which account it belongs to.

---

## 7. Testing it without Google

`test/auth/google.test.js` builds its own key pair and JWKS, so signature,
issuer, audience and algorithm are all asserted with no network. `googleAccount`
is deliberately a plain function taking `repositories` rather than living in the
route, so the account rules are testable without a token, a key set or a
verifier.

---

## 8. What is not implemented

- **No refresh tokens, no Google API access.** The ID token is used once, to
  establish identity, and discarded. Nothing is stored from Google beyond the
  address, name and picture URL.
- **No other providers.** The verifier is parameterised over `jwksUrl`,
  `issuers` and `clientId`, so another OIDC provider would be a second
  `createGoogleVerifier`-shaped factory and a second route — but the account
  matching in `accounts.js` assumes one verified address per person.
- **No account unlinking**, and **no password reset**. An account created by
  Google has an unusable password and no way to set one.
- **No `nonce` check.** The library-generated token is verified for audience and
  signature but not replay-bound to a session-specific nonce.

Related: [Users, roles and permissions](permissions.md) ·
[Throttling](throttling.md) · [Fastify](fastify.md)
