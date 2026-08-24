import t from 'tap';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberately does NOT use the shared helper: this file needs its own
// STATIC_DIR (one that does not exist) set before the server config is frozen.
process.env.DB_STRING = '';
process.env.DATABASE_URL = '';
process.env.STATIC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'no-such-build-directory'
);

const { buildApp } = await import('../../server/app.js');

t.test('with no build present the API still works and nothing leaks', async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  await app.ready();

  const liveness = await app.inject({ method: 'GET', url: '/liveness' });
  t.equal(liveness.statusCode, 200, 'the API is unaffected by a missing frontend');

  const users = await app.inject({ method: 'GET', url: '/api/users' });
  t.equal(users.statusCode, 401, 'model routes still route — they just need a session');

  // The old behaviour fell back to serving the project root here, which made
  // /.env readable. It must now be a plain error instead — 404 rather than
  // 503, because a path naming a file is a miss whether or not a build exists.
  const env = await app.inject({ method: 'GET', url: '/.env' });
  t.equal(env.statusCode, 404);
  t.notMatch(env.body, /DB_STRING/, 'the environment file is not served');

  const page = await app.inject({ method: 'GET', url: '/admin/users' });
  t.equal(page.statusCode, 503, 'and pages report why they cannot render');

  const missing = await app.inject({ method: 'GET', url: '/api/nope' });
  t.equal(missing.statusCode, 404, 'API 404s are still API 404s');
  t.same(missing.json(), { ok: false, error: 'Route not found' });
});
