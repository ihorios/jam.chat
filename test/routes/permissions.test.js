import t from 'tap';

import { asAdmin, asUserWith, buildTestApp, call } from '../helper.js';

// The :id routes deliberately target a row that does not exist. Authorisation
// runs before the lookup, so a 404 still proves the guard was satisfied — and
// it keeps this sweep from deleting the very admin whose session it is using.
const MODEL_ROUTES = [
  ['GET', '/api/users', 'users:read'],
  ['GET', '/api/users/9999', 'users:read'],
  ['POST', '/api/users', 'users:create'],
  ['PUT', '/api/users/9999', 'users:update'],
  ['DELETE', '/api/users/9999', 'users:delete'],
  ['GET', '/api/roles', 'roles:read'],
  ['GET', '/api/roles/9999', 'roles:read'],
  ['POST', '/api/roles', 'roles:create'],
  ['PUT', '/api/roles/9999', 'roles:update'],
  ['DELETE', '/api/roles/9999', 'roles:delete'],
  ['GET', '/api/user_groups', 'user_groups:read'],
  ['GET', '/api/user_groups/9999', 'user_groups:read'],
  ['POST', '/api/user_groups', 'user_groups:create'],
  ['PUT', '/api/user_groups/9999', 'user_groups:update'],
  ['DELETE', '/api/user_groups/9999', 'user_groups:delete'],
  ['GET', '/api/user_messages', 'user_messages:read'],
  ['GET', '/api/user_messages/9999', 'user_messages:read'],
  ['POST', '/api/user_messages', 'user_messages:create'],
  ['PUT', '/api/user_messages/9999', 'user_messages:update'],
  ['DELETE', '/api/user_messages/9999', 'user_messages:delete'],
];

t.test('every model route rejects an anonymous caller', async (t) => {
  const app = await buildTestApp(t);

  for (const [method, url] of MODEL_ROUTES) {
    const [status, body] = await call(app, method, url, {});
    t.equal(status, 401, `${method} ${url} requires a session`);
    t.equal(body.ok, false);
    t.notMatch(JSON.stringify(body), /email|admin@/, 'and leaks no data while refusing');
  }
});

t.test('a session without the permission gets 403, not 401', async (t) => {
  const { app, cookies: adminCookies } = await asAdmin(t);
  // Can read users and nothing else.
  const reader = await asUserWith(t, app, adminCookies, ['users:read'], '-reader');

  t.equal((await reader.call('GET', '/api/users'))[0], 200, 'the granted permission works');

  const denied = [
    ['POST', '/api/users', { email: 'x@y.z', first_name: 'A', last_name: 'B', password: 'Passw0rd!' }],
    ['PUT', '/api/users/9999', { first_name: 'Nope' }],
    ['DELETE', '/api/users/9999', undefined],
    ['GET', '/api/roles', undefined],
    ['POST', '/api/roles', { name: 'sneaky' }],
  ];

  for (const [method, url, payload] of denied) {
    const [status, body] = await reader.call(method, url, payload);
    t.equal(status, 403, `${method} ${url} is forbidden`);
    t.match(body.error, /Missing required permission/);
  }
});

t.test('each CRUD action is gated independently', async (t) => {
  const { app, cookies: adminCookies } = await asAdmin(t);
  const editor = await asUserWith(t, app, adminCookies, ['users:read', 'users:update'], '-editor');

  const [, list] = await editor.call('GET', '/api/users');
  const target = list.users.find((user) => user.email === 'admin@example.com');

  t.equal(
    (await editor.call('PUT', `/api/users/${target.id}`, { first_name: 'Renamed' }))[0],
    200,
    'update is allowed'
  );
  t.equal(
    (await editor.call('DELETE', `/api/users/${target.id}`))[0],
    403,
    'but delete is not, despite update being granted'
  );
  t.equal(
    (await editor.call('POST', '/api/users', {
      email: 'n@e.w', first_name: 'N', last_name: 'W', password: 'Passw0rd!',
    }))[0],
    403,
    'and neither is create'
  );
});

t.test('revoking a permission takes effect on the next request', async (t) => {
  const { app, cookies: adminCookies, call: adminCall } = await asAdmin(t);
  const user = await asUserWith(t, app, adminCookies, ['users:read'], '-revoked');

  t.equal((await user.call('GET', '/api/users'))[0], 200);

  const [, roles] = await adminCall('GET', '/api/roles');
  const testRole = roles.roles.find((role) => role.name === 'test-role-revoked');
  await adminCall('PUT', `/api/roles/${testRole.id}`, { permissions: [] });

  // Permissions are re-read per request, so no re-login is needed.
  const [status] = await user.call('GET', '/api/users');
  t.equal(status, 403, 'access is gone immediately');
});

t.test('the seeded admin can reach everything', async (t) => {
  const { call } = await asAdmin(t);

  for (const [method, url] of MODEL_ROUTES) {
    const [status] = await call(method, url, method === 'POST' ? {} : undefined);
    t.not(status, 401, `${method} ${url} is not an auth failure`);
    t.not(status, 403, `${method} ${url} is not a permission failure`);
  }
});
