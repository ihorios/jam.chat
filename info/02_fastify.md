# Fastify

The server is Fastify 5. `server/index.js` starts it; `server/app.js` builds it.
The split matters: `buildApp()` returns a configured instance without listening,
which is what lets the whole test suite run against `app.inject()` with no port
and no network.

---

## 1. Boot

`server/index.js` does four things, in order:

1. `await buildApp()` inside a `try`. Building is *meant* to be unfailable —
   every plugin that talks to something outside the process reports its own
   failure and carries on. The catch is for what is left: a programming error,
   a bad configuration value. There is no server to serve an explanation from,
   so it prints and exits 1.
2. Registers `SIGINT`/`SIGTERM` handlers. `app.close()` lets in-flight requests
   finish and releases the Postgres pool.
3. A shutdown deadline — `config.shutdownTimeoutMs`, five seconds by default.
   If `close()` stalls on a wedged query, the process exits anyway rather than
   holding the port, because the instance replacing this one needs it. The timer
   is `unref()`ed so it can never itself keep the process alive.
4. `app.listen()`, with a `listenTextResolver` so the boot banner is printed as
   plain text on stdout rather than as JSON in the logger.

### The banner

`BOOT_BANNER` is `🚀 Fastify backend service running at`. Fastify announces each
bound address through its logger, which would bury the one line a person watches
for at startup inside JSON. A `logMethod` hook in the logger config recognises
the prefix and diverts it to `console.log`.

---

## 2. Plugin order

From `server/app.js`. The order is not arbitrary — each line has a reason.

| # | Plugin | Why here |
| --: | :--- | :--- |
| 1 | `subsystems` | everything below reports to it, including on the way down |
| 2 | `error-handler` | so a failure in any later plugin's routes has a shape |
| 3 | `rate-limit` | before everything it guards, and before auth — so a flood of bad passwords is refused *without* the bcrypt it was trying to spend |
| 4 | `db` | decorates `fastify.models` |
| 5 | `auth` | needs `models.users` |
| 6 | `realtime` | after auth: the WebSocket handshake reads the session cookie |
| 7 | `files` | needs `models` for the sweep |
| 8 | `static` | last, because its `setNotFoundHandler` is the fallback for everything |

All eight use `fastify-plugin` (`fp`), which keeps their decorators on the root
instance instead of scoping them to the plugin. Without it, `fastify.models`
would not be visible to sibling route plugins.

Declared dependencies are enforced by avvio:

```js
export default fp(realtimePlugin, {
  name: 'realtime',
  dependencies: ['auth', 'db', 'rate-limit'],
});
```

### Route registration

```js
await app.register(healthRoutes);                                  // no prefix
await app.register(authRoutes,        { prefix: '/api/auth' });
await app.register(metaRoutes,        { prefix: '/api' });
await app.register(presenceRoutes,    { prefix: '/api' });
await app.register(callRoutes,        { prefix: '/api' });
await app.register(messengerRoutes,   { prefix: '/api/messenger' });
await app.register(fileRoutes,        { prefix: '/api/files' });
await app.register(userPictureRoutes, { prefix: '/api/users' });

for (const model of modelList) {
  await app.register(crudRoutes(model), { prefix: `/api/${model.name}` });
}
```

The loop at the bottom is the point. Model routes are never listed by hand —
adding a file to `server/db/models/` mounts its endpoints. Two route plugins
deliberately share a prefix with a generated one:

- `fileRoutes` at `/api/files` — the `files` model declares no `create` action,
  so `POST /api/files` belongs to the upload route alone.
- `userPictureRoutes` at `/api/users` — setting a picture is two writes at once
  (a file row, and the user pointed at it), so it is not a field update.

---

## 3. Two global `onRequest` hooks

Both are registered on the root instance, after the plugins and before the
routes, and both apply only to `/api/`.

**The flood guard.** A catch-all over the API, per address, on the `api` policy
(600 per 300s by default). Static files and `/ws` are outside it deliberately —
a conversation runs on the socket, and a dashboard tab costs a handful of
requests. Anything approaching the ceiling is a script. See
[Throttling](throttling.md).

**The subsystem guard.**

```js
const down = app.subsystems.blocking();
if (!down) return;
reply.header('Retry-After', '30');
return reply.status(503).send({ ok: false, error: `The ${down} is unavailable…` });
```

Every API route reads or writes a model, so the whole prefix goes at once rather
than each route discovering the problem separately and failing somewhere less
legible. `503` and not `500`: the request was fine, the server is not, and
`Retry-After` says the difference is expected to be temporary.

Outside the prefix on purpose: static files, the health endpoints and the
readiness report all still work. That is what makes a degraded instance
possible to look at.

---

## 4. Subsystems, and staying up

`server/subsystems.js` is the whole of it. The argument, from its own header
comment: a process that refuses to start says nothing to whoever is trying to
use it, takes the health endpoint down with it, and on most orchestrators turns
into a restart loop that hides the original error among a hundred copies.

```js
export const REQUIRED = Object.freeze(['database']);
```

Only the database is required. Attachments are not — a conversation without them
is most of the application, so the file routes refuse individually while the
rest of the API carries on.

| Method | Meaning |
| :--- | :--- |
| `up(name, detail)` | working |
| `down(name, err)` | broken, with the reason. Logged at error level **exactly once**, here, rather than by each caller |
| `ok(name)` | unknown counts as working — nothing has claimed it |
| `blocking()` | the first `REQUIRED` subsystem that is down, or `null` |
| `report()` | everything known, for `/readyz` |

**Recovery is deliberately not automatic.** The fault is recorded, not retried:
a half-migrated schema retried on every request is worse than one that stays
down until somebody looks at it.

### `withDeadline`

```js
export function withDeadline(ms, label, work)
```

Bringing a subsystem up is network-bound, and the failure that matters is not an
error but a *wait*. A database that accepts the connection and then blocks on a
lock would hang the boot until Fastify's plugin timeout killed the process —
which is the outcome all of this exists to avoid.

The work is **not cancelled**, because it cannot be: a query already sent will
finish in its own time. What the deadline bounds is how long anybody waits for
it, which is why `label` exists — it says which one was abandoned if it later
complains.

Three budgets, the inner two well inside the outer:

| Setting | Default | Guards |
| :--- | --: | :--- |
| `PLUGIN_TIMEOUT_MS` | 30000 | avvio's own ceiling (Fastify's default of 10s is a poor fit for network-bound boot) |
| `SHUTDOWN_TIMEOUT_MS` | 5000 | the bound on the way *out*, in `server/index.js` — keep it under whatever the platform allows between SIGTERM and SIGKILL |
| `DB_BOOT_TIMEOUT_MS` | 15000 | connect + schema + seed, as one unit |
| `FILE_BOOT_TIMEOUT_MS` | 15000 | settling where attachments go |

Whichever fires first decides what the failure looks like. The inner ones
produce a running server that says what is wrong; the outer one produces no
server at all.

---

## 5. Health endpoints

`server/routes/health.js`. Liveness and readiness are different questions.

| Route | Answers | Behaviour |
| :--- | :--- | :--- |
| `GET /liveness` | is this process running | `{ ok: 1 }`, unconditionally |
| `GET /healthz` | same | same |
| `GET /readyz` | can it serve the API | `503` + `subsystems.report()` when something required is down |

`render.yaml` points its health check at `/liveness` on purpose. A probe that
failed while the database was unreachable would have the platform replace an
instance that is up and explaining itself with one that will fail identically,
on a loop. `/readyz` is not wired to anything that restarts on a red answer.

---

## 6. Error handling

`server/plugins/error-handler.js` is fourteen lines and does one thing, so route
handlers can `throw` instead of repeating try/catch:

```js
const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
if (status >= 500) fastify.log.error(error);
else fastify.log.info({ err: error.message }, 'Rejected request');

return reply.status(status).send({
  ok: false,
  error: status >= 500 ? 'Internal server error' : error.message,
});
```

**A 5xx returns its message only if the error asks.** Client errors carry theirs,
because they are advice; server errors do not, because they are usually a stack
trace with somebody's connection string in it. `error.expose = true` is the
opt-out, for the server failures that *are* advice — a bucket that would not
delete an object, so the file was left alone and the caller should try again.
"Internal server error" tells that person nothing they can act on. `ValidationError`
(`server/db/models/fields.js`) sets `statusCode = 400`, so a model rejecting bad
input becomes a `400` with a readable message and no route has to catch it.

Every response body in the application has the same shape: `{ ok, ... }` or
`{ ok: false, error }`. `src/lib/api.js` on the client treats `ok: false` as a
throw even on HTTP 200, so callers need exactly one `catch`.

---

## 7. Static files

`server/plugins/static.js` serves the Vite build and nothing else.

```
staticDir = STATIC_DIR || <project root>/dist
```

**There is deliberately no fallback to the project root.** That would publish
`.env`, `package.json` and the whole server source over HTTP.

Cache headers are set per file:

| Path | `Cache-Control` | Why |
| :--- | :--- | :--- |
| `assets/*` | `public, max-age=31536000, immutable` | filenames carry a content hash, so a URL never changes meaning |
| `index.html` | `no-cache` | it is the thing that *names* those hashes; a stale copy points at deleted files |

### The not-found handler

Three cases, in order:

1. **`/api/*`** → a real `404` JSON body. Only the SPA gets `index.html`.
2. **Anything with a file extension** → also a real `404`. This one is subtle:
   handing `index.html` to a request for a missing `.js` returns HTML labelled
   `text/html`, which the browser refuses to execute as a module. The page then
   renders blank with no useful error.
3. **Everything else** → `index.html`, so client-side routes resolve on a hard
   refresh. Unless there is no build, in which case `503` and "run `npm run build`".

`fp()` is required on this plugin: `setNotFoundHandler` and `@fastify/static`'s
`sendFile` decorator would otherwise apply only inside its own scope.

---

## 8. Configuration

`server/config/env.js` is the only module that reads `process.env`. Everything
else imports `config` from it, so the import graph guarantees `.env` is loaded
first — no reliance on declaration order. Real environment variables take
precedence over the file, so hosted deploys are unaffected.

`config` is `Object.freeze`d. Notable entries:

| Key | Default | Note |
| :--- | :--- | :--- |
| `port` | 3000 | |
| `host` | `0.0.0.0` | |
| `sessionSecret` | random per process | warns loudly when unset; multiple instances reject each other's cookies |
| `sessionMaxAgeSeconds` | `60*60*24*7*30` | **210 days** — the comment beside it says 30. See the [note](README.md#notes-on-this-documentation) |
| `trustProxy` | `1` in production, else `false` | |
| `connectionString` | `DB_STRING` then `DATABASE_URL` | absent → in-memory store |
| `googleClientId` | `null` | absent → the `/api/auth/google` route is never mounted |
| `shutdownTimeoutMs` | 5000 | how long a shutdown gets before the process stops waiting |
| `callRingSeconds` | 40 | |
| `fileMaxBytes` | 5 MB | |
| `fileMaxPerMessage` | 3 | |

### `trustProxy` deserves its own paragraph

Behind a load balancer every request appears to come from the same address, so
without this the rate limiter would put every user in one bucket and lock them
all out together. It is set to **one hop** rather than `true`, because trusting
the whole `X-Forwarded-For` chain lets a client prepend an address of its
choosing and pick its own bucket.

---

## 9. Everything the server exposes

| Route | Guard |
| :--- | :--- |
| `POST /api/auth/login` | rate limit `login` |
| `POST /api/auth/register` | rate limit `register` |
| `POST /api/auth/google` | rate limit `login`; mounted only with a client id |
| `POST /api/auth/logout` | none |
| `GET /api/auth/me` | session |
| `GET/POST/PUT/DELETE /api/<model>` | generated per model and action |
| `GET /api/<model>?search=&scope=&<reference>=` | the three ways a list narrows — see [permissions §4](permissions.md#4-how-a-scope-narrows-a-request) |
| `POST /api/files` | `files:create` |
| `GET /api/files/:id/content` | session, then readability — see [attachments](attachments.md) |
| `PUT/DELETE /api/users/:id/picture` | `users:update` at either scope |
| `POST /api/messenger/groups/:id/invite` | session + membership |
| `POST /api/messenger/groups/:id/leave` | session + membership |
| `GET /api/messenger/unread` · `POST /api/messenger/read` | session |
| `GET /api/meta` · `GET /api/permissions` | session |
| `GET /api/presence` | `users:read` (unscoped) |
| `GET /api/calls/ice` | session |
| `GET /liveness` · `/healthz` · `/readyz` | none |
| `WS /ws` | **session required** — a handshake without one is closed with `1008` |
