import t from 'tap';

import { buildTestApp } from '../helper.js';
import { seed } from '../../server/db/seed.js';

/**
 * A default role created before one of its permissions existed.
 *
 * The `user` role is not kept in sync with its definition — an installation may
 * have edited it — but a row that predates a permission is missing something its
 * own description promises. The symptom is a 403 from a screen that offers to
 * save: "Missing required permission: users:update" when an ordinary account
 * edits its own profile or picture.
 */

const quiet = { info: () => {}, warn: () => {} };

t.test('a user role missing users:update:own is granted it on the next boot', async (t) => {
  const app = await buildTestApp(t);
  const roles = app.models.roles;

  const role = (await roles.findAll()).find((entry) => entry.name === 'user');
  // The state a database that predates the permission is in.
  await roles.update(role.id, {
    permissions: role.permissions.filter((p) => p !== 'users:update:own'),
  });
  t.notOk(
    (await roles.findById(role.id)).permissions.includes('users:update:own'),
    'the row is as an older installation left it'
  );

  const granted = [];
  await seed(app.models, { info: () => {}, warn: (message) => granted.push(message) });

  const after = await roles.findById(role.id);
  t.ok(after.permissions.includes('users:update:own'), 'the next boot grants it');
  t.match(granted.join(' '), /users:update:own/, 'and says so');
});

t.test('nothing else about the role is touched', async (t) => {
  const app = await buildTestApp(t);
  const roles = app.models.roles;

  const role = (await roles.findAll()).find((entry) => entry.name === 'user');
  // An installation's own edits: one permission added, one taken away. The
  // addition is deliberately not one of BACKFILL's, or it would be restored
  // whether or not an edit is respected and the assertion would prove nothing.
  await roles.update(role.id, {
    permissions: [
      ...role.permissions.filter((p) => p !== 'user_messages:delete:own'),
      'roles:read',
    ],
  });

  await seed(app.models, quiet);

  const after = await roles.findById(role.id);
  t.ok(after.permissions.includes('roles:read'), 'an addition is respected');
  t.notOk(after.permissions.includes('user_messages:delete:own'), 'and so is a removal');
});

t.test('a second boot changes nothing', async (t) => {
  const app = await buildTestApp(t);
  const roles = app.models.roles;

  const before = (await roles.findAll()).find((entry) => entry.name === 'user').permissions;
  const said = [];
  await seed(app.models, { info: () => {}, warn: (message) => said.push(message) });

  const after = (await roles.findAll()).find((entry) => entry.name === 'user').permissions;
  t.same(after, before, 'idempotent');
  t.same(said, [], 'and quiet about it');
});
