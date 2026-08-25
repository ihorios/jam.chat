# Throttling

Flood control: how often one caller may do one thing. Five policies, one
counter, and a deliberate decision about *who* a caller is.

---

## 1. The algorithm

`server/rate-limit/index.js` is a **fixed window counter** — the shape a
key-value server gives you for free:

```
INCR key
EXPIRE key on first touch
refuse when it goes past the limit
```

The in-memory implementation is written as that same operation on purpose, so
swapping in Redis is this file and nothing else.

```js
async hit(key, { limit, windowSeconds }) {
  const now = Date.now();
  const existing = buckets.get(key);
  const bucket = existing && existing.resetAt > now
    ? existing
    : { count: 0, resetAt: now + windowSeconds * 1000 };   // an expired window never happened
  bucket.count += 1;
  buckets.set(key, bucket);
  return { allowed: bucket.count <= limit, remaining: …, retryAfter: …, resetAt: … };
}
```

### The known imprecision

A fixed window is not the most precise algorithm. A caller who spends their whole
allowance at the end of one window and again at the start of the next gets
**twice the limit across that boundary**.

For flood control — stopping somebody hammering login or flooding a peer with
candidates — that is fine, and it is worth far more than the sliding-window
bookkeeping it would take to close a gap nobody is exploiting.

### Pruning

```js
const PRUNE_INTERVAL_MS = 60 * 1000;
```

Without it the map grows one entry per distinct key forever, which turns the
thing meant to absorb a flood into a way of causing one. The interval is
`unref()`ed and cleared on shutdown.

---

## 2. The five policies

`server/config/env.js`. Each is `<attempts> per <window seconds>`, and each is
overridable by two environment variables — `<NAME>_RATE_LIMIT_MAX` and
`<NAME>_RATE_LIMIT_WINDOW_SECONDS`.

| Policy | Default | Counted per | Guards |
| :--- | :--- | :--- | :--- |
| `login` | 10 / 300 s | **address** | password guessing. The tightest, because each attempt costs a bcrypt |
| `register` | 5 / 3600 s | **address** | it is public, and it creates rows |
| `upload` | 30 / 300 s | **session** | 3 files × 5 MB is a lot of bandwidth to repeat |
| `signal` | 600 / 60 s | **socket** | offers and candidates arrive in bursts, so it is generous |
| `ice` | 600 / 300 s | **session** | the relay credentials. Deliberately outside the `api` guard — see below |
| `api` | 600 / 300 s | **address** | the catch-all over `/api` |

`RATE_LIMIT_ENABLED=false` turns all of it off. The boot log says so as a
**warning**, not a note — it only happens because somebody set it, and it leaves
login and registration with no flood control at all.

---

## 3. Who a caller is

This is the decision worth understanding.

```js
const callerOf = (request) => (request.user ? `user:${request.user.id}` : `ip:${request.ip}`);
```

**An address is shared by everyone behind one office router.** So anything
already behind a session counts per session instead. Login and registration have
no session yet, which is exactly why they are the ones counted per address.

The bucket key is `<policy>:<caller>`, so the five policies never share a count.

### Two deliberate overrides

**The API guard counts per address even for signed-in callers:**

```js
await app.rateLimit('api', (req) => `ip:${req.ip}`)(request, reply);
```

It runs as a global `onRequest` hook, before any route's `preHandler` has
authenticated anybody, so `request.user` would be `null` regardless.

**Signalling counts per socket, not per session:**

```js
allow: async (connectionId) => {
  const { allowed } = await fastify.limiter.hit(`signal:${connectionId}`, config.rateLimits.signal);
  return allowed;
}
```

One tab flooding must not silence the same person's other calls.

---

## 4. Two decorators

`server/plugins/rate-limit.js` exposes the counter twice, because not everything
that needs it is an HTTP request.

**`fastify.rateLimit(policy, keyOf?)`** — a preHandler factory:

```js
fastify.post('/login', { preHandler: fastify.rateLimit('login') }, …);
```

On refusal it logs a warning with the policy, address and user, sets
`Retry-After`, and throws a `429`.

**`fastify.limiter`** — the raw counter, for the places that are not routes. A
WebSocket frame is not a route, and a peer flooding another with candidates never
touches a preHandler.

**`fastify.forgetRateLimit(policy, request)`** — drops a caller's count.

---

## 5. Where each is applied

| Where | Policy | Note |
| :--- | :--- | :--- |
| `POST /api/auth/login` | `login` | |
| `POST /api/auth/google` | `login` | cheaper than bcrypt, but still unauthenticated and it will create a row |
| `POST /api/auth/register` | `register` | |
| `POST /api/files` | `upload` | **after** `authorize`, so the count is against a session |
| `call:signal` frames | `signal` | before anything is looked up |
| everything under `/api/` **except `/api/calls/ice`** | `api` | global `onRequest` hook |

The upload ordering is explicit and commented:

```js
preHandler: [fastify.authorize(filesModel, 'create'), fastify.rateLimit('upload')],
```

Authorised first, so several people behind one router upload independently.

### Is the ICE allowance enough for calls?

Comfortably, and by a margin that makes it a backstop rather than a bound.

A tab fetches ICE **once, and caches it** until shortly before the credential it
carries expires — `TURN_TTL_SECONDS` less a minute, so **59 minutes** by
default. It asks only when somebody places or answers a call.

| | |
| :--- | :--- |
| fetches per tab, per 300 s window | **at most 1** |
| allowance, per session (all that account's tabs share it) | **600** |
| tabs one account would need, all calling at once, to reach it | **600** |
| worst case — a *failing* fetch retries every 240 s | 1.3 per tab per window, so **480 tabs** |

So nothing a person does reaches it. What it catches is a client gone wrong —
a retry loop with no backoff — which is what a limit on this endpoint is
actually for.

### One exemption, and why it is not a hole

`/api/calls/ice` is skipped by the address-wide guard and carries its own
session-scoped policy instead.

Counted per address, it shared an allowance with every other request from the
same office router. Spending it made the endpoint answer `429` — and the browser
answers a failed ICE fetch by **falling back to STUN with no relay**:

```js
catch { return { iceServers: FALLBACK_ICE, ttl: 300, degraded: true }; }
```

So calls went on working everywhere except the networks that needed TURN:
symmetric NAT, strict corporate firewalls. That is the hardest kind of fault to
trace back to a rate limit, which is why it now has its own allowance and why
the fallback logs and reports `degraded` rather than passing silently.

**The exemption applies only to a request carrying a session**, and that
condition is load-bearing rather than tidy:

```js
const hasSession = request.headers.cookie?.includes('session=');
if (request.url.startsWith('/api/calls/ice') && hasSession) return;
```

The route's own policy sits behind `authenticate`, so an anonymous request is
refused with a `401` before it is ever reached. A bare path check therefore
exempted anonymous callers from the address guard *and* never reached the
session one — leaving that path counted by nothing at all. Read off the raw
header rather than `request.cookies`, so it does not depend on running after
whichever hook parses them.

### Success clears the count

```js
await fastify.forgetRateLimit('login', request);
```

Both `/login` and `/google` do this. Somebody who mistyped their password twice
and then got it right is not who the limit is aimed at.

---

## 6. What the refusal says

```js
reply.header('Retry-After', String(retryAfter));
const error = new Error(`Too many requests. Try again in ${retryAfter} seconds.`);
error.statusCode = 429;
```

`Retry-After` is the part a well-behaved client acts on; the message is for the
person reading it. **Neither says what the limit is** — that only helps somebody
working out how to stay just under it.

`retryAfter` is whole seconds and at least 1, ready for the header.

---

## 7. Limits that are not rate limits

Several ceilings elsewhere do a similar job:

| Limit | Value | Where |
| :--- | :--- | :--- |
| file size | 5 MB | `@fastify/multipart` **and** re-checked in the route |
| files per message | 3 | same |
| multipart non-file fields | 4 | `plugins/files.js` |
| signalling payload | 64 KB | `MAX_SIGNAL_CHARS` in `realtime/calls.js` |
| picture size | 1 MB | `files/picture.js` |
| logo URL length | 2048 | `models/users.js` |
| ring timeout | 40 s | `CALL_RING_SECONDS` |
| S3 request timeout | 20 s | `S3_TIMEOUT_MS` |

The multipart limits are enforced twice on purpose. The parser throws
`FST_FILES_LIMIT` and `FST_REQ_FILE_TOO_LARGE`, whose messages are written for
whoever configured it — so the route matches on **code** and rewords them,
because *"please check multipart config"* is advice for the developer, not for
somebody trying to send a photograph.

---

## 8. Limitations

**In-memory means per-instance.** Two instances each count their own share, so a
flood spread across both gets double the allowance. The factory exists precisely
so a `REDIS_URL` branch is a change to one function:

```js
export function createRateLimiter() {
  return createMemoryRateLimiter();
}
```

**Counts do not survive a restart.** A restart forgives everybody.

**`/ws` is outside the API guard**, and only `call:signal` is counted inside the
socket. `read` and `unread` frames are unlimited — they are idempotent and cheap,
but they are not free.

Related: [Fastify](fastify.md) · [WebSockets](websocket.md) ·
[Files and S3](file.md)
