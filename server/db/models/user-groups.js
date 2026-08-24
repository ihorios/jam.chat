import { Model } from './model.js';

/**
 * A named-by-nobody bag of users: an owner (whoever created it) and a set of
 * members. Both point at users, so the model is installed after it.
 *
 * `owner` is a single foreign key — user_groups.owner_id, pointing at the
 * user's primary key — while `members` is a many-to-many through
 * user_group_users, so a user may belong to any number of groups and a group
 * to any number of users. Deleting the owner deletes the group; deleting a
 * member only drops their membership row.
 *
 * `ownedBy` and `membership` make those two roles mean something beyond
 * bookkeeping: they are what user_groups:*:own and user_groups:*:member are
 * resolved against, so a role can be granted "the groups you are in" or "the
 * ones you own" rather than "every group".
 */
class UserGroups extends Model {
  constructor() {
    super({
      name: 'user_groups',
      label: 'User Groups',
      // users must exist first: owner_id and user_group_users both key into it.
      requires: ['users'],
      ownedBy: 'owner',
      membership: { relation: 'members' },
      fields: {
        owner: { type: 'reference', target: 'users', required: true, label: 'Owner' },
      },
      relations: {
        /*
         * Privileged: who is in a group is decided by invitation, not by a list
         * of ids in a request body. An ordinary account naming its own members
         * would be able to put anybody into a conversation with anybody — see
         * routes/messenger.js, where a member invites by an address they must
         * already know. The dashboard writes this field directly, as it does
         * every other privileged one.
         */
        members: {
          type: 'manyToMany',
          target: 'users',
          through: 'user_group_users',
          privileged: true,
        },
      },
    });
  }

  /**
   * A new group has exactly one person in it: whoever created it.
   *
   * `members` above is privileged, so a scoped create arrives here with none —
   * and a group nobody is in is a group nobody can read. The owner is put in it
   * rather than left out, which is also what makes "create a group, then invite
   * somebody" the only way an ordinary account builds one.
   *
   * An unscoped caller — the dashboard — says who the members are, and is left
   * alone.
   */
  async parseInput(input, options = {}) {
    const parsed = await super.parseInput(input, options);

    const owner = parsed.columns[this.fields.owner.column];
    if (!options.partial && owner && !parsed.relations.members?.length) {
      parsed.relations.members = [Number(owner)];
    }

    return parsed;
  }

  // No seed(): a default group would need an owner, and a fresh database has
  // no users to own one. Tests create their own.
}

export default new UserGroups();
