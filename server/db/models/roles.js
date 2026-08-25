import { allPermissions, isValidPermission } from './catalog.js';
import { Model, ValidationError } from './model.js';

/**
 * `admin` is a system role and is kept in sync with the permission catalog, so
 * registering a new model automatically grants administrators access to it.
 * The others are ordinary starting points and can be edited or deleted.
 */
const DEFAULT_ROLES = [
  {
    name: 'admin',
    description: 'Full access to every model.',
    is_system: true,
    permissions: () => allPermissions(),
  },
  {
    name: 'moderator',
    description: 'Can read and update users, and view roles.',
    is_system: false,
    permissions: () => ['users:read', 'users:update', 'roles:read'],
    /** Was called `editor` until it was renamed; carry the old row over. */
    renamedFrom: 'editor',
  },
  {
    name: 'user',
    description: 'Can use the messenger: the groups they are in, and what is said there.',
    is_system: false,
    /**
     * What an ordinary account needs for the messenger and nothing more: the
     * groups they belong to, everything said in those groups, and the ability
     * to say something themselves. `create:member` rather than `create:own`
     * because writing as yourself is only half of it — the message also has to
     * land in a group you are actually in.
     *
     * The file permissions are all own-scoped, and that is not a restriction
     * on reading attachments: an attachment is read through the message it is
     * on, by whoever may read that message. What `files:read:own` grants is the
     * list of your own uploads.
     */
    permissions: () => [
      'users:read',
      // Their own name and language. Scoped to themselves, and the privileged
      // fields on the users model keep it to that — an own-scoped update
      // cannot reach roles, email, password or is_active.
      'users:update:own',
      'user_groups:read:member',
      /*
       * Starting a conversation. Own-scoped, so the group is filed under them —
       * and a new group has exactly one person in it, because `members` is
       * privileged and the model puts the owner there (see user-groups.js).
       * Growing it past that is the invite route's job, not this permission's.
       */
      'user_groups:create:own',
      /*
       * Ending one. Own-scoped, so it is the owner's decision and nobody
       * else's: a group is not destroyed by people drifting out of it, and the
       * last member left in a conversation keeps it until they say otherwise.
       *
       * Ownership follows the people in it — see the leave route, which hands
       * the column to a remaining member when the owner walks out — so the
       * person who can end a group is always somebody inside it.
       *
       * There is deliberately still no `user_groups:update:*`: changing who is
       * in a group is what invite and leave are for, and `members` is
       * privileged precisely so that it cannot be done by naming a list.
       */
      'user_groups:delete:own',
      'user_messages:read:member',
      'user_messages:create:member',
      // Correcting and withdrawing what you said. Own-scoped, and no longer
      // only by choice: the model does not publish `update:member` or
      // `delete:member` at all, because either would let anybody in a group
      // rewrite or remove anybody else's words in it.
      'user_messages:update:own',
      'user_messages:delete:own',
      'files:create:own',
      'files:read:own',
      'files:delete:own',
    ],
  },
];

/**
 * Permissions added to a default role's definition after that role first
 * shipped, and granted to an existing row that is missing them.
 *
 * A non-system role is deliberately not kept in sync: an installation may have
 * edited it, and refreshing would undo that. But a row created before a
 * permission existed is missing something its own description promises, which
 * reads as a fault rather than as a choice — a `user` role without
 * `users:update:own` leaves every ordinary account unable to edit its own
 * profile or set its own picture, and the only symptom is "Missing required
 * permission: users:update" from a screen that offers to save.
 *
 * Additive and idempotent: nothing is ever removed, and after one boot there is
 * nothing left to do. The cost of it is that removing one of these by hand does
 * not stick — an entry should be dropped from here once the installations that
 * needed it have been through a restart.
 */
const BACKFILL = Object.freeze({
  user: ['users:update:own', 'user_groups:create:own', 'user_groups:delete:own'],
});

/**
 * A role is a named bundle of permissions. Users are granted capabilities
 * only by being assigned roles — see users.js.
 */
class Roles extends Model {
  constructor() {
    super({
      name: 'roles',
      label: 'Roles',
      fields: {
        name: { type: 'string', required: true, unique: true, label: 'Role Name' },
        description: { type: 'text', label: 'Description' },
        is_system: { type: 'boolean', default: false, label: 'System Role' },
      },
      relations: {
        // Stored in role_permissions(role_id, model, action).
        permissions: { type: 'permissionSet' },
      },
      searchable: ['name', 'description'],
    });
  }

  beforeDelete(role) {
    if (role.is_system) {
      throw new ValidationError(`The "${role.name}" role is a system role and cannot be deleted.`);
    }
  }

  async seed(repositories, log) {
    const roles = repositories[this.name];
    const existing = await roles.findAll();
    const byName = new Map(existing.map((role) => [role.name, role]));

    for (const definition of DEFAULT_ROLES) {
      const permissions = definition.permissions().filter(isValidPermission);

      // A renamed default role is the same role: rename the row rather than
      // leaving the old one behind and adding a second one beside it. Only
      // when the new name is free, so a deliberate `moderator` is never
      // overwritten by a stale `editor`.
      const previous = definition.renamedFrom && byName.get(definition.renamedFrom);
      if (previous && !byName.has(definition.name)) {
        const renamed = await roles.update(previous.id, { name: definition.name });
        byName.delete(definition.renamedFrom);
        byName.set(definition.name, renamed);
        log.info(`Renamed the "${definition.renamedFrom}" role to "${definition.name}".`);
      }

      const current = byName.get(definition.name);

      if (!current) {
        await roles.create({
          name: definition.name,
          description: definition.description,
          is_system: definition.is_system,
          permissions,
        });
        log.info(`Seeded "${definition.name}" role.`);
        continue;
      }

      // Only the system role self-heals; edits to the others are respected.
      if (definition.is_system) {
        const drifted =
          current.permissions.join() !== [...permissions].sort().join() || !current.is_system;
        if (drifted) {
          await roles.update(current.id, { is_system: true, permissions });
          log.info(`Refreshed "${definition.name}" role permissions from the catalog.`);
        }
        continue;
      }

      // Everything else keeps what it has, plus anything its definition gained
      // after the row was created. See BACKFILL.
      const missing = (BACKFILL[definition.name] || [])
        .filter((permission) => isValidPermission(permission))
        .filter((permission) => !current.permissions.includes(permission));

      if (missing.length > 0) {
        await roles.update(current.id, {
          permissions: [...current.permissions, ...missing],
        });
        log.warn(
          `Granted ${missing.join(', ')} to the "${definition.name}" role, `
          + 'which predates them.'
        );
      }
    }
  }
}

export default new Roles();
