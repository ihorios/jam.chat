import { Model } from './model.js';

/**
 * How far a user has read in a group — one row per person per conversation,
 * holding the moment they last looked at it. Anything said after that is new
 * to them, which is what outlines a group in the sidebar and lights the dot in
 * the header. Keeping it on the server rather than in the browser is what
 * makes it survive signing out and back in, or moving to another machine.
 *
 * `actions: []` makes this an internal table: it gets a table, a repository
 * and the schema treatment like any model, but no REST routes and no
 * permissions, because it is bookkeeping rather than something to administer.
 * It is written through the messenger routes, which only ever let a session
 * mark its own reading.
 *
 * There is no composite unique key on (user, group) — the model layer has no
 * way to declare one — so markRead() updates the existing row when there is
 * one instead of relying on the database to refuse a second.
 */
class UserGroupReads extends Model {
  constructor() {
    super({
      name: 'user_group_reads',
      label: 'Read Markers',
      requires: ['users', 'user_groups'],
      actions: [],
      ownedBy: 'user',
      fields: {
        user: { type: 'reference', target: 'users', required: true, label: 'Reader' },
        group: { type: 'reference', target: 'user_groups', required: true, label: 'Group' },
        last_read_at: { type: 'timestamp', required: true, label: 'Last Read' },
      },
    });
  }
}

export default new UserGroupReads();
