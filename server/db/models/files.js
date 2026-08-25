import { permissionKey } from './catalog.js';
import { Model } from './model.js';
import { removeObject } from '../../files/index.js';

/**
 * Something a user uploaded: a name to show, a size, and where the bytes went.
 *
 * The bytes are never here. `provider_name` says which storage wrote them and
 * `provider_id` is that provider's own reference — an opaque string this model
 * neither builds nor reads. Both are immutable, because rewriting either would
 * silently orphan whatever they point at.
 *
 * `ownedBy` is the uploader, which is what files:*:own resolves against. It is
 * also the only permission an ordinary user needs: reading somebody else's
 * attachment is not a permission at all but a consequence of being in the
 * group it was sent to, and that decision lives in routes/files.js where the
 * message can be consulted.
 */
class Files extends Model {
  constructor() {
    super({
      name: 'files',
      label: 'Files',
      requires: ['users'],
      ownedBy: 'owner',
      // No 'create': a row that named its own provider_id without uploading
      // anything would point at somebody else's bytes. Files come into
      // existence by being uploaded (POST /api/files) and no other way, so the
      // generic JSON create route must not exist.
      actions: ['read', 'update', 'delete'],
      fields: {
        /*
         * The uploader — and `SET NULL` rather than `CASCADE`, which is the
         * difference between an account being deleted and its uploads being
         * destroyed with it.
         *
         * Cascading was worse than it looked: Postgres performs a cascade
         * itself, so the rows went without any model hook running, and every
         * object those rows pointed at stayed in the bucket with nothing left
         * that knew it was there. Deleting one account leaked everything it had
         * ever uploaded.
         *
         * Nullable for the same reason, so it is optional here. An upload always
         * sets it (routes/files.js) and there is no create route to omit it, so
         * a null owner only ever means "the account that uploaded this is gone".
         * Such a file belongs to nobody: `files:*:own` stops matching it, and
         * whether it is still readable follows the message it is attached to,
         * exactly as it did before.
         */
        owner: {
          type: 'reference',
          target: 'users',
          onDelete: 'SET NULL',
          label: 'Owner',
        },
        name: { type: 'string', required: true, label: 'File Name' },
        mime_type: { type: 'string', label: 'Type' },
        provider_name: { type: 'string', required: true, immutable: true, label: 'Stored In' },
        provider_id: { type: 'string', required: true, immutable: true, label: 'Object' },
        extension: { type: 'string', label: 'Extension' },
        size: { type: 'integer', required: true, label: 'Bytes' },
      },
      searchable: ['name', 'extension'],
    });
  }

  /**
   * The permission to upload exists even though the create *route* does not.
   * Declaring the action would generate a JSON create endpoint; declaring only
   * the permission gives the upload route something to guard on and the roles
   * screen something to grant. The catalog reads this rather than the action
   * list, which is exactly what it is for.
   */
  permissions() {
    return [
      ...super.permissions(),
      permissionKey(this.name, 'create'),
      permissionKey(this.name, 'create', 'own'),
    ];
  }

  /**
   * The bytes go first, and the row only if they did.
   *
   * From beforeDelete rather than afterDelete, because the row is the only
   * record that its object exists: delete it first and a failed object delete
   * leaves bytes in the bucket that nothing knows about and nothing will ever
   * retry. Throwing here refuses the whole delete instead — the row stays, and
   * so does the thing it points at.
   *
   * The residual risk is the other way round, and it is the lesser one: if the
   * object goes and the row delete then fails, a row is left pointing at bytes
   * that are not there. That reads as a 404 on one download, and the sweep
   * collects the row once nothing references it.
   */
  async beforeDelete(row) {
    await removeObject(row);
  }

  /**
   * And nobody is left pointing at it. users.logo_file is a plain id rather
   * than a foreign key — files already reference users, and a key back would be
   * a cycle the schema cannot create — so ON DELETE SET NULL is this, written
   * out by hand.
   *
   * Errors are swallowed on purpose: the row is already gone by now, and
   * throwing would report a delete that happened as one that did not. A stale
   * id costs a 404 on one picture, which falls back to the person's initials.
   */
  async afterDelete(row, context) {
    try {
      const users = context?.getRepo?.('users');
      if (!users) return;

      const holder = await users.findRawBy('logo_file', row.id);
      if (holder) await users.update(holder.id, { logo_file: null });
    } catch {
      // Nothing to do about it here; the picture simply falls back.
    }
  }
}

export default new Files();
