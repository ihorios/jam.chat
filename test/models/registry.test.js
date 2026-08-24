import t from 'tap';

import {
  models,
  modelList,
  getModel,
  allPermissions,
  permissionsByModel,
  isValidPermission,
  permissionKey,
  parsePermission,
  CRUD_ACTIONS,
} from '../../server/db/models/index.js';
import { Model } from '../../server/db/models/model.js';
import { ValidationError } from '../../server/db/models/fields.js';

t.test('every model file in server/db/models is auto-registered', async (t) => {
  t.same(
    Object.keys(models).sort(),
    ['files', 'roles', 'user_group_reads', 'user_groups', 'user_messages', 'users']
  );
  t.equal(modelList.length, 6);
  t.ok(modelList.every((model) => model instanceof Model), 'only models are picked up');
  t.equal(getModel('users').name, 'users');
  t.throws(() => getModel('ghosts'), /Unknown model "ghosts"/);
});

t.test('models are ordered so that requirements come first', async (t) => {
  t.same(
    modelList.map((model) => model.name),
    ['roles', 'users', 'files', 'user_groups', 'user_group_reads', 'user_messages'],
    'roles before users (user_roles), then the models keyed into those'
  );

  t.same(getModel('roles').requires, []);
  t.same(getModel('users').requires, ['roles']);
  t.same(getModel('files').requires, ['users']);
  t.same(getModel('user_groups').requires, ['users']);
  t.same(getModel('user_messages').requires, ['users', 'user_groups', 'files']);
  t.same(getModel('user_group_reads').requires, ['users', 'user_groups']);

  for (const model of modelList) {
    const position = modelList.indexOf(model);
    for (const name of model.requires) {
      t.ok(
        modelList.indexOf(getModel(name)) < position,
        `${name} is installed before ${model.name}`
      );
    }
  }
});

t.test('the permission catalog is the union of what the models declare', async (t) => {
  const expected = modelList.flatMap((model) => model.permissions()).sort();

  t.same(allPermissions().sort(), expected, 'nothing in the catalog no model asked for');

  // Most models take the default: one permission per declared action, at each
  // scope they can answer for. A model declaring no actions therefore
  // contributes nothing at all.
  const expectedCount = modelList.reduce((total, model) => {
    // files and users both override permissions() rather than take the
    // default, so their counts are read from what they actually declare.
    if (model.name === 'files' || model.name === 'users') {
      return total + model.permissions().length;
    }
    const scopes = 1 + (model.membership ? 1 : 0) + (model.ownedBy ? 1 : 0);
    return total + scopes * model.actions.length;
  }, 0);
  t.equal(allPermissions().length, expectedCount);
  t.equal(CRUD_ACTIONS.length, 4);

  // files is the exception, and the reason permissions() is overridable: it
  // grants uploading without exposing a JSON create route to grant it through.
  const files = getModel('files');
  t.notOk(files.actions.includes('create'), 'no create action, so no create route');
  t.ok(files.permissions().includes('files:create'), 'but the permission exists');
  t.ok(files.permissions().includes('files:create:own'), 'at both scopes');
  t.same(files.scopesFor('create'), ['any', 'own'], 'so a guard can resolve it');
  t.same(
    getModel('user_group_reads').permissions(),
    [],
    'an internal table grants nothing, however it is owned'
  );

  t.ok(isValidPermission('users:read'));
  t.ok(isValidPermission('roles:delete'));
  t.ok(isValidPermission('user_groups:create'), 'a new model brings its own permissions');
  t.notOk(isValidPermission('users:write'), 'the legacy vocabulary is gone');
  t.notOk(isValidPermission('admin:access'));
  t.notOk(isValidPermission('ghosts:read'), 'permissions only exist for registered models');
});

t.test('a model gets the scopes it can answer for, and no others', async (t) => {
  t.ok(isValidPermission('user_groups:read:own'), 'a group has an owner');
  t.ok(isValidPermission('user_groups:read:member'), 'and members');
  t.ok(isValidPermission('user_messages:update:own'), 'a message has an author');
  t.ok(
    isValidPermission('user_messages:read:member'),
    'and belongs to whoever belongs to its group'
  );

  t.notOk(
    isValidPermission('users:read:own'),
    'nothing owns a user, so there is no own-scoped user permission to grant'
  );
  t.notOk(isValidPermission('roles:update:own'));
  t.notOk(isValidPermission('roles:read:member'), 'and nobody is a member of a role');
  t.notOk(isValidPermission('user_groups:read:mine'), 'an invented scope is not a permission');

  t.equal(permissionKey('users', 'read'), 'users:read');
  t.equal(permissionKey('users', 'read', 'any'), 'users:read', 'any is the unsuffixed form');
  t.equal(permissionKey('user_groups', 'read', 'own'), 'user_groups:read:own');
  t.equal(permissionKey('user_groups', 'read', 'member'), 'user_groups:read:member');

  t.same(parsePermission('users:read'), { model: 'users', action: 'read', scope: 'any' });
  t.same(
    parsePermission('user_groups:read:member'),
    { model: 'user_groups', action: 'read', scope: 'member' }
  );

  t.same(
    getModel('user_messages').scopesFor('read'),
    ['any', 'member', 'own'],
    'and a check tries them broadest first'
  );
});

t.test('membership is declared, directly or by deferral', async (t) => {
  const groups = getModel('user_groups');
  const messages = getModel('user_messages');

  t.same(groups.membership, { relation: 'members' }, 'a group knows its own members');
  t.equal(groups.membershipRelation.through, 'user_group_users');
  t.equal(groups.membershipVia, null);

  t.same(messages.membership, { via: 'group' }, 'a message defers to its group');
  t.equal(messages.membershipVia.column, 'group_id');
  t.equal(messages.membershipVia.target, 'user_groups');
  t.equal(messages.membershipRelation, null);

  t.equal(getModel('users').membership, null);
  t.equal(getModel('roles').membership, null);
});

t.test('the catalog is grouped for the admin UI', async (t) => {
  const grouped = permissionsByModel();
  t.equal(
    grouped.length,
    modelList.filter((model) => model.permissions().length > 0).length,
    'a model granting nothing is left out of the matrix entirely'
  );
  t.notOk(
    grouped.some((entry) => entry.model === 'user_group_reads'),
    'read markers are bookkeeping, not something to administer'
  );

  for (const entry of grouped) {
    t.same(entry.permissions, getModel(entry.model).permissions(), `${entry.model} verbatim`);
  }

  const users = grouped.find((entry) => entry.model === 'users');
  t.equal(users.label, 'Users');
  t.same(users.actions, ['create', 'read', 'update', 'delete']);
  t.same(users.scopes, ['any', 'own'], 'a second row of checkboxes, for editing yourself');
  t.equal(users.ownedBy, null, 'ownership here is identity, not a foreign key');
  t.same(users.permissions, [
    'users:create', 'users:read', 'users:update', 'users:delete', 'users:update:own',
  ]);

  const groups = grouped.find((entry) => entry.model === 'user_groups');
  t.equal(groups.label, 'User Groups');
  t.same(
    groups.scopes,
    ['any', 'member', 'own'],
    'three rows: every group, the ones you are in, the ones you own'
  );
  t.equal(groups.ownedBy, 'owner');
  t.same(groups.permissions, [
    'user_groups:create', 'user_groups:read', 'user_groups:update', 'user_groups:delete',
    'user_groups:create:member', 'user_groups:read:member',
    'user_groups:update:member', 'user_groups:delete:member',
    'user_groups:create:own', 'user_groups:read:own',
    'user_groups:update:own', 'user_groups:delete:own',
  ]);
});

t.test('users hold roles, not permissions', async (t) => {
  const users = getModel('users');

  t.notOk(users.fields.permissions, 'no permissions column on a user');
  t.notOk(users.fields.role, 'no role string column on a user');
  t.notOk(users.fields.name, 'name is derived from first_name + last_name, not stored');
  t.same(
    Object.keys(users.fields).sort(),
    [
      'email', 'email_confirmed', 'first_name', 'is_active', 'language',
      'last_name', 'logo', 'logo_file', 'password',
    ]
  );

  // Both are about the account rather than chosen by it, so only one of them is
  // the account's own business to change: see Model#privilegedKeys.
  t.ok(users.privilegedKeys().includes('email_confirmed'), 'confirmation is not self-served');
  t.notOk(users.privilegedKeys().includes('logo'), 'but your own picture is yours to set');
  // Naming a file id is not the same as choosing a picture: the upload route
  // creates the file it points at, which is why the field itself is closed.
  t.ok(users.privilegedKeys().includes('logo_file'), 'an uploaded picture is set by uploading');

  const roles = users.relations.roles;
  t.equal(roles.kind, 'manyToMany');
  t.equal(roles.target, 'roles');
  t.equal(roles.through, 'user_roles');
  t.equal(roles.localKey, 'user_id');
  t.equal(roles.targetKey, 'role_id');
});

t.test('user permissions are the union of their roles', async (t) => {
  const users = getModel('users');

  const user = {
    first_name: 'Ada',
    last_name: 'Lovelace',
    roles: [
      { permissions: ['users:read', 'users:update'] },
      { permissions: ['users:read', 'roles:read'] },
    ],
  };
  users.transform(user);
  t.equal(user.name, 'Ada Lovelace', 'display name is derived');
  t.same(user.permissions, ['roles:read', 'users:read', 'users:update'], 'deduped and sorted');

  const roleless = { roles: [] };
  users.transform(roleless);
  t.same(roleless.permissions, [], 'no roles means no permissions');

  const undefinedRoles = {};
  users.transform(undefinedRoles);
  t.same(undefinedRoles.permissions, []);
});

t.test('roles own a permission set and protect system rows', async (t) => {
  const roles = getModel('roles');

  const permissions = roles.relations.permissions;
  t.equal(permissions.kind, 'permissionSet');
  t.equal(permissions.through, 'role_permissions');
  t.equal(permissions.localKey, 'role_id');

  t.throws(
    () => roles.beforeDelete({ name: 'admin', is_system: true }),
    ValidationError,
    'system roles cannot be deleted'
  );
  t.doesNotThrow(() => roles.beforeDelete({ name: 'editor', is_system: false }));
});

t.test('every model is identified by its base table', async (t) => {
  for (const model of modelList) {
    t.equal(model.id, model.table, `${model.name}.id is its table`);
  }
  t.equal(getModel('user_groups').id, 'user_groups');
});

t.test('a user group is owned by one user and holds many', async (t) => {
  const groups = getModel('user_groups');

  t.equal(groups.label, 'User Groups');
  t.same(Object.keys(groups.fields), ['owner'], 'created_at already records the creation time');

  const owner = groups.fields.owner;
  t.equal(owner.type, 'reference');
  t.equal(owner.target, 'users');
  t.equal(owner.column, 'owner_id', 'stored as a foreign key into the user primary key');
  t.ok(owner.required);

  t.equal(groups.ownedBy, 'owner', 'which is also what own-scoped access is resolved against');
  t.equal(groups.ownerColumn, 'owner_id');
  t.ok(groups.ownedByUser({ owner: 7 }, 7));
  t.ok(groups.ownedByUser({ owner: 7 }, '7'), 'a path parameter is a string');
  t.notOk(groups.ownedByUser({ owner: 7 }, 8));
  t.notOk(getModel('roles').ownedByUser({ id: 7 }, 7), 'a model with no owner owns nothing');

  // users is the exception: it declares no owner column because the row *is*
  // the user, and answers the ownership question directly instead.
  const users = getModel('users');
  t.equal(users.ownedBy, null);
  t.equal(users.ownerColumn, 'id');
  t.ok(users.ownedByUser({ id: 7 }, 7), 'a user owns themselves');
  t.ok(users.ownedByUser({ id: 7 }, '7'), 'a path parameter is a string');
  t.notOk(users.ownedByUser({ id: 7 }, 8), 'and nobody else');

  const members = groups.relations.members;
  t.equal(members.kind, 'manyToMany');
  t.equal(members.target, 'users');
  t.equal(members.through, 'user_group_users');
  t.equal(members.localKey, 'user_group_id');
  t.equal(members.targetKey, 'user_id');
});

t.test('a message belongs to an author and a group', async (t) => {
  const messages = getModel('user_messages');

  t.same(Object.keys(messages.fields), ['owner', 'group', 'value', 'reply_to', 'system']);
  t.same(Object.keys(messages.relations), ['files'], 'attachments are the one side table');
  t.same(messages.schema().length, 2, 'the message table, then the link table');

  t.match(messages.fields.owner, { type: 'reference', target: 'users', column: 'owner_id' });
  t.match(messages.fields.group, {
    type: 'reference', target: 'user_groups', column: 'group_id', required: true,
  });
  t.match(messages.fields.value, { type: 'text', required: true, label: 'Message' });
  t.match(
    messages.fields.system,
    { type: 'boolean', privileged: true },
    'a notice is written by the application, so no client may claim to be one'
  );
  t.ok(messages.privilegedKeys().includes('system'));

  t.equal(messages.ownedBy, 'owner', 'the author owns it, not the group');
  t.same(messages.searchable, ['value']);
});

t.test('a message may answer another message', async (t) => {
  const messages = getModel('user_messages');
  const replyTo = messages.fields.reply_to;

  t.match(replyTo, {
    type: 'reference',
    target: 'user_messages',
    column: 'reply_to_id',
    required: false,
    onDelete: 'SET NULL',
  }, 'optional, self-referential, and not a cascade');

  t.same(
    messages.requires,
    ['users', 'user_groups', 'files'],
    'pointing at itself is not a dependency to order around'
  );
  t.ok(
    messages.dependencies().includes('user_messages'),
    'though it is still a target the model knows about'
  );
});
