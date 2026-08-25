import t from 'tap';

import { asAdmin } from '../helper.js';

t.test('GET /api/roles returns the seeded roles', async (t) => {
  const { call } = await asAdmin(t);
  const [status, body] = await call('GET', '/api/roles');

  t.equal(status, 200);
  t.equal(body.count, 3);
  t.same(body.roles.map((role) => role.name).sort(), ['admin', 'moderator', 'user']);

  const admin = body.roles.find((role) => role.name === 'admin');
  t.equal(admin.is_system, true, 'admin is protected');
  t.equal(admin.permissions.length, 36, 'and holds the full catalog');
  t.ok(
    admin.permissions.includes('user_groups:read'),
    'unscoped, so an administrator sees every group and not only their own'
  );

  const moderator = body.roles.find((role) => role.name === 'moderator');
  t.equal(moderator.is_system, false, 'the starter roles stay editable');
  t.same(moderator.permissions, ['roles:read', 'users:read', 'users:update']);
});

t.test('GET /api/roles/:id', async (t) => {
  const { call } = await asAdmin(t);
  const [, list] = await call('GET', '/api/roles');
  const target = list.roles[0];

  const [status, body] = await call('GET', `/api/roles/${target.id}`);
  t.equal(status, 200);
  t.equal(body.role.name, target.name);

  const [missing, missingBody] = await call('GET', '/api/roles/9999');
  t.equal(missing, 404);
  t.same(missingBody, { ok: false, error: 'Role not found' });
});

t.test('POST /api/roles', async (t) => {
  const { call } = await asAdmin(t);

  const [status, body] = await call('POST', '/api/roles', {
    name: 'reviewer',
    description: 'Reviews content',
    permissions: ['users:read', 'users:update'],
  });

  t.equal(status, 201);
  t.equal(body.role.name, 'reviewer');
  t.equal(body.role.is_system, false, 'new roles are never system roles by default');
  t.same(body.role.permissions, ['users:read', 'users:update']);

  t.equal((await call('GET', '/api/roles'))[1].count, 4);
});

t.test('POST /api/roles rejects bad input', async (t) => {
  const { call } = await asAdmin(t);

  const cases = [
    [{ description: 'nameless' }, /Role Name is required/],
    [{ name: 'admin' }, /already exists/],
    [{ name: 'bad', permissions: ['ghosts:haunt'] }, /Unknown permission\(s\): ghosts:haunt/],
    [{ name: 'bad', permissions: ['users:write'] }, /Unknown permission\(s\): users:write/],
    [{ name: 'bad', permissions: ['users:read:own'] }, /Unknown permission\(s\): users:read:own/],
    [{ name: 'bad', permissions: 'users:read' }, /must be an array/],
  ];

  for (const [payload, expected] of cases) {
    const [status, body] = await call('POST', '/api/roles', payload);
    t.equal(status, 400, `${JSON.stringify(payload)} is rejected`);
    t.match(body.error, expected);
  }
});

t.test('PUT /api/roles/:id changes what a role grants', async (t) => {
  const { call } = await asAdmin(t);
  const [, created] = await call('POST', '/api/roles', {
    name: 'temp',
    permissions: ['users:read'],
  });
  const id = created.role.id;

  const [status, body] = await call('PUT', `/api/roles/${id}`, {
    permissions: ['roles:read', 'roles:update'],
  });
  t.equal(status, 200);
  t.same(body.role.permissions, ['roles:read', 'roles:update'], 'replaced, not merged');
  t.equal(body.role.name, 'temp', 'untouched fields survive');

  const [, renamed] = await call('PUT', `/api/roles/${id}`, { description: 'Renamed' });
  t.equal(renamed.role.description, 'Renamed');
  t.same(renamed.role.permissions, ['roles:read', 'roles:update'], 'untouched grants survive');

  t.equal((await call('PUT', '/api/roles/9999', { name: 'x' }))[0], 404);
  t.equal((await call('PUT', `/api/roles/${id}`, { permissions: ['nope:read'] }))[0], 400);
});

t.test('changing a role changes its holders permissions', async (t) => {
  const { call } = await asAdmin(t);
  const [, role] = await call('POST', '/api/roles', {
    name: 'shifting',
    permissions: ['users:read'],
  });
  const [, user] = await call('POST', '/api/users', {
    email: 'holder@example.com',
    first_name: 'Hold',
    last_name: 'Er',
    password: 'Passw0rd!',
    roles: [role.role.id],
  });
  t.same(user.user.permissions, ['users:read']);

  await call('PUT', `/api/roles/${role.role.id}`, {
    permissions: ['users:read', 'users:delete'],
  });

  const [, refreshed] = await call('GET', `/api/users/${user.user.id}`);
  t.same(refreshed.user.permissions, ['users:delete', 'users:read'], 'derived on every read');
});

t.test('DELETE /api/roles/:id', async (t) => {
  const { call } = await asAdmin(t);
  const [, list] = await call('GET', '/api/roles');
  const admin = list.roles.find((role) => role.name === 'admin');
  const moderator = list.roles.find((role) => role.name === 'moderator');

  const [blocked, blockedBody] = await call('DELETE', `/api/roles/${admin.id}`);
  t.equal(blocked, 400, 'system roles are protected');
  t.match(blockedBody.error, /system role and cannot be deleted/);

  const [ok] = await call('DELETE', `/api/roles/${moderator.id}`);
  t.equal(ok, 200);
  t.equal((await call('DELETE', `/api/roles/${moderator.id}`))[0], 404, 'already gone');
  t.equal((await call('GET', '/api/roles'))[1].count, 2);
});
