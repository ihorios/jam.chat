import { unreadFor, markRead } from '../realtime/unread.js';

/** A person as a notice should name them, whatever of their name we have. */
function nameOf(user) {
  return user.name || user.email || `#${user.id}`;
}

/**
 * The conversation's own operations, mounted at /api/messenger: what is new to
 * the caller, and the two changes to a group that are not ordinary CRUD.
 *
 * Reading (`/unread`, `/read`) is also carried by the WebSocket while a tab is
 * open; these exist because a page that has just loaded needs the state before
 * its socket has said hello, and because marking something read should not
 * depend on the socket being up.
 *
 * Joining and leaving are here rather than behind PUT /api/user_groups because
 * `members` is a privileged relation: an ordinary account naming its own
 * members could put anybody into a conversation with anybody. What it may do
 * instead is name one address it already knows, and remove itself.
 *
 * None of the four asks for a permission beyond a session. They are about the
 * caller's own membership, and membership is the authority: only somebody in a
 * group may invite to it or leave it, and a group they are not in is reported
 * as missing rather than forbidden — the same answer a read of it would give,
 * so the response says nothing about what exists outside their groups.
 */
export default async function messengerRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  /** The group named in the URL, if the caller is in it. */
  const groupFor = async (request) => {
    const id = Number.parseInt(request.params.id, 10);
    if (Number.isNaN(id)) return null;
    if (!(await fastify.models.user_groups.isMemberOf(id, request.user.id))) return null;
    return fastify.models.user_groups.findById(id);
  };

  const notFound = (reply) => reply.status(404).send({ ok: false, error: 'User Group not found' });

  fastify.get('/unread', async (request) => ({
    ok: true,
    ...(await unreadFor(fastify.models, request.user.id)),
  }));

  fastify.post('/read', async (request, reply) => {
    const { group } = request.body || {};
    if (group === undefined || group === null) {
      return reply.status(400).send({ ok: false, error: 'A group is required' });
    }

    // Marking a group you are not in has nothing to record. Reported as a
    // miss rather than a refusal, for the same reason reads of it are.
    if (!(await markRead(fastify.models, request.user.id, group))) {
      return notFound(reply);
    }

    return { ok: true, ...(await unreadFor(fastify.models, request.user.id)) };
  });

  /**
   * Puts somebody else in a group the caller is in, named by their address.
   *
   * An exact address and nothing else: no partial match, no list to pick from,
   * no id. That is the whole protection — you can only add someone whose
   * address you already have, so a group cannot be filled by working through
   * ids or guessing at names.
   *
   * An address that belongs to nobody is said so plainly. It is not an
   * enumeration oracle worth guarding: every account holds `users:read`, so
   * who exists is already readable — and an invite that silently did nothing
   * would leave a typo looking like a success.
   *
   * An address that is already in the group is refused and said so, because it
   * is almost always a mistake worth knowing about: the wrong person picked out
   * of a list of similar names, or an address typed from memory that turns out
   * to belong to somebody who is already here. Answering "done" to that would
   * hide it.
   *
   * Which is only useful if the refusal means what it says. A form that submits
   * twice would otherwise add the person on the first request and report them
   * as already present on the second — the same message, for an invitation that
   * had in fact just worked. What stops that is the guard in MessengerPage's
   * handleInvite, not this check.
   */
  fastify.post('/groups/:id/invite', async (request, reply) => {
    const group = await groupFor(request);
    if (!group) return notFound(reply);

    const email = String(request.body?.email || '').trim();
    if (!email) {
      return reply.status(400).send({ ok: false, error: 'An email address is required' });
    }

    // Case-insensitively, as signing in with it is.
    const raw = await fastify.models.users.findRawBy('email', email);
    const invitee = raw ? await fastify.models.users.findById(raw.id) : null;
    // A disabled account cannot sign in, so adding it would put somebody in
    // the conversation who can never read it.
    if (!invitee?.is_active) {
      return reply.status(404).send({ ok: false, error: 'No account uses that address.' });
    }

    const members = group.members.map((member) => member.id);
    if (members.includes(invitee.id)) {
      return reply.status(409).send({
        ok: false,
        error: `${nameOf(invitee)} is already in this group.`,
      });
    }

    const updated = await fastify.models.user_groups.update(group.id, {
      members: [...members, invitee.id],
    });

    // `previous` is what tells the realtime layer who a membership change cost
    // the group; an invite costs nobody, but the same event carries both.
    await fastify.realtime?.publish({
      type: 'updated',
      model: 'user_groups',
      row: updated,
      previous: group,
    });

    return { ok: true, user_group: updated };
  });

  /**
   * Takes the caller out of a group, at any moment and without asking anybody.
   *
   * Leaving never destroys a group somebody is still in — not even a group of
   * one. Ending it is a decision its owner makes, deliberately, by deleting it
   * (DELETE /api/user_groups/:id, which `user_groups:delete:own` grants). So the
   * last person in a conversation keeps it: they are told who left, and it is
   * then theirs to invite somebody else into or to throw away.
   *
   * Which leaves three things to do here:
   *
   *  - The owner leaving is not the group ending. It carries on with the people
   *    still in it, and one of them becomes its owner: the column is what
   *    `user_groups:*:own` resolves against, so leaving it pointing at somebody
   *    who walked out would both go on giving them the group and leave nobody
   *    inside it able to delete it.
   *  - Everybody still there is told, in the conversation itself. See the
   *    `system` field on user_messages: a notice is an ordinary message, so it
   *    arrives live, counts as unread and keeps its place in the thread.
   *  - A group with nobody at all left in it goes. That is the one case where
   *    leaving removes one, and it is not a policy so much as an absence: there
   *    is no member to read it, no member to invite anybody into it, and no
   *    owner inside it to delete it. Kept, it would be reachable only from the
   *    dashboard.
   */
  fastify.post('/groups/:id/leave', async (request, reply) => {
    const group = await groupFor(request);
    if (!group) return notFound(reply);

    const remaining = group.members.filter((member) => member.id !== request.user.id);

    // The last one out. Nobody is left to be told, and nothing to tell them in.
    if (remaining.length === 0) {
      await fastify.models.user_groups.remove(group.id);
      // The row as it was: it is the only thing left that can say who was
      // entitled to hear that it is gone.
      await fastify.realtime?.publish({ type: 'deleted', model: 'user_groups', row: group });
      return { ok: true, removed: true };
    }

    const ownerLeft = Number(group.owner) === Number(request.user.id);
    const updated = await fastify.models.user_groups.update(group.id, {
      members: remaining.map((member) => member.id),
      /*
       * The oldest of the accounts left in it — the lowest user id, and when one
       * person is left, simply them.
       *
       * Not the longest-standing *member*, which would be the better rule and is
       * not available: user_group_users records who is in a group and not when
       * they joined, and writeRelations replaces the whole set on every change,
       * so neither a column nor row order can be read as join order. What this
       * rule does guarantee is that the answer is the same on both drivers
       * rather than following whatever order a repository returns members in —
       * and it always names somebody inside the group, which is what matters,
       * since the owner is the one person who can delete it.
       */
      ...(ownerLeft ? { owner: Math.min(...remaining.map((member) => member.id)) } : {}),
    });

    // Their place in a conversation they are no longer in. Left behind, it
    // would come back if they were ever invited again — silently marking
    // everything said before today as already read.
    const marker = (await fastify.models.user_group_reads.findAll({ owner: request.user.id }, 0))
      .find((read) => read.group === group.id);
    if (marker) await fastify.models.user_group_reads.remove(marker.id);

    // After the membership change, so the notice reaches the people still
    // there rather than the person it is about.
    const notice = await fastify.models.user_messages.create({
      owner: request.user.id,
      group: group.id,
      value: `${nameOf(request.user)} left the group.`,
      system: true,
    });

    await fastify.realtime?.publish({
      type: 'updated',
      model: 'user_groups',
      row: updated,
      previous: group,
    });
    await fastify.realtime?.publish({
      type: 'created',
      model: 'user_messages',
      row: notice,
    });

    return { ok: true, removed: false };
  });
}
