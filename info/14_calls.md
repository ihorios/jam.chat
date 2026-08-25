# Calls

Voice calls within a group, over WebRTC, signalled on the same socket the
messages use.

**No media passes through the server, and none ever will.** The browsers talk to
each other directly. The server carries only the paperwork that lets them find
each other, which it treats as an opaque blob — an SDP offer and an ICE candidate
are both just `payload`, so nothing on the server has to change when WebRTC does.

---

## 1. The division of labour

The same split on both sides, and it is worth naming because it is what keeps
either half readable:

| | Knows what a **call** is | Knows what an **offer** is |
| :--- | :--- | :--- |
| server | `server/realtime/calls.js` | — |
| client | `src/context/CallContext.jsx` | `src/lib/webrtc.js` |

`realtime/calls.js` is kept out of the socket plugin because the two answer
different questions: the plugin owns sockets and how a frame reaches one; the hub
owns what a call is. Everything it sends leaves through the `deliver` function it
was built with, so **the whole of it can be read and tested without a WebSocket
in sight**.

---

## 2. A participant is a connection, not a person

This is the single most important fact about the design.

Media belongs to one tab, and somebody with three of them open should not be in
the same call three times. So the registry is keyed by `connectionId`, and one
person's three tabs are three potential participants — only one of which will
actually answer.

Ringing follows from the same rule: **every open tab of every group member rings,
except the caller's own connection.** Their other tabs do ring — a call should be
answerable on whichever one they are looking at.

---

## 3. The frames

In the order a call uses them:

| Direction | Frame | Payload |
| :--- | :--- | :--- |
| in | `call:start` | `{ group }` |
| out | `call:ringing` | `{ group, from, startedAt }` |
| in | `call:join` | `{ group }` |
| out | `call:state` | `{ group, self, startedBy, startedAt, peers }` |
| out | `call:peer-joined` | `{ group, peer }` |
| in | `call:signal` | `{ group, to, payload }` |
| out | `call:signal` | `{ group, from, payload }` |
| in | `call:leave` | `{ group }` |
| out | `call:peer-left` | `{ group, peer }` |
| out | `call:ended` | `{ group, reason }` |

`reason` is one of `unanswered`, `ended`, `left` or `declined`.

Handlers are dispatched from a **null-prototype** object:

```js
const HANDLERS = Object.assign(Object.create(null), { 'call:start': start, … });
```

The key comes off the wire, so a frame calling itself `"constructor"` would
otherwise find a function nobody put there.

---

## 4. Who offers to whom

Settled by a **rule rather than a frame**:

> The peer that joins offers to everyone already there, and incumbents only ever
> answer.

That is what stops two browsers offering each other at once — *glare* — and it
costs the server nothing to state. It is why there is no perfect-negotiation
dance in `webrtc.js`.

The client acts on it in `call:state`, which is the frame that says "you are in":

```js
const mesh = ensureMesh(event.group);
for (const peer of event.peers) mesh.offerTo(peer.connectionId);
```

And on `call:peer-joined` it does nothing at all — *they will offer to us; there
is nothing to do but expect them.*

---

## 5. The registry

`createCallRegistry()` — shaped like the presence store next door, and for the
same reason: async methods, connections addressed by opaque string, no live
object handed to a caller. A Redis implementation is a hash per room
(`call:<group>`) plus a `call:at:<connectionId>` pointer, and nothing above that
line changes.

```js
const rooms = new Map();        // group -> { group, startedBy, startedAt, participants, ringing }
const whereabouts = new Map();  // connectionId -> group
```

`whereabouts` is an index, so a socket that drops is found without scanning every
room, and *"is this tab busy?"* is one lookup.

| Method | Notes |
| :--- | :--- |
| `start(group, who, candidates)` | a candidate **already in a call is left alone** |
| `join(group, who)` | `null` when the call ended while the popup was still up |
| `end(group, { onlyWhenAlone })` | see §7 |
| `leave(connectionId)` | returns the call *after* the departure |

`leave` returning the post-departure snapshot is deliberate: its participants are
exactly the people still to be told.

Leaving twice is not an error — a hangup racing a closing socket is ordinary, so
`leave` on an unknown connection returns `null` quietly.

### One call at a time

```js
ringing: new Set(candidates.filter((id) => !whereabouts.has(id)))
```

Somebody already in a call is not rung. *One thing at a time is not the whole
answer to call waiting, but it is an honest one, and better than a popup over a
conversation in progress.*

Pressing Call on a group that is already ringing **joins it** rather than
starting a second one — one conversation per group is the whole point:

```js
if (await registry.get(group)) return join(payload, { connectionId, user });
```

---

## 6. Authorisation

```js
const callableGroup = async (value, userId) => {
  const id = groupId(value);
  if (id === null) return null;
  return (await models.user_groups.isMemberOf(id, userId)) ? id : null;
};
```

**Membership of the group is the whole test**, and deliberately the same one the
messenger applies: if you may be told what is said in a group, you may be in its
call. An administrator who can read every group is not thereby a member of any,
and does not get rung.

There is no `calls:*` permission. A refusal reads *"User Group not found"* — the
same answer a read would give.

### The one check the feature rests on

```js
if (!isParticipant(connectionId)) return refuse(connectionId, 'You are not in that call');
if (!payload.to || !isParticipant(payload.to)) return refuse(connectionId, 'That peer is not in the call');
```

Both ends are checked against the same call, every time.

> Without that this is not a signalling channel but an authenticated way to send
> arbitrary data to any socket in the system.

Payloads are capped at `MAX_SIGNAL_CHARS = 64 * 1024` — *anything larger is not
signalling, whatever it says it is.*

---

## 7. Ringing, and giving up

```js
const arm = (group) => {
  disarm(group);
  const timer = setTimeout(() => expire(group).catch(…), ringSeconds * 1000);
  timer.unref?.();          // ringing must never be why a process stays alive
  timers.set(group, timer);
};
```

`CALL_RING_SECONDS` defaults to 40.

Timers are held in the hub rather than the registry, because **a timer is the one
thing about a call that cannot be written to a key-value store**. With several
instances it belongs to whichever one the call was started on — which is the
right one: it is that instance's caller who is waiting.

The timer is armed **whether or not anybody was there to ring**: a caller left
listening to silence should be released either way.

```js
const call = await registry.end(group, { onlyWhenAlone: true });
if (!call) return;
```

`onlyWhenAlone` refuses to end a call somebody has joined, **so a timeout firing
at the same moment as an answer loses to the answer.**

On expiry the caller is told `unanswered` — they have been listening to it ring
and deserve to know it stopped for a reason — while the unanswered ends are told
only `ended`, which is all a popup for a call they missed needs to know.

---

## 8. Hanging up

Hanging up and declining are **the same thing to everyone else**: the connection
stops being part of the call and is told the call is over *for it*.

```js
await endFor([connectionId], group, wasParticipant ? 'left' : 'declined');
```

Anybody still talking carries on. **A call ends when the last of them leaves, not
when the first does.**

The frame's `group` is not read: a tab is in at most one call, so there is only
one thing it can be hanging up from.

A dropped socket is indistinguishable from hanging up, by design:

```js
async disconnect(connectionId) { await leave({}, { connectionId }); }
```

---

## 9. ICE and TURN

`server/realtime/ice.js`.

> Two thirds of calls connect on STUN alone: it does nothing but tell a browser
> what its address looks like from outside. The rest — symmetric NAT, strict
> corporate firewalls — have no direct path at all, and their audio has to be
> relayed by a TURN server that both ends can reach.

A relay costs bandwidth, which is why TURN credentials are worth stealing and why
they are minted **per request** rather than configured into the client.

### The shared-secret scheme (preferred)

```js
const expiry = Math.floor(now / 1000) + config.turnTtlSeconds;
const username = `${expiry}:${userId}`;
credential: createHmac('sha1', config.turnSecret).update(username).digest('base64')
```

This is coturn's `use-auth-secret` — the TURN REST API most managed providers
implement. The TURN server verifies it with the same secret and refuses it after
the expiry, so **a credential scraped out of a browser is worth an hour of
somebody else's bandwidth rather than all of it.**

`TURN_SECRET` never leaves the process. `ice.js` is the only file that reads it.

### The fixed-pair fallback

For a provider that issues one. It works, but *every browser that has ever called
holds a credential that never expires* — an open relay with a delay.

### The route

```js
fastify.get('/calls/ice', { preHandler: fastify.authenticate }, async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return { ok: true, ...iceServersFor(config, request.user.id) };
});
```

A session and nothing more: anybody who may be in a group may call it, and the
frames themselves are guarded on the socket. What it must not be is **public** —
the credentials it hands out buy relay bandwidth.

`no-store`, because the credentials are minted for this user and this hour.

It carries its **own** rate-limit policy, counted per session, and is skipped by
the address-wide `/api` guard. Counted there it shared an allowance with every
other request from the same office router, and spending it meant this endpoint
answering `429` — which the browser answers by falling back to STUN with no
relay. See [Throttling](throttling.md#one-exemption-and-why-it-is-not-a-hole).

`loadIceServers` still never throws — a call on STUN alone is far better than no
call — but it now logs, and returns `degraded: true`. If a peer connection then
fails, the client can say *why*: no relay was available, rather than a generic
failure that points nowhere.

`now` is injectable so the expiry can be asserted in tests rather than guessed.

STUN defaults to Google's public servers.

---

## 10. The browser half

### `lib/webrtc.js` — one `RTCPeerConnection` per peer

```js
const peers = new Map();   // peerId -> { pc, pending }
```

`pending` holds candidates that arrived **before there was a remote description
to attach them to**. Signalling is faster than negotiation, so this happens
often, and out-of-order is normal rather than an error:

```js
if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
else entry.pending.push(payload.candidate);
```

`flush()` drains them as soon as `setRemoteDescription` lands.

If calls ever move to an SFU, this is the file that changes and nothing else.

There is a built-in STUN fallback so a browser that cannot reach `/api/calls/ice`
still gets as far as STUN can take it. `loadIceServers` **never throws** — a call
on STUN alone is far better than no call.

### `CallContext` — one call at a time, for the whole tab

It sits above the routes because a call is not a page: the popup has to arrive
wherever the person is looking, and the conversation has to survive them
navigating away from the messenger.

**`teardown()` releases the microphone**, deliberately safe to run twice, because
hanging up and being told the call ended often arrive together:

```js
for (const track of localStreamRef.current?.getTracks() || []) track.stop();
```

> A browser that keeps the recording light on after a call is a browser nobody
> trusts.

It also runs on unmount, so a tab closed mid-call still lets go.

**Both prerequisites are acquired before ringing anybody:**

```js
await Promise.all([ensureMedia(), ensureIce()]);
```

No point waking a room for a call that cannot carry sound. Only the microphone
can refuse — asking for ICE servers falls back rather than fails.

**ICE servers are cached until a minute before expiry**, so a call placed on the
hour does not run out mid-ring.

**A socket that drops ends the call locally:**

```js
if (socketStatus !== 'online' && groupRef.current !== null) {
  setError(i18n.t('call.error.dropped'));
  teardown();
}
```

The server treats a dropped connection as a hangup and the other side has already
been told, so showing a call that no longer exists would be a lie.

**Errors are interpreted by phase:**

```js
if (groupRef.current !== null && peersRef.current.length === 0) { setError(…); teardown(); }
```

While a call is being placed, its frames are the only ones the tab has sent, so a
refusal now belongs to it — better said out loud than left ringing forever. Once
somebody has answered it is a different matter: a refused signal is usually a race
with a peer leaving, and not a reason to end a conversation.

**One word for the whole state:**

```js
if (!call) return 'idle';
if (peers.length === 0) return 'ringing';
return peers.some((p) => p.state === 'connected') ? 'talking' : 'connecting';
```

Handlers are registered **once** and work from the frame and functional updates,
never from a value captured when they were written — which is why `groupRef` and
`peersRef` exist alongside the state.

---

## 11. Flood control

```js
allow: async (connectionId) => {
  const { allowed } = await fastify.limiter.hit(`signal:${connectionId}`, config.rateLimits.signal);
  return allowed;
}
```

One policy, **per socket rather than per session** — one tab flooding must not
silence the same person's other calls.

| Frame | Policy | Why |
| :--- | :--- | :--- |
| `call:signal` | 600 / 60 s | the only frame a client sends as fast as it likes; a peer that can relay without limit can flood the one it is talking to |
| `call:start`, `call:join`, `call:leave` | **none** | things a person presses, not things a client streams |

Placing and answering are deliberately uncounted. `call:start` is the loudest
frame in the system — it rings every open tab of every member and costs a
membership lookup per connected person to work out who they are — so a loop of
leave-then-start is an unbounded way to ring a room. That is a known cost, not
an oversight: a refusal on the button somebody just pressed is worse than the
noise, and hanging up must never be refused at all.

### A refusal says what it refused

```json
{ "type": "error", "error": "…", "about": "call:signal", "to": "<peer>", "kind": "offer" }
```

`kind` is **the client's own word for its own payload**, echoed back and never
read here — the server goes on treating an SDP and a candidate as the same
opaque blob. It exists because the two are not equally survivable: ICE offers
several candidates and needs one, so a dropped candidate usually costs nothing,
while a dropped offer or answer leaves that peer connection with nothing to
negotiate from. Treating both as noise is what made a rate-limited offer look
like a call that hung on "connecting" for ever.

The client drops that one peer and says so; a refused candidate is ignored.

---

## 12. What is not implemented

- **Audio only.** No video anywhere.
- **Mesh, not SFU.** Every participant holds a connection to every other, so
  bandwidth grows with the square of the group. Fine for a handful of people.
- **No call history.** A call leaves no row — nothing in the database records
  that one happened.
- **No call waiting.** Somebody already in a call is not rung.
- **No screen sharing, recording, or hold.**
- **Single-instance.** The registry and the timers are per-process, like the
  realtime store.

Related: [WebSockets](websocket.md) · [User groups](user-groups.md) ·
[Throttling](throttling.md)
