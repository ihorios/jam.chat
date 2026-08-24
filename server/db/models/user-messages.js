import { Model } from './model.js';

/**
 * Something a user said in a group. Two foreign keys and a body: `owner` is
 * who wrote it, `group` is where, and `value` is what.
 *
 * Author and group both cascade, so a message outlives neither — there is
 * nowhere for it to belong once either is gone. `ownedBy` points at the
 * author, which is what user_messages:*:own resolves against: a role can be
 * granted "your own messages" without seeing anybody else's.
 *
 * Membership is not the message's own business: whoever belongs to its group
 * belongs to it. That is what `membership: { via: 'group' }` says, and it is
 * how user_messages:*:member comes to mean "everything said in the groups you
 * are in" — including what other people said, which is the whole point of a
 * conversation.
 *
 * `reply_to` points at another message and is the exception: it is optional,
 * and deleting the message replied to sets it to null rather than taking the
 * reply with it. A reply is a remark in its own right — losing the thing it
 * answered leaves it stranded, not meaningless.
 */
/**
 * Everything a message carries, gone the moment the message is.
 *
 * Not a cascade, and not something a foreign key could be asked to do: an
 * attachment is a many-to-many, so deleting a message removes the *links* and
 * no database can express "and the file too, if that was the last one". The
 * sweep in plugins/files.js is the backstop for files that were never attached
 * to anything; this is what makes an attachment go with its message rather than
 * up to an hour later.
 *
 * The link table cascades, so by the time this runs the message no longer
 * points at anything — which is exactly what makes the question answerable:
 * a file still referenced by some *other* message is somebody else's and stays.
 * Asking the link table rather than reading the messages is the difference
 * between an indexed read of three ids and a scan of every message ever sent —
 * on the ordinary path of somebody deleting one message of their own.
 *
 * Deleting through the repository rather than the table is deliberate: it is
 * what runs the files model's own afterDelete, and so what deletes the bytes.
 */
async function removeOrphanedAttachments(row, getRepo) {
  const attachments = row?.files || [];
  if (attachments.length === 0 || !getRepo) return;

  const stillAttached = new Set(await getRepo('user_messages')
    .linkedTargets('files', attachments.map((file) => file.id)));

  const files = getRepo('files');
  for (const attachment of attachments) {
    if (stillAttached.has(attachment.id)) continue;
    await files.remove(attachment.id);
  }
}

class UserMessages extends Model {
  constructor() {
    super({
      name: 'user_messages',
      label: 'User Messages',
      // Every target must exist before this model's keys can point at it.
      // user_messages is not listed: a model never has to require itself.
      requires: ['users', 'user_groups', 'files'],
      ownedBy: 'owner',
      membership: { via: 'group' },
      fields: {
        owner: { type: 'reference', target: 'users', required: true, label: 'Author' },
        group: { type: 'reference', target: 'user_groups', required: true, label: 'Group' },
        value: { type: 'text', required: true, label: 'Message' },
        reply_to: {
          type: 'reference',
          target: 'user_messages',
          onDelete: 'SET NULL',
          label: 'In Reply To',
        },
        /*
         * Written by the application rather than by a person: "so-and-so left
         * the group". A message like any other, so that it arrives live, counts
         * as unread and keeps its place in the conversation — and it carries the
         * person it is about as its author, because a message needs one.
         *
         * Privileged, so a scoped caller cannot dress their own message up as a
         * notice from the application.
         */
        system: { type: 'boolean', default: false, label: 'System Notice', privileged: true },
      },
      relations: {
        // Attachments. Both sides of the link table cascade, so deleting a
        // message or a file removes the link — but not the other row. A file
        // left attached to nothing is collected by the sweep in plugins/files.js
        // rather than by the database, because the row was never the expensive
        // part: the object behind it is.
        files: { type: 'manyToMany', target: 'files', through: 'user_message_files' },
      },
      searchable: ['value'],
    });
  }

  /** A deleted message takes its attachments with it. */
  async afterDelete(row, { getRepo } = {}) {
    await removeOrphanedAttachments(row, getRepo);
  }
}

export default new UserMessages();
