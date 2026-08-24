import t from 'tap';

import '../helper.js';
import { getModel } from '../../server/db/models/index.js';

t.test('a model table is generated from its field declarations', async (t) => {
  const ddl = getModel('users').tableDdl();

  t.match(ddl, /CREATE TABLE IF NOT EXISTS users/, 'idempotent create');
  t.match(ddl, /id SERIAL PRIMARY KEY/);
  t.match(ddl, /uuid UUID NOT NULL UNIQUE/, 'every table carries a global identifier');
  t.match(ddl, /email VARCHAR\(255\) NOT NULL UNIQUE/, 'required + unique become constraints');
  t.match(ddl, /first_name VARCHAR\(255\) NOT NULL/);
  t.match(ddl, /last_name VARCHAR\(255\)/);
  t.notMatch(ddl, /last_name VARCHAR\(255\) NOT NULL/, 'last name is optional');
  t.notMatch(ddl, /^\s+name VARCHAR/m, 'the combined name column is gone');
  t.match(ddl, /password_hash TEXT NOT NULL/, 'the password column, not "password"');
  t.match(ddl, /is_active BOOLEAN DEFAULT TRUE/, 'declared default becomes a SQL default');
  t.match(ddl, /created_at TIMESTAMP WITH TIME ZONE/);
  t.match(ddl, /updated_at TIMESTAMP WITH TIME ZONE/);
  t.notMatch(ddl, /\brole\b/, 'no legacy role column');
  t.notMatch(ddl, /permissions/, 'no per-user permissions column');
});

t.test('roles table carries the system flag', async (t) => {
  const ddl = getModel('roles').tableDdl();
  t.match(ddl, /name VARCHAR\(255\) NOT NULL UNIQUE/);
  t.match(ddl, /description TEXT/);
  t.match(ddl, /is_system BOOLEAN DEFAULT FALSE/);
});

t.test('schema() covers the base table and every side table', async (t) => {
  const statements = getModel('user_groups').schema();

  t.equal(statements.length, 2, 'one table of its own, one for the members relation');
  t.match(statements[0], /CREATE TABLE IF NOT EXISTS user_groups/, 'the base table comes first');
  t.match(statements[1], /CREATE TABLE IF NOT EXISTS user_group_users/);

  t.same(getModel('roles').schema().length, 2, 'the permission set is a side table too');
});

t.test('a reference field becomes a foreign key column', async (t) => {
  const ddl = getModel('user_groups').tableDdl();

  t.match(
    ddl,
    /owner_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/,
    'the owner is a key into users, not a loose integer'
  );
  t.match(ddl, /uuid UUID NOT NULL UNIQUE/);
  t.notMatch(ddl, /\bcreated \b/, 'created_at is the creation time; there is no second one');
});

t.test('a self-referential key resolves to its own table', async (t) => {
  const ddl = getModel('user_messages').tableDdl();

  t.match(
    ddl,
    /reply_to_id INTEGER REFERENCES user_messages\(id\) ON DELETE SET NULL/,
    'nullable, and the reply survives the message it answered'
  );
  t.notMatch(ddl, /reply_to_id[^,]*NOT NULL/, 'most messages answer nothing');
  t.match(ddl, /owner_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/,
    'while the keys a message cannot do without still cascade');
});

t.test('the uuid is generated per row rather than by the database', async (t) => {
  const first = getModel('users').generatedValues();
  const second = getModel('users').generatedValues();

  t.match(first.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  t.not(first.uuid, second.uuid, 'a fresh one each time');
  t.notMatch(
    getModel('users').tableDdl(),
    /uuid UUID[^,]*DEFAULT/,
    'no SQL default, so the in-memory driver produces the same thing'
  );
});

t.test('relation side tables are generated with cascading keys', async (t) => {
  const users = getModel('users');
  const join = users.relationDdl(users.relations.roles);

  t.match(join, /CREATE TABLE IF NOT EXISTS user_roles/);
  t.match(join, /user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  t.match(join, /role_id INTEGER NOT NULL REFERENCES roles\(id\) ON DELETE CASCADE/);
  t.match(join, /PRIMARY KEY \(user_id, role_id\)/, 'a user cannot hold a role twice');

  const groups = getModel('user_groups');
  const members = groups.relationDdl(groups.relations.members);

  t.match(members, /CREATE TABLE IF NOT EXISTS user_group_users/);
  t.match(members, /user_group_id INTEGER NOT NULL REFERENCES user_groups\(id\) ON DELETE CASCADE/);
  t.match(members, /user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  t.match(members, /PRIMARY KEY \(user_group_id, user_id\)/, 'membership is a set');

  const roles = getModel('roles');
  const perms = roles.relationDdl(roles.relations.permissions);

  t.match(perms, /CREATE TABLE IF NOT EXISTS role_permissions/);
  t.match(perms, /role_id INTEGER NOT NULL REFERENCES roles\(id\) ON DELETE CASCADE/);
  t.match(perms, /model VARCHAR\(64\) NOT NULL/);
  t.match(perms, /action VARCHAR\(32\) NOT NULL/);
  t.match(perms, /scope VARCHAR\(8\) NOT NULL DEFAULT 'any'/);
  t.match(
    perms,
    /PRIMARY KEY \(role_id, model, action, scope\)/,
    'the same action may be held at both scopes'
  );
});

t.test('an ALTER for a new column adds no constraint of its own', async (t) => {
  const users = getModel('users');

  t.equal(
    users.addColumnDefinition(users.fields.email),
    'email VARCHAR(255)',
    'an existing table may already break NOT NULL or UNIQUE'
  );
  t.equal(users.addColumnDefinition(users.fields.is_active), 'is_active BOOLEAN DEFAULT TRUE');

  const groups = getModel('user_groups');
  t.equal(
    groups.addColumnDefinition(groups.fields.owner),
    'owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE',
    'the foreign key still comes along'
  );
});

t.test('a relation pointing at an unregistered model fails loudly', async (t) => {
  const users = getModel('users');
  t.throws(
    () => users.relationDdl({ ...users.relations.roles, target: 'ghosts' }),
    /targets unknown model "ghosts"/
  );
  t.throws(
    () => users.relationDdl({ ...users.relations.roles, kind: 'telepathy' }),
    /Unsupported relation kind/
  );
});
