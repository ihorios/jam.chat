import t from 'tap';

import { buildTestApp, call, login, asAdmin } from '../helper.js';

const VALID = {
  email: 'newcomer@example.com',
  first_name: 'New',
  last_name: 'Comer',
  password: 'Passw0rd!',
};

t.test('a visitor can register and is signed in immediately', async (t) => {
  const app = await buildTestApp(t);
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: VALID });

  t.equal(res.statusCode, 201);
  const { user } = res.json();
  t.equal(user.email, 'newcomer@example.com');
  t.equal(user.name, 'New Comer');
  t.equal(user.is_active, true);
  t.notMatch(res.body, /password|\$2[aby]\$/, 'no credential material comes back');

  const cookie = res.cookies.find((c) => c.name === 'session');
  t.ok(cookie, 'a session is started');
  t.equal(cookie.httpOnly, true);

  const [meStatus, me] = await call(app, 'GET', '/api/auth/me', undefined, {
    session: cookie.value,
  });
  t.equal(meStatus, 200, 'the session works right away');
  t.equal(me.user.email, VALID.email);
});

t.test('a new account gets the user role, and nothing administrative', async (t) => {
  const app = await buildTestApp(t);
  await call(app, 'POST', '/api/auth/register', VALID);
  const cookies = await login(app, { email: VALID.email, password: VALID.password });

  const [, me] = await call(app, 'GET', '/api/auth/me', undefined, cookies);
  t.same(me.user.roles.map((role) => role.name), ['user'], 'the ordinary account role');
  t.ok(me.user.permissions.includes('user_messages:create:member'), 'the messenger is usable');
  t.ok(me.user.permissions.includes('users:update:own'), 'and their own profile is editable');

  // What the role deliberately does not carry: anything that administers
  // somebody else. Reading users is part of using the messenger; writing them
  // is not, and roles are not readable at all.
  t.notOk(me.user.permissions.includes('users:update'), 'no unscoped write over users');
  t.notOk(me.user.permissions.includes('users:delete'), 'and no delete');
  t.equal((await call(app, 'GET', '/api/roles', undefined, cookies))[0], 403, 'roles stay closed');
  t.equal((await call(app, 'GET', '/api/meta', undefined, cookies))[0], 200, 'meta is readable');
});

t.test('a new account has an unconfirmed address', async (t) => {
  const app = await buildTestApp(t);
  const [status, body] = await call(app, 'POST', '/api/auth/register', VALID);

  t.equal(status, 201);
  t.equal(body.user.email_confirmed, false, 'a typed address proves nothing');
  t.equal(body.user.logo, null, 'and there is no picture to start with');
});

t.test('registration cannot declare its own address confirmed', async (t) => {
  const app = await buildTestApp(t);
  const [status, body] = await call(app, 'POST', '/api/auth/register', {
    ...VALID,
    email: 'liar@example.com',
    email_confirmed: true,
  });

  t.equal(status, 201, 'the account is still created');
  t.equal(body.user.email_confirmed, false, 'the claim in the body is ignored');
});

t.test('registration cannot be used to grant yourself anything', async (t) => {
  const { app, call: adminCall } = await asAdmin(t);
  const [, roles] = await adminCall('GET', '/api/roles');
  const adminRole = roles.roles.find((role) => role.name === 'admin');

  // The route destructures a fixed set of fields, so these are simply ignored.
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      ...VALID,
      email: 'sneaky@example.com',
      roles: [adminRole.id],
      is_active: true,
      permissions: ['users:delete'],
    },
  });

  t.equal(res.statusCode, 201, 'the account is still created');
  t.same(
    res.json().user.roles.map((role) => role.name),
    ['user'],
    'it holds the default role and not the one it asked for'
  );
  t.notOk(res.json().user.permissions.includes('users:delete'), 'no permissions came with it');
});

t.test('registration validates its fields', async (t) => {
  const app = await buildTestApp(t);

  const cases = [
    ['no email', { ...VALID, email: undefined }, /Email Address is required/],
    ['no first name', { ...VALID, first_name: undefined }, /First Name is required/],
    ['no password', { ...VALID, password: undefined }, /Password is required/],
    ['empty body', {}, /required/],
  ];

  for (const [label, payload, expected] of cases) {
    const [status, body] = await call(app, 'POST', '/api/auth/register', payload);
    t.equal(status, 400, `${label} is rejected`);
    t.match(body.error, expected);
  }
});

t.test('last name is optional', async (t) => {
  const app = await buildTestApp(t);

  const [status, body] = await call(app, 'POST', '/api/auth/register', {
    email: 'mononym@example.com',
    first_name: 'Prince',
    password: 'Passw0rd!',
  });

  t.equal(status, 201);
  t.equal(body.user.last_name, null);
  t.equal(body.user.name, 'Prince', 'the derived name copes with only one part');
});

t.test('the password policy is enforced by the server, not just the form', async (t) => {
  const app = await buildTestApp(t);

  const weak = [
    ['too short', 'Ab1!', /at least 8 characters/],
    ['no digit', 'Password!', /a digit/],
    ['no special character', 'Password1', /a special character/],
    ['no letter', '12345678!', /a letter/],
    ['digits only', '12345678', /a letter.*a special character/],
    ['empty', '', /Password is required/],
  ];

  for (const [label, password, expected] of weak) {
    const [status, body] = await call(app, 'POST', '/api/auth/register', {
      ...VALID,
      email: `weak-${label.replace(/\W+/g, '')}@example.com`,
      password,
    });
    t.equal(status, 400, `${label} is rejected`);
    t.match(body.error, expected, `${label} says what is missing`);
  }

  t.equal(
    (await call(app, 'POST', '/api/auth/register', VALID))[0],
    201,
    'a compliant password is accepted'
  );
});

t.test('the same policy applies to admin-created users and password changes', async (t) => {
  const { call } = await asAdmin(t);

  const [weakCreate, weakBody] = await call('POST', '/api/users', {
    email: 'weakling@example.com',
    first_name: 'Weak',
    password: 'abc',
  });
  t.equal(weakCreate, 400, 'an admin cannot create a weak password either');
  t.match(weakBody.error, /Password needs/);

  const [, created] = await call('POST', '/api/users', {
    email: 'strong@example.com',
    first_name: 'Strong',
    password: 'Passw0rd!',
  });
  t.equal(
    (await call('PUT', `/api/users/${created.user.id}`, { password: 'weak' }))[0],
    400,
    'nor change one to a weak value'
  );
});

t.test('a duplicate email is refused', async (t) => {
  const app = await buildTestApp(t);
  await call(app, 'POST', '/api/auth/register', VALID);

  const [status, body] = await call(app, 'POST', '/api/auth/register', VALID);
  t.equal(status, 400);
  t.match(body.error, /already exists/);
});

t.test('a registered account can sign in normally afterwards', async (t) => {
  const app = await buildTestApp(t);
  await call(app, 'POST', '/api/auth/register', VALID);

  const [status] = await call(app, 'POST', '/api/auth/login', {
    email: VALID.email.toUpperCase(),
    password: VALID.password,
  });
  t.equal(status, 200, 'including case-insensitively on the email');
});
