import t from 'tap';

// Set before helper.js loads the server: config/env.js freezes itself at import
// time. The helper is imported dynamically because a static import would be
// hoisted above these lines — as in test/routes/ice.test.js.
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.LOGIN_RATE_LIMIT_MAX = '3';
process.env.LOGIN_RATE_LIMIT_WINDOW_SECONDS = '60';
process.env.REGISTER_RATE_LIMIT_MAX = '2';
process.env.UPLOAD_RATE_LIMIT_MAX = '2';
process.env.API_RATE_LIMIT_MAX = '1000';

const { buildTestApp, asAdmin, asUserWith, call, upload, ADMIN } = await import('../helper.js');
const { createMemoryRateLimiter } = await import('../../server/rate-limit/index.js');

t.test('the counter allows a burst, then refuses, then forgets', async (t) => {
  const limiter = createMemoryRateLimiter();
  t.after(() => limiter.close());

  const policy = { limit: 3, windowSeconds: 60 };

  for (const expected of [2, 1, 0]) {
    const { allowed, remaining } = await limiter.hit('a', policy);
    t.ok(allowed, 'within the allowance');
    t.equal(remaining, expected, 'and says how much is left');
  }

  const refused = await limiter.hit('a', policy);
  t.notOk(refused.allowed, 'the fourth is refused');
  t.ok(refused.retryAfter > 0 && refused.retryAfter <= 60, 'with a wait a client can act on');

  const other = await limiter.hit('b', policy);
  t.ok(other.allowed, 'a different caller has their own allowance');

  await limiter.reset('a');
  t.ok((await limiter.hit('a', policy)).allowed, 'and a reset starts them over');
});

t.test('a window that has run out starts again', async (t) => {
  const limiter = createMemoryRateLimiter();
  t.after(() => limiter.close());

  const policy = { limit: 1, windowSeconds: 1 };

  t.ok((await limiter.hit('x', policy)).allowed);
  t.notOk((await limiter.hit('x', policy)).allowed, 'spent');

  await new Promise((resolve) => setTimeout(resolve, 1100));
  t.ok((await limiter.hit('x', policy)).allowed, 'the next window is a fresh allowance');
});

t.test('guessing a password is refused before the guesses run out', async (t) => {
  const app = await buildTestApp(t);
  const wrong = { email: ADMIN.email, password: 'not-the-password' };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const [status] = await call(app, 'POST', '/api/auth/login', wrong);
    t.equal(status, 401, `attempt ${attempt} is answered, wrongly but answered`);
  }

  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: wrong });
  t.equal(res.statusCode, 429, 'the fourth is not even tried');
  t.match(res.json().error, /Too many requests/);
  t.ok(Number(res.headers['retry-after']) > 0, 'and says when to come back');

  // The refusal covers the right password too — that is the point, since an
  // attacker's next guess might be right.
  const [correct] = await call(app, 'POST', '/api/auth/login', ADMIN);
  t.equal(correct, 429, 'no way past it by guessing correctly');
});

t.test('signing in successfully clears the count', async (t) => {
  const app = await buildTestApp(t);

  for (let attempt = 1; attempt <= 2; attempt++) {
    await call(app, 'POST', '/api/auth/login', { email: ADMIN.email, password: 'wrong' });
  }

  const [ok] = await call(app, 'POST', '/api/auth/login', ADMIN);
  t.equal(ok, 200, 'two typos and then the right password is fine');

  // Two failures again: without the reset, this pair would exhaust the three.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const [status] = await call(app, 'POST', '/api/auth/login', {
      email: ADMIN.email, password: 'wrong',
    });
    t.equal(status, 401, 'and the allowance really did start over');
  }
});

t.test('registration is limited harder than logging in', async (t) => {
  const app = await buildTestApp(t);

  const register = (n) => call(app, 'POST', '/api/auth/register', {
    email: `flood${n}@example.com`,
    first_name: 'Flood',
    password: 'Testpass1!',
  });

  t.equal((await register(1))[0], 201);
  t.equal((await register(2))[0], 201);

  const [status, body] = await register(3);
  t.equal(status, 429, 'a third account from one address is a script');
  t.match(body.error, /Too many requests/);
});

t.test('uploads are counted per account, not per address', async (t) => {
  const admin = await asAdmin(t);

  const send = (cookies, name) => admin.app.inject({
    method: 'POST',
    url: '/api/files',
    cookies,
    ...upload([{ name, body: 'a small file' }]),
  });

  t.equal((await send(admin.cookies, 'one.txt')).statusCode, 201);
  t.equal((await send(admin.cookies, 'two.txt')).statusCode, 201);

  const refused = await send(admin.cookies, 'three.txt');
  t.equal(refused.statusCode, 429, 'the allowance is spent');

  // Somebody else behind the same address is unaffected: everyone in one
  // office shares an address, and must not share one allowance. Two sessions
  // of the *same* person do share it, which is the point of counting the
  // account rather than the cookie.
  const other = await asUserWith(t, admin.app, admin.cookies, ['files:create:own'], '-rl');
  t.equal(
    (await send(other.cookies, 'theirs.txt')).statusCode,
    201,
    'and has an allowance of their own'
  );
});
