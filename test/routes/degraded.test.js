import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import t from 'tap';

/*
 * This one cannot use helper.js, which blanks DB_STRING on import so that the
 * rest of the suite runs on the in-memory driver. The whole point here is a
 * connection string that is set and cannot work, so the environment is built by
 * hand and the server imported dynamically afterwards — config/env.js freezes
 * itself at import time, and a static import would be hoisted above these lines.
 *
 * The address is a closed port on loopback: the attempt fails in milliseconds,
 * without a DNS lookup, and nothing leaves the machine.
 */
process.env.DB_STRING = 'postgresql://nobody:nothing@127.0.0.1:1/absent';
process.env.DATABASE_URL = '';
process.env.DB_BOOT_TIMEOUT_MS = '4000';

process.env.ADMIN_EMAIL = '';
process.env.ADMIN_PASSWORD = '';
process.env.GOOGLE_CLIENT_ID = '';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.FILE_PROVIDER = 'local';
process.env.FILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatty-degraded-'));
process.env.STATIC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'static'
);

process.on('exit', () => {
  fs.rmSync(process.env.FILE_DIR, { recursive: true, force: true });
});

const { buildApp } = await import('../../server/app.js');

/**
 * What the server does when the database it was configured with is not there.
 *
 * The answer used to be "not start", which is the worst of the options: no
 * process is left to say what went wrong, the health endpoint goes down with it,
 * and a platform that restarts on failure turns one legible error into a loop of
 * identical ones. So it starts, records the fault once, keeps serving everything
 * that does not need a database, and refuses the rest with a status that says
 * the client did nothing wrong.
 */
async function degradedApp(t) {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  await app.ready();
  return app;
}

t.test('the server starts even though the database does not', async (t) => {
  const app = await degradedApp(t);

  t.ok(app.server, 'buildApp resolved rather than throwing');
  t.notOk(app.subsystems.ok('database'), 'and the database is recorded as down');
  t.match(
    app.subsystems.report().database.error,
    /ECONNREFUSED|did not finish|connect/i,
    'with the reason kept, not just the fact'
  );
});

t.test('liveness still answers, so the platform leaves it alone', async (t) => {
  const app = await degradedApp(t);

  for (const url of ['/liveness', '/healthz']) {
    const res = await app.inject({ method: 'GET', url });
    t.equal(res.statusCode, 200, `${url} is up`);
    t.same(res.json(), { ok: 1 });
  }
});

t.test('readiness says what is wrong', async (t) => {
  const app = await degradedApp(t);

  const res = await app.inject({ method: 'GET', url: '/readyz' });
  t.equal(res.statusCode, 503, 'not ready, which is different from not alive');

  const body = res.json();
  t.equal(body.ok, false);
  t.equal(body.subsystems.database.ok, false);
  t.ok(body.subsystems.database.error, 'and names the fault');
  t.ok(body.subsystems.database.at, 'and when it was noticed');
});

t.test('the API is refused rather than half-served', async (t) => {
  const app = await degradedApp(t);

  // A read, a write, and the two routes that have no session to check — the
  // refusal has to happen before authentication, because there is nowhere to
  // look a session up.
  const attempts = [
    ['GET', '/api/users'],
    ['GET', '/api/user_groups'],
    ['POST', '/api/auth/login'],
    ['GET', '/api/messenger/unread'],
  ];

  for (const [method, url] of attempts) {
    const res = await app.inject({ method, url, payload: {} });
    t.equal(res.statusCode, 503, `${method} ${url}`);
    t.match(res.json().error, /database is unavailable/);
    t.equal(res.headers['retry-after'], '30', 'and says it is worth trying again');
  }
});

t.test('the static site is still served, so the fault is visible', async (t) => {
  const app = await degradedApp(t);

  const res = await app.inject({ method: 'GET', url: '/' });
  t.equal(res.statusCode, 200, 'the page loads');
});

t.test('nothing was written to a store that would vanish', async (t) => {
  const app = await degradedApp(t);

  /*
   * The in-memory repositories exist so that `fastify.models.users` is an object
   * rather than a crash on every route. What must not happen is anything landing
   * in them — an installation quietly serving an empty database out of RAM and
   * losing every write on restart is the failure the refusal above exists to
   * prevent, and it is what this used to do.
   */
  t.same(await app.models.users.findAll(), [], 'no users');
  t.same(await app.models.roles.findAll(), [], 'and not even the seeded roles');
});
