import t from 'tap';

import { asAdmin, asUserWith, call, login } from '../helper.js';

/**
 * users:update:own — an account editing itself.
 *
 * The permission is only safe because the users model marks roles, email,
 * password and is_active as privileged, and crud.js strips those from a scoped
 * write. Every one of those is checked here: without that stripping, this
 * permission is a self-service route to administrator.
 */

const CREDENTIALS = { email: 'test@example.com', password: 'Testpass1!' };

/** A signed-in account holding exactly what the default `user` role grants. */
async function asOrdinaryUser(t) {
  const admin = await asAdmin(t);
  const me = await asUserWith(t, admin.app, admin.cookies, ['users:read', 'users:update:own']);

  const [, body] = await me.call('GET', '/api/auth/me');
  return { app: admin.app, admin, me, id: body.user.id };
}

t.test('a user may change their own name and language', async (t) => {
  const { me, id } = await asOrdinaryUser(t);

  const [status, body] = await me.call('PUT', `/api/users/${id}`, {
    first_name: 'Ada',
    last_name: 'Lovelace',
    language: 'uk',
  });

  t.equal(status, 200);
  t.equal(body.user.first_name, 'Ada');
  t.equal(body.user.last_name, 'Lovelace');
  t.equal(body.user.language, 'uk');
  t.equal(body.user.name, 'Ada Lovelace', 'the derived name follows');
});

t.test('a user cannot grant themselves a role', async (t) => {
  const { admin, me, id } = await asOrdinaryUser(t);

  const [, roles] = await admin.call('GET', '/api/roles');
  const adminRole = roles.roles.find((role) => role.name === 'admin');

  // The permission check passes — it really is their own row. Only the
  // privileged-field stripping stands between this and an administrator.
  const [status, body] = await me.call('PUT', `/api/users/${id}`, {
    first_name: 'Ada',
    roles: [adminRole.id],
  });

  t.equal(status, 200, 'the request succeeds');
  t.same(body.user.roles.map((role) => role.name), ['test-role'], 'but the roles are untouched');
  t.notOk(body.user.permissions.includes('users:delete'), 'no administrator permissions');
});

t.test('a user cannot change their own email or active flag', async (t) => {
  const { me, id } = await asOrdinaryUser(t);

  const [status, body] = await me.call('PUT', `/api/users/${id}`, {
    email: 'somebody-else@example.com',
    is_active: false,
  });

  t.equal(status, 200);
  t.equal(body.user.email, CREDENTIALS.email, 'the sign-in address is unchanged');
  t.equal(body.user.is_active, true, 'the account cannot disable itself');
});

t.test('a user may set their own logo, but not confirm their own address', async (t) => {
  const { me, id } = await asOrdinaryUser(t);

  const [status, body] = await me.call('PUT', `/api/users/${id}`, {
    logo: 'https://example.com/ada.png',
    email_confirmed: true,
  });

  t.equal(status, 200);
  t.equal(body.user.logo, 'https://example.com/ada.png', 'their own picture is theirs to set');
  t.equal(body.user.email_confirmed, false, 'saying an address is proven does not prove it');
});

t.test('a logo has to be a picture URL', async (t) => {
  const { me, id } = await asOrdinaryUser(t);

  // It ends up in an <img src> wherever this person appears, so the model is
  // what stops a script getting there — not each place that renders it.
  for (const logo of ['javascript:alert(1)', 'data:text/html,<script>', 'not a url']) {
    const [status, body] = await me.call('PUT', `/api/users/${id}`, { logo });
    t.equal(status, 400, `${logo} is refused`);
    t.match(body.error, /Logo/);
  }

  const [cleared, body] = await me.call('PUT', `/api/users/${id}`, { logo: '' });
  t.equal(cleared, 200, 'and clearing it is allowed');
  t.equal(body.user.logo, null);
});

t.test('a user cannot change their own password this way', async (t) => {
  const { app, me, id } = await asOrdinaryUser(t);

  await me.call('PUT', `/api/users/${id}`, { password: 'Hijacked1!' });

  const [attempted] = await call(app, 'POST', '/api/auth/login', {
    email: CREDENTIALS.email,
    password: 'Hijacked1!',
  });
  t.equal(attempted, 401, 'the new password was never set');

  const [original] = await call(app, 'POST', '/api/auth/login', CREDENTIALS);
  t.equal(original, 200, 'and the old one still works');
});

t.test('a user still cannot edit somebody else', async (t) => {
  const { admin, me } = await asOrdinaryUser(t);

  const [, created] = await admin.call('POST', '/api/users', {
    email: 'victim@example.com',
    first_name: 'Victim',
    password: 'Victim123!',
  });

  const [status] = await me.call('PUT', `/api/users/${created.user.id}`, { first_name: 'Owned' });
  // Reported as missing rather than forbidden: the response says nothing about
  // what exists outside the caller's scope.
  t.equal(status, 404);
});

t.test('the default user role carries the permission', async (t) => {
  const admin = await asAdmin(t);

  const [, body] = await admin.call('GET', '/api/roles');
  const role = body.roles.find((entry) => entry.name === 'user');

  t.ok(role.permissions.includes('users:update:own'), 'an ordinary account may edit itself');
  t.notOk(role.permissions.includes('users:update'), 'and nobody else');
});

t.test('an unrelated update leaves the password alone', async (t) => {
  const { app, me, id } = await asOrdinaryUser(t);

  // password is a required field on the model; a partial update that never
  // mentions it must leave the stored hash alone rather than blank it.
  await me.call('PUT', `/api/users/${id}`, { first_name: 'Ada' });

  const session = await login(app, CREDENTIALS);
  t.ok(session.session, 'the password survived an unrelated update');
});
