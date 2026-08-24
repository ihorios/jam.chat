import t from 'tap';

import { asAdmin } from '../helper.js';

/** The seeded roles, keyed by name. */
async function seededRoles(call) {
  const [, body] = await call('GET', '/api/roles');
  return new Map(body.roles.map((role) => [role.name, role]));
}

t.test('GET /api/users lists the seeded admin with derived permissions', async (t) => {
  const { call } = await asAdmin(t);
  const [status, body] = await call('GET', '/api/users');

  t.equal(status, 200);
  t.equal(body.ok, true);
  t.equal(body.count, 1);

  const [admin] = body.users;
  t.equal(admin.email, 'admin@example.com');
  t.equal(admin.first_name, 'System');
  t.equal(admin.last_name, 'Admin');
  t.equal(admin.name, 'System Admin', 'full name is derived from the two fields');
  t.same(admin.roles.map((role) => role.name), ['admin']);

  // Compared against the published catalog rather than a list copied into the
  // test: "everything there is" is the actual claim, and it stays true as
  // models come and go.
  const [, catalog] = await call('GET', '/api/permissions');
  t.same(
    admin.permissions,
    [...catalog.permissions].sort(),
    'the admin role grants the whole catalog'
  );
  t.ok(admin.permissions.includes('user_messages:read'), 'unscoped, so every message');
  t.ok(
    admin.permissions.includes('user_messages:read:member'),
    'and the scoped variants are grants in their own right'
  );
});

t.test('GET /api/users never exposes credentials', async (t) => {
  const { call } = await asAdmin(t);
  const [, body] = await call('GET', '/api/users');

  const serialised = JSON.stringify(body);
  t.notMatch(serialised, /password/, 'no password field');
  t.notMatch(serialised, /Admin123/i, 'no plaintext');
  t.notMatch(serialised, /\$2[aby]\$/, 'no bcrypt hash');
});

t.test('GET /api/users/:id', async (t) => {
  const { call } = await asAdmin(t);

  const [okStatus, okBody] = await call('GET', '/api/users/1');
  t.equal(okStatus, 200);
  t.equal(okBody.user.email, 'admin@example.com');

  const [missingStatus, missingBody] = await call('GET', '/api/users/9999');
  t.equal(missingStatus, 404);
  t.same(missingBody, { ok: false, error: 'User not found' });

  const [badStatus] = await call('GET', '/api/users/not-a-number');
  t.equal(badStatus, 404, 'an unparseable id is a miss, not a crash');
});

t.test('GET /api/users?search= covers both name fields', async (t) => {
  const { call } = await asAdmin(t);
  await call('POST', '/api/users', {
    email: 'zoe@other.org', first_name: 'Zoe', last_name: 'Quinlan', password: 'Passw0rd!',
  });

  t.equal((await call('GET', '/api/users?search=zoe'))[1].count, 1, 'by first name');
  t.equal((await call('GET', '/api/users?search=quinlan'))[1].count, 1, 'by last name');
  t.equal((await call('GET', '/api/users?search=other.org'))[1].count, 1, 'by email');
  t.equal((await call('GET', '/api/users?search=ZOE'))[1].count, 1, 'case-insensitive');
  t.equal((await call('GET', '/api/users?search=nobody'))[1].count, 0);
});

t.test('POST /api/users assigns roles', async (t) => {
  const { call } = await asAdmin(t);
  const roles = await seededRoles(call);

  const [status, body] = await call('POST', '/api/users', {
    email: 'new@example.com',
    first_name: 'New',
    last_name: 'Person',
    password: 'Secret123!',
    roles: [roles.get('moderator').id],
  });

  t.equal(status, 201);
  t.equal(body.user.email, 'new@example.com');
  t.equal(body.user.name, 'New Person');
  t.equal(body.user.is_active, true);
  t.same(body.user.roles.map((role) => role.name), ['moderator']);
  t.same(body.user.permissions, ['roles:read', 'users:read', 'users:update']);

  t.equal((await call('GET', '/api/users'))[1].count, 2, 'persisted');
});

t.test('POST /api/users rejects bad input', async (t) => {
  const { call } = await asAdmin(t);

  const cases = [
    [{ first_name: 'No', last_name: 'Email', password: 'Passw0rd!' }, /Email Address is required/],
    [{ email: 'a@b.c', last_name: 'Only', password: 'Passw0rd!' }, /First Name is required/],
    [{ email: 'a@b.c', first_name: 'A', last_name: 'B' }, /Password is required/],
    [{ email: 'admin@example.com', first_name: 'C', last_name: 'D', password: 'Passw0rd!' }, /already exists/],
    [{ email: 'a@b.c', first_name: 'A', last_name: 'B', password: 'Passw0rd!', roles: 'admin' }, /must be an array/],
  ];

  for (const [payload, expected] of cases) {
    const [status, body] = await call('POST', '/api/users', payload);
    t.equal(status, 400, `${JSON.stringify(payload)} is rejected`);
    t.equal(body.ok, false);
    t.match(body.error, expected);
  }

  const [emptyStatus] = await call('POST', '/api/users');
  t.equal(emptyStatus, 400, 'a missing body is rejected, not crashed on');
});

t.test('PUT /api/users/:id', async (t) => {
  const { call } = await asAdmin(t);
  const roles = await seededRoles(call);

  const [, created] = await call('POST', '/api/users', {
    email: 'edit@example.com',
    first_name: 'Before',
    last_name: 'Change',
    password: 'Passw0rd!',
    roles: [roles.get('user').id],
  });
  const id = created.user.id;

  const [status, body] = await call('PUT', `/api/users/${id}`, { first_name: 'After' });
  t.equal(status, 200);
  t.equal(body.user.name, 'After Change');
  t.equal(body.user.email, 'edit@example.com', 'untouched fields survive');
  t.same(body.user.roles.map((r) => r.name), ['user'], 'untouched roles survive');

  const [, kept] = await call('PUT', `/api/users/${id}`, { password: '' });
  t.equal(kept.user.email, 'edit@example.com', 'a blank password is not an error');

  const [, regranted] = await call('PUT', `/api/users/${id}`, {
    roles: [roles.get('user').id, roles.get('moderator').id],
  });
  t.same(regranted.user.roles.map((r) => r.name).sort(), ['moderator', 'user']);
  t.same(regranted.user.permissions, [
    'files:create:own',
    'files:delete:own',
    'files:read:own',
    'roles:read',
    'user_groups:create:own',
    'user_groups:delete:own',
    'user_groups:read:member',
    'user_messages:create:member',
    'user_messages:delete:own',
    'user_messages:read:member',
    'user_messages:update:own',
    'users:read',
    'users:update',
    'users:update:own',
  ], 'the union of both roles, deduplicated');

  const [, stripped] = await call('PUT', `/api/users/${id}`, { roles: [] });
  t.same(stripped.user.permissions, [], 'roles can be revoked entirely');

  const [, disabled] = await call('PUT', `/api/users/${id}`, { is_active: false });
  t.equal(disabled.user.is_active, false);

  const [missing] = await call('PUT', '/api/users/9999', { first_name: 'Ghost' });
  t.equal(missing, 404);

  const [conflict, conflictBody] = await call('PUT', `/api/users/${id}`, {
    email: 'admin@example.com',
  });
  t.equal(conflict, 400);
  t.match(conflictBody.error, /already exists/);
});

t.test('an administrator decides whether an address is confirmed', async (t) => {
  const { call } = await asAdmin(t);

  const [created, body] = await call('POST', '/api/users', {
    email: 'ada@example.com',
    first_name: 'Ada',
    password: 'Testpass1!',
  });
  t.equal(created, 201);
  t.equal(body.user.email_confirmed, false, 'unconfirmed unless said otherwise');
  t.equal(body.user.logo, null);

  // The checkbox the account itself is shown but cannot use. `users:update` is
  // an unscoped write, so nothing strips it here.
  const [status, updated] = await call('PUT', `/api/users/${body.user.id}`, {
    email_confirmed: true,
    logo: 'https://example.com/ada.png',
  });

  t.equal(status, 200);
  t.equal(updated.user.email_confirmed, true, 'an administrator may confirm it by hand');
  t.equal(updated.user.logo, 'https://example.com/ada.png');

  const [, off] = await call('PUT', `/api/users/${body.user.id}`, { email_confirmed: false });
  t.equal(off.user.email_confirmed, false, 'and may take it back');
});

/**
 * The bootstrap account, which is the way back in.
 *
 * Refused in the model rather than in the panel that hides its delete button: an
 * absent button is still a request anybody can make by hand, and this one takes
 * the groups that account owns, and their conversations, with it.
 */
t.test('the first account cannot be deleted', async (t) => {
  const { call } = await asAdmin(t);

  const [, first] = await call('GET', '/api/users/1');
  t.equal(first.user.id, 1, 'user #1 is the account the installation was created with');

  const [status, body] = await call('DELETE', '/api/users/1');
  t.equal(status, 400, 'refused');
  t.match(body.error, /first account cannot be deleted/);

  t.equal((await call('GET', '/api/users/1'))[0], 200, 'and it is still there');
});

t.test('DELETE /api/users/:id', async (t) => {
  const { call } = await asAdmin(t);
  const [, created] = await call('POST', '/api/users', {
    email: 'gone@example.com',
    first_name: 'Gone',
    last_name: 'Soon',
    password: 'Passw0rd!',
  });

  const [status, body] = await call('DELETE', `/api/users/${created.user.id}`);
  t.equal(status, 200);
  t.match(body.message, /deleted successfully/);

  t.equal((await call('DELETE', `/api/users/${created.user.id}`))[0], 404, 'already gone');
  t.equal((await call('GET', '/api/users'))[1].count, 1);
});
