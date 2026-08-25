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
  /*
   * Three reads, none of which grows with the size of a conversation.
   *
   * The memberships are the groups this user is in *and* how far they have read
   * in each, because both are the same fact about the same pair — read by the
   * target key, which is the side `idx_user_group_users_user_id` exists for.
   *
   * The counting is then an aggregate rather than a tally: one row per group,
   * instead of every message in every group. It used to read the lot and count
   * them here, which cost the length of the conversation per reader per
   * message — the thing that made a busy group slow to post into.
   */
  const memberships = await models.user_groups.readLinks('members', { target: userId });

  if (memberships.length === 0) return { groups: {}, latest: {}, total: 0 };

  const summary = await models.user_messages.countNewer(
    'group',
    // `owner` is the group: the link row is keyed (group, user).
    memberships.map((membership) => ({
      id: membership.owner,
      since: membership.last_read_at,
    })),
    // Your own words are never news.
    { notOwnedBy: userId }
  );

  /*
   * The last thing said in each group, for the line under its name in the
   * sidebar — the messenger holds only the conversation it has open, so it has
   * nothing of its own to draw one from for the rest.
   *
   * One read of the handful of rows the aggregate named, rather than of every
   * message it looked at to name them.
   */
  const latestIds = summary.map((entry) => entry.latest).filter((id) => id !== null);
  const previews = new Map(
    (await models.user_messages.findByIds(latestIds, 0))
      .map((message) => [message.id, message])
  );

  const groups = {};
  const latest = {};
  for (const entry of summary) {
    groups[entry.id] = entry.newer;

    const preview = entry.latest === null ? null : previews.get(entry.latest);
    if (preview) {
      latest[entry.id] = {
        id: preview.id,
        value: preview.value,
        owner: preview.owner,
        system: preview.system,
        created_at: preview.created_at,
      };
    }
  }

  return {
    groups,
    latest,
    total: Object.values(groups).reduce((sum, count) => sum + count, 0),
  };
}

/**
 * Records that the user has now seen everything in `groupId`.
 *
 * One write, and the membership check falls out of it: the row being updated
 * *is* the membership, so there is nothing to update unless they are in the
 * group. False means exactly that — asked about any other group it does
 * nothing, rather than writing a marker that could never be reached.
 */
export async function markRead(models, userId, groupId, at = new Date().toISOString()) {
  const id = Number.parseInt(groupId, 10);
  if (Number.isNaN(id)) return false;

  return models.user_groups.writeLink('members', id, userId, { last_read_at: at });
}
