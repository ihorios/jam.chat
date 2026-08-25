import t from 'tap';

import { buildTestApp, call, login, asAdmin, ADMIN } from '../helper.js';

t.test('POST /api/auth/login with valid credentials', async (t) => {
  const app = await buildTestApp(t);
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });

  t.equal(res.statusCode, 200);
  t.equal(res.json().user.email, ADMIN.email);
  t.notMatch(res.body, /password|\$2[aby]\$/, 'the response carries no credential material');

  const cookie = res.cookies.find((c) => c.name === 'session');
  t.ok(cookie, 'a session cookie is set');
  t.equal(cookie.httpOnly, true, 'not readable from JavaScript');
  t.equal(cookie.sameSite, 'Lax');
  t.equal(cookie.path, '/');
  t.notMatch(cookie.value, /^\d+$/, 'the id is signed, not bare');
});

t.test('email is matched case-insensitively', async (t) => {
  const app = await buildTestApp(t);
  const [status] = await call(app, 'POST', '/api/auth/login', {
    email: 'ADMIN@Example.COM',
    password: ADMIN.password,
  });
  t.equal(status, 200);
});

t.test('POST /api/auth/login rejects bad credentials', async (t) => {
  const app = await buildTestApp(t);

  const cases = [
    ['wrong password', { email: ADMIN.email, password: 'nope' }],
    ['unknown email', { email: 'ghost@example.com', password: 'Admin123!' }],
    ['empty payload', {}],
    ['null password', { email: ADMIN.email, password: null }],
  ];

  for (const [label, payload] of cases) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
    t.equal(res.statusCode, 401, `${label} is rejected`);
    t.equal(
      res.json().error,
      'Invalid email or password',
      'the same message either way, so registered emails are not disclosed'
    );
    t.notOk(res.cookies.find((c) => c.name === 'session')?.value, 'no session is issued');
  }
});

t.test('GET /api/auth/me reflects the session', async (t) => {
  const app = await buildTestApp(t);

  const [anon, anonBody] = await call(app, 'GET', '/api/auth/me');
  t.equal(anon, 401, 'no session, no identity');
  t.equal(anonBody.ok, false);

  const cookies = await login(app);
  const [status, body] = await call(app, 'GET', '/api/auth/me', undefined, cookies);
  t.equal(status, 200);
  t.equal(body.user.email, ADMIN.email);
  t.equal(body.user.name, 'System Admin');
  t.equal(body.user.permissions.length, 36, 'permissions travel with the identity');
});

t.test('a forged or corrupted cookie is refused', async (t) => {
  const app = await buildTestApp(t);
  const real = await login(app);

  const forged = [
    ['bare id', { session: '1' }],
    ['tampered signature', { session: `${real.session.split('.')[0]}.deadbeef` }],
    ['nonsense', { session: 'not-a-cookie' }],
  ];

  for (const [label, cookies] of forged) {
    const [status] = await call(app, 'GET', '/api/auth/me', undefined, cookies);
    t.equal(status, 401, `${label} is refused`);
  }
});

t.test('POST /api/auth/logout clears the session', async (t) => {
  const app = await buildTestApp(t);
  const cookies = await login(app);

  const res = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies });
  t.equal(res.statusCode, 200);

  const cleared = res.cookies.find((c) => c.name === 'session');
  t.equal(cleared.value, '', 'the cookie is emptied');
});

t.test('a deactivated account loses access immediately', async (t) => {
  const { app, call: adminCall } = await asAdmin(t);

  const credentials = { email: 'temp@example.com', password: 'Temppass1!' };
  const [, created] = await adminCall('POST', '/api/users', {
    ...credentials,
    first_name: 'Temp',
    last_name: 'User',
  });

  const cookies = await login(app, credentials);
  t.equal((await call(app, 'GET', '/api/auth/me', undefined, cookies))[0], 200, 'works at first');

  await adminCall('PUT', `/api/users/${created.user.id}`, { is_active: false });

  // The session is re-checked against the database on every request rather
  // than trusted from the cookie, so this takes effect without re-login.
  const [status, body] = await call(app, 'GET', '/api/auth/me', undefined, cookies);
  t.equal(status, 403, 'the existing session stops working');
  t.match(body.error, /disabled/);

  const [loginStatus] = await call(app, 'POST', '/api/auth/login', credentials);
  t.equal(loginStatus, 403, 'and they cannot log back in');
});

t.test('a deleted account loses access immediately', async (t) => {
  const { app, call: adminCall } = await asAdmin(t);

  const credentials = { email: 'doomed@example.com', password: 'Doomedpass1!' };
  const [, created] = await adminCall('POST', '/api/users', {
    ...credentials,
    first_name: 'Doomed',
    last_name: 'User',
  });

  const cookies = await login(app, credentials);
  await adminCall('DELETE', `/api/users/${created.user.id}`);

  const [status] = await call(app, 'GET', '/api/auth/me', undefined, cookies);
  t.equal(status, 401, 'the orphaned session is refused');
});

t.test('a password change is honoured by the login route', async (t) => {
  const { app, call: adminCall } = await asAdmin(t);

  const credentials = { email: 'rotate@example.com', password: 'Original1!' };
  const [, created] = await adminCall('POST', '/api/users', {
    ...credentials,
    first_name: 'Rot',
    last_name: 'Ate',
  });

  t.equal((await call(app, 'POST', '/api/auth/login', credentials))[0], 200);

  await adminCall('PUT', `/api/users/${created.user.id}`, { password: 'Replacement1!' });

  t.equal((await call(app, 'POST', '/api/auth/login', credentials))[0], 401, 'old password fails');
  t.equal(
    (await call(app, 'POST', '/api/auth/login', { ...credentials, password: 'Replacement1!' }))[0],
    200,
    'new password works'
  );
});
