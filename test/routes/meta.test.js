import t from 'tap';

import { asAdmin, buildTestApp, call } from '../helper.js';

t.test('the meta endpoints require a session', async (t) => {
  const app = await buildTestApp(t);

  for (const url of ['/api/meta', '/api/permissions']) {
    const [status, body] = await call(app, 'GET', url);
    t.equal(status, 401, `${url} is not public`);
    t.equal(body.ok, false);
  }
});

t.test('GET /api/permissions publishes the generated catalog', async (t) => {
  const { call } = await asAdmin(t);
  const [status, body] = await call('GET', '/api/permissions');

  t.equal(status, 200);
  t.equal(body.ok, true);
  t.same(body.permissions.sort(), [
    // files grants an upload permission with no create route behind it, which
    // is why its list is not simply its actions.
    'files:create', 'files:create:own',
    'files:delete', 'files:delete:own',
    'files:read', 'files:read:own',
    'files:update', 'files:update:own',
    'roles:create', 'roles:delete', 'roles:read', 'roles:update',
    'user_groups:create', 'user_groups:create:member', 'user_groups:create:own',
    'user_groups:delete', 'user_groups:delete:member', 'user_groups:delete:own',
    'user_groups:read', 'user_groups:read:member', 'user_groups:read:own',
    'user_groups:update', 'user_groups:update:member', 'user_groups:update:own',
    'user_messages:create', 'user_messages:create:member', 'user_messages:create:own',
    'user_messages:delete', 'user_messages:delete:member', 'user_messages:delete:own',
    'user_messages:read', 'user_messages:read:member', 'user_messages:read:own',
    'user_messages:update', 'user_messages:update:member', 'user_messages:update:own',
    // users:update:own is what lets an account edit its own profile without
    // being able to touch anybody else's.
    'users:create', 'users:delete', 'users:read', 'users:update', 'users:update:own',
  ]);

  // The admin UI renders one matrix row per entry here.
  t.same(
    body.models.map((entry) => entry.model).sort(),
    ['files', 'roles', 'user_groups', 'user_messages', 'users']
  );
  const users = body.models.find((entry) => entry.model === 'users');
  t.equal(users.label, 'Users');
  t.same(users.actions, ['create', 'read', 'update', 'delete']);
  t.same(users.scopes, ['any', 'own']);
  t.same(users.permissions, [
    'users:create', 'users:read', 'users:update', 'users:delete', 'users:update:own',
  ]);

  // The matrix draws a second row of checkboxes for a model that can be owned.
  const groups = body.models.find((entry) => entry.model === 'user_groups');
  t.same(groups.scopes, ['any', 'member', 'own']);
  t.equal(groups.ownedBy, 'owner');
  t.equal(groups.permissions.length, 12);
});

t.test('GET /api/meta describes every registered model', async (t) => {
  const { call } = await asAdmin(t);
  const [status, body] = await call('GET', '/api/meta');

  t.equal(status, 200);
  t.same(
    body.models.map((model) => model.name).sort(),
    ['files', 'roles', 'user_groups', 'user_messages', 'users']
  );

  const users = body.models.find((model) => model.name === 'users');
  t.same(users.searchable, ['first_name', 'last_name', 'email']);
  t.same(users.relations, [{ name: 'roles', kind: 'manyToMany', target: 'roles' }]);

  // The dashboard builds its forms from this.
  t.same(
    users.fields.map((field) => field.name),
    [
      'email', 'first_name', 'last_name', 'password', 'is_active',
      'email_confirmed', 'logo', 'logo_file', 'language',
    ]
  );

  const email = users.fields.find((field) => field.name === 'email');
  t.match(email, { type: 'string', required: true, unique: true, hidden: false });

  const password = users.fields.find((field) => field.name === 'password');
  t.equal(password.hidden, true, 'the client can tell which fields are write-only');

  const roles = body.models.find((model) => model.name === 'roles');
  t.same(roles.relations, [{ name: 'permissions', kind: 'permissionSet', target: null }]);

  const groups = body.models.find((model) => model.name === 'user_groups');
  t.same(groups.relations, [{ name: 'members', kind: 'manyToMany', target: 'users' }]);
  t.same(groups.fields.map((field) => field.name), ['owner']);
  t.equal(groups.ownedBy, 'owner', 'so a client knows whose rows these are');
  t.equal(
    groups.fields.find((field) => field.name === 'owner').type,
    'reference',
    'and can offer a row picker rather than a free-text box'
  );

  t.equal(users.ownedBy, null, 'nothing owns a user');
});
