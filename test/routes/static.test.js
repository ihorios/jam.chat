import t from 'tap';

import { buildTestApp, call } from '../helper.js';

t.test('unknown API paths are a JSON 404, not the SPA shell', async (t) => {
  const app = await buildTestApp(t);

  for (const url of ['/api/nope', '/api/users/1/extra', '/api/ghosts']) {
    const [status, body] = await call(app, 'GET', url);
    t.equal(status, 404, `${url} is a miss`);
    t.same(body, { ok: false, error: 'Route not found' });
  }
});

t.test('unknown page paths fall through to index.html for client routing', async (t) => {
  const app = await buildTestApp(t);

  for (const url of ['/admin/users', '/admin/roles', '/deep/unknown/route']) {
    const res = await app.inject({ method: 'GET', url });
    t.equal(res.statusCode, 200, `${url} serves the SPA`);
    t.match(res.body, /<div id="root">/, 'the React mount point is present');
  }
});

t.test('only the build directory is exposed, never the project', async (t) => {
  const app = await buildTestApp(t);

  // Each of these exists in the project root. None may ever be readable over
  // HTTP: the server serves config.staticDir and nothing above it.
  for (const url of ['/.env', '/package.json', '/vite.config.js', '/server/config/env.js']) {
    const res = await app.inject({ method: 'GET', url });
    t.notMatch(res.body, /DB_STRING|dependencies|defineConfig|loadEnvFile/, `${url} is not served`);
    // They name a file, so they get a plain 404 rather than the SPA shell.
    t.equal(res.statusCode, 404, `${url} is an explicit miss`);
  }

  // Path traversal out of the static root must not reach it either.
  for (const url of ['/../.env', '/..%2f.env', '/%2e%2e/.env']) {
    const res = await app.inject({ method: 'GET', url });
    t.notMatch(res.body, /DB_STRING/, `${url} does not escape the static root`);
  }
});

t.test('a missing asset is a 404, never the HTML shell', async (t) => {
  const app = await buildTestApp(t);

  // Handing index.html to a request for a missing script is what turns a
  // build/HTML mismatch into a silently blank page.
  for (const url of ['/assets/index-OLDHASH.js', '/assets/gone.css', '/logo.png']) {
    const res = await app.inject({ method: 'GET', url });
    t.equal(res.statusCode, 404, `${url} is a real miss`);
    t.notMatch(res.body, /<div id="root">/, 'and is not the SPA shell');
  }

  // Extensionless paths are still client routes and must keep falling through.
  const page = await app.inject({ method: 'GET', url: '/dashboard/users' });
  t.equal(page.statusCode, 200);
  t.match(page.body, /<div id="root">/);
});

t.test('methods with no matching route still 404 as JSON under /api', async (t) => {
  const app = await buildTestApp(t);

  // /api/permissions is read-only, so a write is not a route.
  const [status, body] = await call(app, 'POST', '/api/permissions', {});
  t.equal(status, 404);
  t.equal(body.ok, false);
});
