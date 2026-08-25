# WebSockets

One socket per open tab, carrying everything live: new messages, edits,
deletions, unread counts, presence and call signalling. `@fastify/websocket`
mounts it at `/ws`.

The governing rule, from `server/plugins/realtime.js`:

> Delivery is decided by the same permissions as a request — with one
> deliberate exception. An event reaches a socket only if its user could have
> fetched the row over HTTP, *except* a message, which follows membership
> instead: the socket serves the messenger, and the messenger is somebody's own
> conversations. See [§4](#4-fan-out).

---

## 1. The handshake

The WebSocket upgrade is an ordinary HTTP request, so the session cookie is sent
by the browser automatically. There is no token to attach and nothing for
JavaScript to leak.

```js
const connectionId = randomUUID();
const user = await fastify.sessionUser(request).catch(() => null);
if (!user) { socket.close(1008, 'Authentication required'); return; }
```

**A session, or no socket.** `sessionUser` returns `null` rather than throwing,
and that answer now closes the connection with `1008` (Policy Violation).

Anonymous connections used to be welcome, so that a browser on the login page
counted towards presence and could be *promoted in place* on sign-in rather than
replaced. Neither held up. The client reopens whenever the identity changes
(`RealtimeContext` keys its effect on the user id), so the promotion path was
never once exercised — and what remained was a dashboard tile counting
login-page visitors.

What it cost was the only unauthenticated-reachable path in the application with
a database bill: every open publishes a presence event, and every presence event
reads every watching user. Refusing is better than bounding, because a limit
still admits the traffic it allows.

The client does its half too: `RealtimeContext` opens no socket at all without a
session. Opening one anyway would turn every signed-out visitor into a permanent
reconnect loop against a door that never opens.

The first frame out is always `hello`:

```json
{ "type": "hello", "connectionId": "…", "user": { "id": 1, "name": "…", "email": "…" },
  "groups": { "3": 2 }, "total": 2 }
```

Presence is published *after* `hello`, so a dashboard opening its own socket is
counted in the first presence frame it receives.

### The socket remembers who it belongs to

```js
const IDENTITY_TTL_MS = 5000;
```

Every frame used to re-read the account — **three queries**, since hydrating a
user pulls their roles for their permissions. That made establishing *who was
asking* the dominant cost of the socket: four repository calls to answer an
`unread`, three of them the question rather than the answer. It is now **1.00
per frame**.

What the re-read enforces is narrower than it looks. No frame handler consults
permissions: calls check membership, and `read` and `unread` check it too, each
for itself and freshly. What is left is `is_active`.

So the trade is bounded and worth naming: **a disabled account may go on sending
frames for up to five seconds**, on a socket it already had open. Measured:

```
account disabled at t=0
  t + 0.3s   still answered
  t + 2.3s   still answered
  t + 5.8s   REFUSED
```

It is not a way past authentication — a socket cannot exist without a session in
the first place. This only decides how often the account behind an existing one
is re-examined.

### Identity is never taken from the frame

```js
const current = entry.userId
  ? await fastify.models.users.findById(entry.userId)
  : await fastify.sessionUser(request).catch(() => null);
if (!current?.is_active) return send(socket, { type: 'error', error: 'Authentication required' });
```

Read from the session on **every inbound frame**, never from what the client
says. A client saying who it is proves nothing. It is also re-read from the
database each time, so a deactivated account stops being able to act without
waiting for a reconnect.

---

## 2. Frames

### Client → server

| Type | Payload | Effect |
| :--- | :--- | :--- |
| `ping` | — | replies `pong` |
| `read` | `{ group }` | marks read, replies `unread` |
| `unread` | — | replies `unread` |
| `call:start` | `{ group }` | see [Calls](calls.md) |
| `call:join` | `{ group }` | |
| `call:leave` | `{ group }` | |
| `call:signal` | `{ group, to, payload }` | |

Anything else gets `{ type: 'error', error: 'Unknown message type "…"' }`.
Unparseable input gets `Expected JSON`.

### Server → client

| Type | Carries |
| :--- | :--- |
| `hello` | `connectionId`, `user`, initial unread |
| `unread` | `{ groups, latest, total }` — counts per group, plus the last line said in each, for the sidebar |
| `presence` | `{ total, authenticated, people }` |
| `message` | a whole message row (new **or** edited) |
| `message-deleted` | `{ id, group }` |
| `group` | a whole group row |
| `group-gone` | `{ id }` |
| `call:*` | seven frames — see [Calls](calls.md) |
| `pong`, `error` | |

---

## 3. The store

`server/realtime/store.js` holds who is connected and how events reach them.
Both halves are deliberately shaped **like a key-value server rather than like
JavaScript**: every method is async, connections are addressed by an opaque
string id, and nothing hands out a live object a caller could mutate.

```js
connect              HSET presence:<id> … + SADD presence:ids
disconnect           DEL  presence:<id>   + SREM presence:ids
connections          SMEMBERS + HGETALL, or a SCAN
publish / subscribe  PUBLISH / SUBSCRIBE on one channel
```

The in-memory implementation is the whole of it today, and it **only works for
one process** — two instances would each know their own sockets. Swapping in
Redis means implementing that interface and nothing else; callers already await
everything.

`publish` never makes a publisher wait on delivery, and one bad subscriber
cannot stop the others:

```js
Promise.resolve().then(() => handler(event)).catch(() => {});
```

---

## 4. Fan-out

Every write in `routes/crud.js` announces itself:

```js
await fastify.realtime?.publish({ type: 'created', model: model.name, row });
```

The route does not decide who hears about it. One subscriber in
`plugins/realtime.js` branches on `event.model`:

| `event.model` | Handler |
| :--- | :--- |
| `presence` | recount and tell the watchers |
| `calls` | addressed delivery to named connection ids |
| `user_groups` | `deliverGroup` |
| `user_messages` | the message loop |
| anything else | ignored |

The `calls` branch is why delivery goes through the store rather than straight
to a socket: with a KV backend every instance receives the event and delivers to
whichever addressees it happens to hold. The rest are somebody else's sockets.

### `maySee` — the whole authorisation rule

```js
const maySee = async (user, model, row) => {
  const scope = grantedScope(model, 'read', user.permissions);
  if (!scope) return false;
  if (scope === 'any') return true;
  if (scope === 'own') return model.ownedByUser(row, user.id);
  if (scope === 'member') {
    const via = model.membershipVia;
    return via
      ? fastify.models[via.target].isMemberOf(row[via.name], user.id)
      : fastify.models[model.name].isMemberOf(row.id, user.id);
  }
  return false;
};
```

`grantedScope` is imported from `plugins/auth.js` — the *same function* the HTTP
guard uses. One implementation, two callers, no chance of the socket and the
route disagreeing.

Membership is answered through the row the model **defers to** rather than by
asking the model about its own id. That matters for a deletion: by the time the
event is handled the row is gone, so looking it up again would say "no" to
everybody who should have been told.

### Messages follow membership, not the read permission

`maySee` governs group frames. Messages use a narrower rule:

```js
const inTheConversation = (user, model, members) => {
  if (!grantedScope(model, 'read', user.permissions)) return false;
  return members.has(Number(user.id));
};
```

`members` is handed in rather than looked up — it is the same answer for every
socket receiving one event. See the next section.

This is **the one place the socket answers a different question from the
route**, so it is worth knowing why. `user_messages:read` unscoped is an
administrator's permission and the dashboard is what it is for — and the
dashboard fetches, subscribing to nothing. The socket exists for the messenger,
and `/chats` is somebody's own conversations rather than a moderation tool.

Without it, an administrator's chats page filled with strangers' groups the
moment anybody said anything.

It is also the rule the unread count has always used — see `unreadFor`, and its
note that an administrator reading every group is not thereby behind on every
conversation. Delivery simply never caught up with it.

A read permission is still required: membership narrows the audience, it does
not grant it.

### Resolved once per event, not once per socket

Two things every socket in the loop would otherwise ask for itself are asked
once for the whole event:

```js
const members = new Set((await groupsRepo.readLinks(membership.name, { owner: groupId }))
  .map((link) => Number(link.target)));

const readers = new Map((await fastify.models.users.findByIds([...userIds]))
  .map((user) => [Number(user.id), user]));
```

Who is in the conversation is a fact about the **group**, not about the
listener, so it is the same answer for everyone receiving the event. And the
people behind the sockets are read in one go, so somebody with three tabs open
is looked up once rather than three times — each lookup hydrates their roles to
reach their permissions, so it was never cheap to repeat.

Both are still read **per event** rather than cached: permissions and membership
can change between one message and the next, and a stale copy would leak a
conversation.

### Read fresh, every event

```js
const user = readers.get(Number(entry.userId));
if (!user?.is_active || !inTheConversation(user, model, members)) continue;
```

Both `readers` and `members` are rebuilt for **every** event rather than cached.
A role change, or a group somebody was dropped from, therefore takes effect on
the next message rather than lingering for as long as the tab stays open. That
is the price of not leaking a conversation — and since the batching above, it is
two reads per event rather than two per socket.

### Messages: edits and deletions travel the same path

```js
if (!['created', 'updated', 'deleted'].includes(event.type)) return;
```

A correction should reach the people who read the mistake, and a message taken
back should stop being on their screen. What neither must do is make a
conversation unread again — which is why only `created` touches the counts, and
only for somebody who is not the author:

```js
send(entry.socket, { type: 'message', message: event.row });
if (event.type === 'created' && Number(event.row.owner) !== Number(user.id)) {
  await sendUnread(entry.socket, user.id);
}
```

A deletion also refreshes the count, because what was unread may have just
stopped existing.

---

## 5. Groups: two frames, because it is two pieces of news

`deliverGroup` is the subtlest part of the file.

```js
const now  = event.type === 'deleted' ? [] : memberIds(event.row);
const before = memberIds(event.previous || (event.type === 'deleted' ? event.row : null));
const lost = before.filter((id) => !now.includes(id));
```

| Audience | Frame | Why |
| :--- | :--- | :--- |
| in the group now | `group` — the whole row | it is theirs to read |
| in it a moment ago, not now | `group-gone` — **the id and nothing else** | they have just lost the right to read it, so the row must not travel with the news that it is gone |

**The audience cannot come from membership alone.** Somebody removed from a
group is, by then, not a member of anything, and asking the database who may see
the row would tell exactly the wrong person nothing. The `previous` row an update
carries is what makes them findable — which is why `routes/crud.js` sends the row
as it was alongside the new one:

```js
await fastify.realtime?.publish({ type: 'updated', model: model.name, row, previous });
```

Unread counts ride along on both frames: a group joined arrives with everything
already said in it, and a group left takes its pending messages off the total.

---

## 6. Presence

A connection is a **WebSocket, not a person**. One user with three tabs is three
connections and one entry under `users`.

```js
{ total, authenticated, people }
```

`people` is `new Set(connections.map(c => c.userId)).size` — distinct people, the
same figure `GET /api/presence` reports.

`total` and `authenticated` are now the same number, because **every connection
is somebody's**: a socket cannot be opened without a session. There used to be an
`anonymous` figure and a dashboard tile drawing it; both are gone, along with the
`presence.guests` string they used.

Presence changes travel *through the store* rather than being broadcast
directly, so a socket opening on another instance would still move the number
here once the store is shared.

Delivery is gated on the same unscoped `users:read` the HTTP route requires, and
read fresh per socket — a permission taken away stops the numbers arriving on a
tab that already had it open.

---

## 7. The client

### `src/lib/socket.js` — reconnection

```js
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 15000;
```

Exponential backoff, doubling to a 15-second ceiling and reset to 1 s on a
successful open. Back off, so a server that is down is not hammered by every
open tab — but never wait so long that a recovery goes unnoticed.

An `error` listener exists only to call `close()`: an error is always followed by
a close, which is where reconnection lives. This stops it reaching the console as
an unhandled event.

**`send()` drops frames while the socket is down rather than queueing them.**
Everything this app sends is a statement about *now* — what has been read — which
the next `hello` restates anyway.

### `src/context/RealtimeContext.jsx` — one socket for the app

It lives above the pages because two of them need it at once: the messenger
draws messages, and the header shows a dot whether or not the messenger is open.
A socket per component would mean several per tab and a presence count that
flattered itself.

```js
const identity = user?.id ?? null;
useEffect(() => { /* open */ }, [identity]);
```

Reopened whenever the identity changes: the handshake is what carries the
session, so a socket opened before signing in belongs to nobody.

Subscribers are held in a **ref**, not state, so adding one does not reopen the
socket and an event never arrives at a handler that has unmounted.

`send` is wrapped in `useCallback` with an empty dependency list so it is stable
— calls send a great many frames, and a changing identity would re-register
every subscriber.

### Unread is fetched *and* pushed

```js
useEffect(() => { api('/api/messenger/unread').then(…); }, [identity]);
```

The socket says hello with the same numbers, but a page that has just loaded
should not wait on a handshake to know it has something waiting.

`markRead` clears optimistically, then prefers the socket and falls back to HTTP:

```js
setUnread((prev) => /* subtract locally */);
if (socketRef.current?.send({ type: 'read', group: groupId })) return;
await api('/api/messenger/read', { method: 'POST', body: { group: groupId } });
```

The outline should go the moment the group is opened, not a round trip later —
and a reader on a flaky connection still stops being told about what they have
read.

---

## 8. A backing service failing is not fatal

Every socket listener is handed a **plain function with an explicit boundary**,
never an `async` one:

```js
socket.on('message', (raw) => {
  handleFrame(raw).catch((err) => {
    fastify.log.error({ err, connectionId }, 'A socket frame could not be handled');
    send(socket, { type: 'error', error: 'That could not be handled. Try again.' });
  });
});
```

A listener passed an `async` function is **a promise nobody is holding**. Throw
inside one and it is an unhandled rejection, which Node answers by killing the
process — so a database that blinked while one tab said `read` took down every
other socket in the installation, for a frame that could simply have been
refused:

```
Error: Connection terminated due to connection timeout
    at async Object.findByIds (server/db/pg-repository.js)
    at async WebSocket.<anonymous> (server/plugins/realtime.js)
```

What is thrown here is almost always somebody else's outage rather than a bug —
a pool timeout, a bucket, a peer that vanished mid-signal. The socket is told and
**stays open**, because the next frame will very likely work.

### The close listener is attached first

Before the handshake's own reads, and that ordering is the point of it being
where it is:

```js
sockets.set(connectionId, { socket, userId });
socket.on('close', …);          // ← before anything that can throw
send(socket, { type: 'hello', …await unreadFor(…) });
```

The hello frame carries unread counts, so a handshake reads the database and can
throw. Attached after that read, the listener would not exist yet when it did:
the connection would be recorded in the store, the socket would close with
nobody watching, and **presence would go on counting somebody who left**. Every
failed handshake leaked one more, permanently.

## 9. Teardown

```js
socket.on('close', () => {
  sockets.delete(connectionId);        // first, and outside the async work
  (async () => {
    await calls.disconnect(connectionId);
    await store.disconnect(connectionId);
    await store.publish({ model: 'presence', type: 'disconnected' });
  })().catch((err) => fastify.log.error({ err, connectionId }, 'Socket teardown failed'));
});
```

Deleted from the local map **first**, so the frames the departure generates are
not sent to the socket that has just gone — and so it is forgotten even if the
rest fails.

The boundary matters more here than anywhere: this runs while a socket is
already going away, so there is nobody left to tell and nothing to retry. Losing
the server over it would lose every other socket with it. See §8.

`calls.disconnect` is `leave()` under another name — a dropped socket is
indistinguishable from hanging up, by design.

On server shutdown, `onClose` clears the call timers and closes every socket.

---

## 10. What is not here

**No horizontal scaling yet.** The store is per-process, so two instances would
each know only their own sockets: presence would undercount, and a message
published on one would never reach a socket held by the other. The interface is
already shaped for Redis; nothing above `store.js` changes.

**No queueing.** Frames posted while the socket is down are dropped. Messages
missed during a disconnect are recovered by the messenger refetching, and unread
counts by the next `hello`.

**No per-frame rate limit except on `call:signal`** — see
[Throttling](throttling.md). `/ws` is deliberately outside the API flood guard.

Related: [Calls](calls.md) · [Messages](messages.md) ·
[Users, roles and permissions](permissions.md)
