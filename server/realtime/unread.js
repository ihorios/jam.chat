/**
 * What is new to a user, and saying that they have seen it.
 *
 * "New" is always relative to their own membership: the groups they belong to,
 * and what other people said in them since they last looked. Their own
 * messages are never news, and a group they can administer but is not theirs
 * to be in does not count either — an administrator reading every group is not
 * thereby behind on every conversation.
 */

/** Counts per group plus the total, for one user. */
export async function unreadFor(models, userId) {
  const [groups, reads, messages] = await Promise.all([
    models.user_groups.findAll({ member: userId }, 0),
    models.user_group_reads.findAll({ owner: userId }, 0),
    models.user_messages.findAll({ member: userId }, 0),
  ]);

  const readAt = new Map(reads.map((read) => [read.group, Date.parse(read.last_read_at)]));
  const groupsById = new Map(groups.map((group) => [group.id, 0]));

  for (const message of messages) {
    if (Number(message.owner) === Number(userId)) continue;
    if (!groupsById.has(message.group)) continue;

    const since = readAt.get(message.group);
    // Never looked at the group at all: everything in it is unread.
    if (since !== undefined && Date.parse(message.created_at) <= since) continue;

    groupsById.set(message.group, groupsById.get(message.group) + 1);
  }

  const groupCounts = Object.fromEntries(groupsById);
  return {
    groups: groupCounts,
    total: Object.values(groupCounts).reduce((sum, count) => sum + count, 0),
  };
}

/**
 * Records that the user has now seen everything in `groupId`. Only meaningful
 * for a group they are in; asked about any other, it does nothing rather than
 * writing a marker that could never be reached.
 */
export async function markRead(models, userId, groupId, at = new Date().toISOString()) {
  const id = Number.parseInt(groupId, 10);
  if (Number.isNaN(id)) return false;
  if (!(await models.user_groups.isMemberOf(id, userId))) return false;

  const existing = (await models.user_group_reads.findAll({ owner: userId }, 0))
    .find((read) => read.group === id);

  if (existing) {
    await models.user_group_reads.update(existing.id, { last_read_at: at });
  } else {
    await models.user_group_reads.create({ user: userId, group: id, last_read_at: at });
  }
  return true;
}
