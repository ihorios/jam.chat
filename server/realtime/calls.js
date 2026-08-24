/**
 * Calls within a group: who is in one, whose phone is ringing, and getting one
 * browser's offer to another.
 *
 * No media passes through here, and none ever will — the browsers talk to each
 * other directly over WebRTC. This file carries only the paperwork that lets
 * them find each other, which it treats as an opaque blob: an SDP offer and an
 * ICE candidate are both just `payload`, so nothing here has to change when
 * WebRTC does.
 *
 * Kept out of the socket plugin because the two answer different questions.
 * The plugin owns sockets and how a frame reaches one; this owns what a call
 * is. Everything it sends leaves through the `deliver` it was built with, so
 * the whole of it can be read — and tested — without a WebSocket in sight.
 *
 * A participant is a *connection*, not a person. Media belongs to one tab, and
 * somebody with three of them open should not be in the same call three times.
 *
 * The frames, in the order a call uses them:
 *
 *   in   call:start  {group}                 ring the group
 *   out  call:ringing {group, from, startedAt}   ...arrives at everyone else
 *   in   call:join   {group}                 answer
 *   out  call:state  {group, self, peers}    what the answerer has joined
 *   out  call:peer-joined {group, peer}      ...to everyone already in
 *   in   call:signal {group, to, payload}    an offer, answer, or candidate
 *   out  call:signal {group, from, payload}  ...relayed to that one peer
 *   in   call:leave  {group}                 hang up, or decline
 *   out  call:peer-left {group, peer}        ...to everyone still in
 *   out  call:ended  {group, reason}         this call is over for you
 *
 * Who offers to whom is settled by a rule rather than a frame: the peer that
 * joins offers to everyone already there, and incumbents only ever answer.
 * That is what stops two browsers offering each other at once (glare), and it
 * costs the server nothing to state.
 */

/** Anything larger is not signalling, whatever it says it is. */
const MAX_SIGNAL_CHARS = 64 * 1024;

/**
 * Who is in which call.
 *
 * Shaped like the presence store next door, and for the same reason: async
 * methods, connections addressed by opaque string, and no live object handed
 * to a caller. A Redis implementation is a hash per room (`call:<group>`) plus
 * a `call:at:<connectionId>` pointer, and nothing above this line changes.
 */
export function createCallRegistry() {
  /** group -> { group, startedBy, startedAt, participants, ringing } */
  const rooms = new Map();
  /**
   * connectionId -> group: the call a connection is in, ringing or joined.
   * An index, so a socket that drops is found without scanning every room, and
   * the answer to "is this tab busy?" is one lookup.
   */
  const whereabouts = new Map();

  const snapshot = (room) => ({
    group: room.group,
    startedBy: room.startedBy,
    startedAt: room.startedAt,
    participants: [...room.participants.entries()].map(([connectionId, participant]) => ({
      connectionId,
      ...participant,
    })),
    ringing: [...room.ringing],
  });

  return {
    async get(group) {
      const room = rooms.get(group);
      return room ? snapshot(room) : null;
    },

    /** The call this connection is in, ringing or joined, or null. */
    async groupOf(connectionId) {
      return whereabouts.get(connectionId) ?? null;
    },

    /**
     * Opens a call and rings `candidates`. A candidate already in a call is
     * left alone — one thing at a time is not the whole answer to call waiting,
     * but it is an honest one, and better than a popup over a conversation in
     * progress.
     */
    async start(group, { connectionId, userId }, candidates = []) {
      const at = new Date().toISOString();
      const room = {
        group,
        startedBy: Number(userId),
        startedAt: at,
        participants: new Map([[connectionId, { userId: Number(userId), joinedAt: at }]]),
        ringing: new Set(candidates.filter((id) => !whereabouts.has(id))),
      };

      rooms.set(group, room);
      whereabouts.set(connectionId, group);
      for (const id of room.ringing) whereabouts.set(id, group);

      return snapshot(room);
    },

    /** Answers. Null when the call ended while the popup was still up. */
    async join(group, { connectionId, userId }) {
      const room = rooms.get(group);
      if (!room) return null;

      room.ringing.delete(connectionId);
      if (!room.participants.has(connectionId)) {
        room.participants.set(connectionId, {
          userId: Number(userId),
          joinedAt: new Date().toISOString(),
        });
      }
      whereabouts.set(connectionId, group);

      return snapshot(room);
    },

    /**
     * Closes a call outright — what a ring that nobody answered comes to.
     *
     * `onlyWhenAlone` refuses to end a call somebody has joined, so a timeout
     * firing at the same moment as an answer loses to the answer.
     */
    async end(group, { onlyWhenAlone = false } = {}) {
      const room = rooms.get(group);
      if (!room) return null;
      if (onlyWhenAlone && room.participants.size > 1) return null;

      rooms.delete(group);
      for (const connectionId of room.participants.keys()) whereabouts.delete(connectionId);
      for (const connectionId of room.ringing) whereabouts.delete(connectionId);

      return snapshot(room);
    },

    /**
     * Hangs up, declines, or drops off. Returns what became of the call, or
     * null when this connection was not in one — leaving twice is not an error,
     * because a hangup racing a closing socket is ordinary.
     *
     * The snapshot describes the call *after* the departure, so its
     * participants are exactly the people still to be told.
     */
    async leave(connectionId) {
      const group = whereabouts.get(connectionId);
      if (group === undefined) return null;
      whereabouts.delete(connectionId);

      const room = rooms.get(group);
      if (!room) return null;

      // Read before removing: who left is what the others have to be told.
      const departing = room.participants.get(connectionId) || null;
      const wasParticipant = room.participants.delete(connectionId);
      room.ringing.delete(connectionId);

      // Everyone has left, so there is nothing to come back to — including for
      // anyone still being rung.
      const ended = room.participants.size === 0;
      if (ended) {
        rooms.delete(group);
        for (const id of room.ringing) whereabouts.delete(id);
      }

      return {
        group,
        wasParticipant,
        ended,
        userId: departing?.userId ?? null,
        call: snapshot(room),
      };
    },
  };
}

/**
 * The half of a call the server performs: validating a frame, deciding who
 * hears about it, and handing it to `deliver`.
 *
 * Built with what it cannot see for itself —
 *   models       to ask who belongs to a group and what people are called
 *   connections  the presence store's list, for finding whom to ring
 *   deliver      (connectionIds, frame) => void, the plugin's fan-out
 *   ringSeconds  how long an unanswered call rings before giving up
 *   allow        (connectionId) => boolean, flood control for signalling
 */
export function createCallHub({
  models,
  connections,
  deliver,
  ringSeconds = 40,
  allow = null,
  log = null,
}) {
  const registry = createCallRegistry();

  /**
   * group -> the timer that gives up on it.
   *
   * Held here rather than in the registry because a timer is the one thing
   * about a call that cannot be written to a key-value store. With several
   * instances it therefore belongs to whichever one the call was started on,
   * which is the right one: it is that instance's caller who is waiting.
   */
  const timers = new Map();

  const refuse = (connectionId, error) => deliver([connectionId], { type: 'error', error });

  const groupId = (value) => {
    const id = Number.parseInt(value, 10);
    return Number.isNaN(id) ? null : id;
  };

  /**
   * A group the caller may be in a call in, or null.
   *
   * Membership of the group is the whole test, and deliberately the same one
   * the messenger applies: if you may be told what is said in a group, you may
   * be in its call. An administrator who can read every group is not thereby a
   * member of any, and does not get rung.
   */
  const callableGroup = async (value, userId) => {
    const id = groupId(value);
    if (id === null) return null;
    return (await models.user_groups.isMemberOf(id, userId)) ? id : null;
  };

  /** Participants with names attached, for a client that has to draw them. */
  const named = async (participants) => {
    const ids = [...new Set(participants.map((participant) => participant.userId))];
    const users = await models.users.findByIds(ids);
    const names = new Map(users.map((user) => [Number(user.id), user.name]));

    return participants.map((participant) => ({
      connectionId: participant.connectionId,
      userId: participant.userId,
      name: names.get(Number(participant.userId)) ?? null,
    }));
  };

  const others = (call, connectionId) =>
    call.participants.filter((participant) => participant.connectionId !== connectionId);

  const stateFrame = async (call, connectionId) => ({
    type: 'call:state',
    group: call.group,
    self: connectionId,
    startedBy: call.startedBy,
    startedAt: call.startedAt,
    peers: await named(others(call, connectionId)),
  });

  /**
   * Every other connection belonging to a member of the group — the sockets to
   * ring. Membership is asked once per person rather than once per tab, and the
   * caller's own connection is left out (their other tabs are not: a call
   * should be answerable on whichever one they are looking at).
   */
  const ringable = async (group, startedFrom) => {
    const live = (await connections()).filter(
      (connection) => connection.userId !== null && connection.connectionId !== startedFrom
    );

    const members = new Set();
    for (const userId of new Set(live.map((connection) => connection.userId))) {
      if (await models.user_groups.isMemberOf(group, userId)) members.add(userId);
    }

    return live
      .filter((connection) => members.has(connection.userId))
      .map((connection) => connection.connectionId);
  };

  /** Tells a connection its call is over, which is what closes its popup. */
  const endFor = (connectionIds, group, reason) =>
    deliver(connectionIds, { type: 'call:ended', group, reason });

  const disarm = (group) => {
    const timer = timers.get(group);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(group);
  };

  /**
   * Gives up on a call nobody answered.
   *
   * The caller is told why — they have been listening to it ring — while the
   * unanswered ends are told only that it is over, which is all a popup for a
   * call they missed needs to know.
   */
  const expire = async (group) => {
    timers.delete(group);

    const call = await registry.end(group, { onlyWhenAlone: true });
    if (!call) return;

    await endFor(call.participants.map((participant) => participant.connectionId), group, 'unanswered');
    await endFor(call.ringing, group, 'ended');
  };

  const arm = (group) => {
    disarm(group);
    const timer = setTimeout(() => {
      expire(group).catch((err) => log?.warn({ err }, 'Ringing timeout failed'));
    }, ringSeconds * 1000);

    // Ringing must never be the reason a process stays alive.
    timer.unref?.();
    timers.set(group, timer);
  };

  async function start(payload, { connectionId, user }) {
    const group = await callableGroup(payload.group, user.id);
    if (group === null) return refuse(connectionId, 'User Group not found');

    const busy = await registry.groupOf(connectionId);
    if (busy !== null && busy !== group) {
      return refuse(connectionId, 'This tab is already in a call');
    }

    // Pressing Call on a group that is already ringing joins it rather than
    // starting a second one: one conversation per group is the whole point.
    if (await registry.get(group)) return join(payload, { connectionId, user });

    const call = await registry.start(
      group,
      { connectionId, userId: user.id },
      await ringable(group, connectionId)
    );

    // Armed whether or not anybody was there to ring: a caller left listening
    // to silence should be released either way.
    arm(group);

    await deliver([connectionId], await stateFrame(call, connectionId));

    if (call.ringing.length > 0) {
      const [from] = await named([{ connectionId, userId: user.id }]);
      await deliver(call.ringing, {
        type: 'call:ringing',
        group,
        from,
        startedAt: call.startedAt,
      });
    }
  }

  async function join(payload, { connectionId, user }) {
    const group = await callableGroup(payload.group, user.id);
    if (group === null) return refuse(connectionId, 'User Group not found');

    const busy = await registry.groupOf(connectionId);
    if (busy !== null && busy !== group) {
      return refuse(connectionId, 'This tab is already in a call');
    }

    const call = await registry.join(group, { connectionId, userId: user.id });
    // Answered a call that hung up first: close the popup rather than explain.
    if (!call) return endFor([connectionId], group, 'ended');

    // Somebody answered, so there is nothing left to give up on.
    if (call.participants.length > 1) disarm(group);

    await deliver([connectionId], await stateFrame(call, connectionId));

    const peers = others(call, connectionId);
    if (peers.length > 0) {
      const [peer] = await named([{ connectionId, userId: user.id }]);
      await deliver(
        peers.map((participant) => participant.connectionId),
        { type: 'call:peer-joined', group, peer }
      );
    }
  }

  /**
   * Hanging up, and declining, which are the same thing to everyone else: the
   * connection stops being part of the call and is told the call is over *for
   * it*. Anybody still talking carries on — a call ends when the last of them
   * leaves, not when the first does.
   *
   * The frame's group is not read: a tab is in at most one call, so there is
   * only one thing it can be hanging up from.
   */
  async function leave(_payload, { connectionId }) {
    const result = await registry.leave(connectionId);
    if (!result) return;

    const { group, call, wasParticipant, ended } = result;

    await endFor([connectionId], group, wasParticipant ? 'left' : 'declined');

    if (wasParticipant && call.participants.length > 0) {
      const [peer] = await named([{ connectionId, userId: result.userId }]);
      await deliver(
        call.participants.map((participant) => participant.connectionId),
        { type: 'call:peer-left', group, peer }
      );
    }

    if (ended) {
      disarm(group);
      // Nobody left to answer to: close the popups still ringing for it.
      if (call.ringing.length > 0) await endFor(call.ringing, group, 'ended');
    }
  }

  /**
   * Relays one peer's blob to another, and nothing else.
   *
   * Both ends are checked against the same call, every time. Without that this
   * is not a signalling channel but an authenticated way to send arbitrary data
   * to any socket in the system — the one check the whole feature rests on.
   */
  async function signal(payload, { connectionId }) {
    // Counted per socket, before anything is looked up. Offers and candidates
    // arrive in bursts, so the allowance is generous — but a peer that can
    // relay without limit can flood the one it is talking to, and this is the
    // only frame a client can send as fast as it likes.
    if (allow && !(await allow(connectionId))) {
      return refuse(connectionId, 'Too many signalling messages');
    }

    const group = groupId(payload.group);
    const call = group === null ? null : await registry.get(group);

    const isParticipant = (id) =>
      Boolean(call?.participants.some((participant) => participant.connectionId === id));

    if (!isParticipant(connectionId)) return refuse(connectionId, 'You are not in that call');
    if (!payload.to || !isParticipant(payload.to)) {
      return refuse(connectionId, 'That peer is not in the call');
    }

    const body = JSON.stringify(payload.payload ?? null);
    if (body.length > MAX_SIGNAL_CHARS) {
      return refuse(connectionId, 'Signal payload is too large');
    }

    await deliver([payload.to], {
      type: 'call:signal',
      group,
      from: connectionId,
      payload: payload.payload,
    });
  }

  // Null-prototyped, because the key comes off the wire: a frame calling itself
  // "constructor" would otherwise find a function here that nobody put in.
  const HANDLERS = Object.assign(Object.create(null), {
    'call:start': start,
    'call:join': join,
    'call:leave': leave,
    'call:signal': signal,
  });

  return {
    /** True when the frame was a call frame, whatever became of it. */
    async handle(payload, context) {
      const handler = HANDLERS[payload.type];
      if (!handler) return false;

      try {
        await handler(payload, context);
      } catch (err) {
        log?.warn({ err }, 'Call frame failed');
        await refuse(context.connectionId, 'That call could not be completed');
      }
      return true;
    },

    /** A socket has gone. Indistinguishable from hanging up, by design. */
    async disconnect(connectionId) {
      await leave({}, { connectionId });
    },

    /** The server is shutting down; nothing is waiting for anything. */
    close() {
      for (const [, timer] of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
