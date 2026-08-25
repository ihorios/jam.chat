import { randomUUID } from 'node:crypto';

import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';

import { config } from '../config/env.js';
import { createRealtimeStore } from '../realtime/store.js';
import { createCallHub } from '../realtime/calls.js';
import { unreadFor, markRead } from '../realtime/unread.js';
import { grantedScope } from './auth.js';

/**
 * The live half of the application: one WebSocket per open tab, whoever it
 * belongs to.
 *
 * Anonymous sockets are welcome — a browser sitting on the login page is
 * connected, and the presence figures say so. Signing in identifies the socket
 * in place rather than replacing it.
 *
 * Delivery is decided by the same permissions as a request, with one deliberate
 * exception: a message follows *membership* rather than the read permission,
 * because the socket serves the messenger and the messenger is somebody's own
 * conversations (see inTheConversation). Everything else reaches a socket only
 * if its user could have fetched the row over HTTP. The
 * fan-out reads the user fresh each time, so a role change or a group they
 * were dropped from takes effect on the next message rather than lingering for
 * as long as the tab stays open.
 */
async function realtimePlugin(fastify) {
  await fastify.register(websocket);

  const store = createRealtimeStore();
  fastify.decorate('realtime', store);

  /** connectionId -> { socket, userId } for the sockets this instance holds. */
  const sockets = new Map();

  const send = (socket, payload) => {
    // 1 === OPEN. A socket can close between choosing to send and sending.
    if (socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (err) {
      fastify.log.debug({ err }, 'Dropped a realtime frame');
    }
  };

  const sendUnread = async (socket, userId) => {
    send(socket, { type: 'unread', ...(await unreadFor(fastify.models, userId)) });
  };

  /**
   * Sends one frame to named connections, wherever they are held.
   *
   * It goes out through the store rather than straight to the socket so that a
   * peer on another instance is reachable: every instance receives the event
   * and delivers to whichever of the addressees it happens to hold. The rest
   * are somebody else's sockets, and quietly nobody's business.
   */
  const deliver = async (connectionIds, frame) => {
    const to = [...new Set(connectionIds)].filter(Boolean);
    if (to.length === 0) return;
    await store.publish({ model: 'calls', type: 'deliver', to, frame });
  };

  /** Calls live in their own module; this plugin only lends them delivery. */
  const calls = createCallHub({
    models: fastify.models,
    connections: () => store.connections(),
    deliver,
    ringSeconds: config.callRingSeconds,
    // Per socket rather than per session: one tab flooding must not silence
    // the same person's other calls.
    allow: async (connectionId) => {
      if (!config.rateLimitEnabled) return true;
      const { allowed } = await fastify.limiter.hit(
        `signal:${connectionId}`,
        config.rateLimits.signal
      );
      return allowed;
    },
    log: fastify.log,
  });

  /** The figures /api/presence reports, counted over every instance's sockets. */
  const presenceCounts = async () => {
    const connections = await store.connections();
    const signedIn = connections.filter((c) => c.userId !== null);

    return {
      total: connections.length,
      authenticated: signedIn.length,
      anonymous: connections.length - signedIn.length,
      // Distinct people, not sockets: three tabs are one user online.
      people: new Set(signedIn.map((c) => c.userId)).size,
    };
  };

  /**
   * Tells the sockets watching presence that it has changed.
   *
   * Gated on the same unscoped users:read the HTTP route requires, and read
   * fresh per socket for the same reason the message fan-out is: a permission
   * taken away should stop the numbers arriving on the tab that already had it
   * open.
   */
  const broadcastPresence = async () => {
    const watchers = [...sockets.values()].filter((entry) => entry.userId !== null);
    if (watchers.length === 0) return;

    const counts = await presenceCounts();

    for (const entry of watchers) {
      try {
        const user = await fastify.models.users.findById(entry.userId);
        if (!user?.is_active || !user.permissions.includes('users:read')) continue;
        send(entry.socket, { type: 'presence', ...counts });
      } catch (err) {
        fastify.log.warn({ err }, 'Presence delivery failed');
      }
    }
  };

  /**
   * Would this user be allowed to read this row over HTTP?
   *
   * Membership is answered through the row the model defers to — a message
   * belongs to whoever belongs to its group — rather than by asking the model
   * about its own id. That matters for a deletion: by the time this runs the
   * row is gone, so looking it up again would say "no" to everybody who should
   * have been told.
   */
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

  /**
   * Whether to tell this user that something was said.
   *
   * Membership, and deliberately narrower than `maySee` — this is the one place
   * the socket answers a different question from the route, so it is worth
   * saying why. `user_messages:read` unscoped is an administrator's permission
   * and the dashboard is what it is for; the dashboard fetches, and subscribes
   * to nothing. The socket exists for the messenger, and the messenger is
   * somebody's own conversations: /chats is not a moderation tool, and an
   * administrator opening it should find the groups they are in rather than
   * every conversation in the installation.
   *
   * Which is the rule the unread count has always used — see unreadFor, and its
   * note that an administrator reading every group is not thereby behind on
   * every conversation. Delivery simply never caught up with it, so an
   * administrator's chats page filled with strangers the moment anybody spoke.
   *
   * A read permission is still required: membership is what narrows the
   * audience, not what grants it.
   */
  const inTheConversation = async (user, model, row) => {
    if (!grantedScope(model, 'read', user.permissions)) return false;

    const via = model.membershipVia;
    // A model that cannot say who belongs to it falls back to the route's rule.
    if (!via) return maySee(user, model, row);

    return fastify.models[via.target].isMemberOf(row[via.name], user.id);
  };

  /** The user ids in a hydrated group row's members, as numbers. */
  const memberIds = (group) => (group?.members || []).map((member) => Number(member.id));

  /**
   * Tells people that a group of theirs has appeared, changed, or stopped
   * being theirs.
   *
   * Two frames, because a membership change is two different pieces of news
   * depending on which side of it you are on. Whoever is in the group now gets
   * the group; whoever was in it a moment ago and is not any more gets its id
   * and nothing else — they have just lost the right to read it, so the row
   * itself must not travel with the news that it is gone.
   *
   * Which is also why the audience cannot come from membership alone: somebody
   * removed from a group is, by then, not a member of anything, and asking the
   * database who may see the row would tell exactly the wrong person nothing.
   * The `previous` row an update carries is what makes them findable.
   *
   * Unread counts ride along, because both frames move them: a group joined
   * arrives with everything already said in it, and a group left takes its
   * pending messages off the caller's total.
   */
  const deliverGroup = async (event) => {
    const now = event.type === 'deleted' ? [] : memberIds(event.row);
    // A deletion takes it away from everybody who was in it.
    const before = memberIds(event.previous || (event.type === 'deleted' ? event.row : null));
    const lost = before.filter((id) => !now.includes(id));

    const model = fastify.models.user_groups.model;

    for (const [, entry] of sockets) {
      if (entry.userId === null) continue;
      const joined = now.includes(Number(entry.userId));
      if (!joined && !lost.includes(Number(entry.userId))) continue;

      try {
        // Read fresh, as the message fan-out does: a permission taken away
        // must stop the frames arriving on a tab that already had it open.
        const user = await fastify.models.users.findById(entry.userId);
        if (!user?.is_active) continue;

        if (joined) {
          if (!(await maySee(user, model, event.row))) continue;
          send(entry.socket, { type: 'group', group: event.row });
        } else {
          if (!grantedScope(model, 'read', user.permissions)) continue;
          send(entry.socket, { type: 'group-gone', id: event.row.id });
        }

        await sendUnread(entry.socket, user.id);
      } catch (err) {
        fastify.log.warn({ err }, 'Group delivery failed');
      }
    }
  };

  /**
   * Fans a published event out to the sockets on this instance. With a KV
   * backend behind the store this handler also runs on every other instance,
   * each delivering to the sockets it holds.
   */
  store.subscribe(async (event) => {
    // Who is connected changed somewhere — recount and tell the watchers. It
    // travels through the store rather than being called directly so that a
    // socket opening on another instance still moves the number here.
    if (event.model === 'presence') return broadcastPresence();

    // Addressed to particular connections: deliver to the ones held here.
    if (event.model === 'calls') {
      for (const connectionId of event.to) {
        const entry = sockets.get(connectionId);
        if (entry) send(entry.socket, event.frame);
      }
      return;
    }

    // A group appearing, changing hands or losing a member.
    if (event.model === 'user_groups') return deliverGroup(event);

    // Edits and deletions travel the same path as new messages, and by the
    // same permissions: a correction should reach the people who read the
    // mistake, and a message taken back should stop being on their screen.
    // What neither must do is make a conversation unread again, which is why
    // only a created event touches the counts below.
    if (event.model !== 'user_messages') return;
    if (!['created', 'updated', 'deleted'].includes(event.type)) return;

    const model = fastify.models.user_messages.model;

    for (const [, entry] of sockets) {
      if (entry.userId === null) continue;

      try {
        // Read fresh: permissions and membership may have changed since the
        // socket opened, and a stale copy would leak a conversation.
        const user = await fastify.models.users.findById(entry.userId);
        if (!user?.is_active || !(await inTheConversation(user, model, event.row))) continue;

        if (event.type === 'deleted') {
          send(entry.socket, {
            type: 'message-deleted',
            id: event.row.id,
            group: event.row.group,
          });
          // What was unread may have just stopped existing.
          await sendUnread(entry.socket, user.id);
          continue;
        }

        send(entry.socket, { type: 'message', message: event.row });
        if (event.type === 'created' && Number(event.row.owner) !== Number(user.id)) {
          await sendUnread(entry.socket, user.id);
        }
      } catch (err) {
        fastify.log.warn({ err }, 'Realtime delivery failed');
      }
    }
  });

  fastify.get('/ws', { websocket: true }, async (socket, request) => {
    const connectionId = randomUUID();
    const user = await fastify.sessionUser(request).catch(() => null);

    await store.connect(connectionId, {
      userId: user?.id ?? null,
      address: request.ip,
    });
    sockets.set(connectionId, { socket, userId: user?.id ?? null });

    send(socket, {
      type: 'hello',
      connectionId,
      user: user ? { id: user.id, name: user.name, email: user.email } : null,
      ...(user ? await unreadFor(fastify.models, user.id) : { groups: {}, total: 0 }),
    });

    // After hello, so a dashboard opening its own socket is counted in the
    // first presence frame it receives.
    await store.publish({ model: 'presence', type: 'connected' });

    socket.on('message', async (raw) => {
      let payload;
      try {
        payload = JSON.parse(String(raw));
      } catch {
        return send(socket, { type: 'error', error: 'Expected JSON' });
      }

      const entry = sockets.get(connectionId);
      if (!entry) return;

      if (payload.type === 'ping') return send(socket, { type: 'pong' });

      // The identity is taken from the session cookie every time, never from
      // the frame: a client saying who it is proves nothing.
      const current = entry.userId
        ? await fastify.models.users.findById(entry.userId)
        : await fastify.sessionUser(request).catch(() => null);

      if (!current?.is_active) {
        return send(socket, { type: 'error', error: 'Authentication required' });
      }

      // A socket opened before signing in becomes that user's without
      // reconnecting.
      if (entry.userId === null) {
        entry.userId = current.id;
        await store.identify(connectionId, current.id);
        // An anonymous connection just became a signed-in one.
        await store.publish({ model: 'presence', type: 'identified' });
      }

      // Calls answer for themselves, with the identity this handler proved.
      if (await calls.handle(payload, { connectionId, user: current })) return;

      if (payload.type === 'read') {
        await markRead(fastify.models, current.id, payload.group);
        return sendUnread(socket, current.id);
      }

      if (payload.type === 'unread') {
        return sendUnread(socket, current.id);
      }

      send(socket, { type: 'error', error: `Unknown message type "${payload.type}"` });
    });

    socket.on('close', async () => {
      // Deleted first, so the frames the departure generates are not sent to
      // the socket that has just gone.
      sockets.delete(connectionId);
      await calls.disconnect(connectionId);
      await store.disconnect(connectionId);
      await store.publish({ model: 'presence', type: 'disconnected' });
    });
  });

  fastify.addHook('onClose', async () => {
    calls.close();
    for (const [, entry] of sockets) entry.socket.close();
    sockets.clear();
  });

  console.log(`✅ Realtime ready (${store.kind} store) at /ws.`);
}

export default fp(realtimePlugin, {
  name: 'realtime',
  dependencies: ['auth', 'db', 'rate-limit'],
});
