import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

// These must be set before any server module is loaded: server/config/env.js
// freezes its config at import time. Hence the dynamic imports below — static
// imports are hoisted and would run first.
process.env.DB_STRING = '';
process.env.DATABASE_URL = '';

// No seeded admin: every test app starts with no users at all, and buildTestApp
// below creates the one it logs in with. Blanked rather than deleted — the same
// trick as DB_STRING above, since config/env.js calls process.loadEnvFile() and
// a key that is absent is read straight back out of a developer's .env, while a
// key that is already set is left alone.
process.env.ADMIN_EMAIL = '';
process.env.ADMIN_PASSWORD = '';

// No Google sign-in route either, for the same reason: a developer's .env must
// never point `npm test` at a real identity provider. The verifier is tested
// directly, against a key set of its own, in test/auth/google.test.js.
process.env.GOOGLE_CLIENT_ID = '';

// Serve a fixture instead of dist/, so the static tests do not depend on
// whether `npm run build` has been run.
process.env.STATIC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'static'
);

// Attachments go to a directory of this test process's own, thrown away when
// it exits. The suite needs no bucket, no credentials and no network — the
// same principle as the in-memory database above.
//
// Forced rather than inferred, because a .env holding real credentials must
// never turn `npm test` into something that writes to somebody's storage.
// Deleting the AWS_* variables here would not do it: config/env.js calls
// process.loadEnvFile(), which reads them straight back out of the file. What
// works is FILE_PROVIDER, which is consulted before the bucket settings are —
// and which .env does not set.
process.env.FILE_PROVIDER = 'local';
process.env.FILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatty-files-'));

// Off by default: a test file logs in dozens of times from one address, which
// is exactly what the limiter is built to stop. A default rather than an
// assignment, so the tests that are *about* rate limiting can turn it on
// before importing this file without having it taken away again.
process.env.RATE_LIMIT_ENABLED ??= 'false';

process.on('exit', () => {
  fs.rmSync(process.env.FILE_DIR, { recursive: true, force: true });
});

const { buildApp } = await import('../server/app.js');
const { createRepositories } = await import('../server/db/repository.js');

export const ADMIN = { email: 'admin@example.com', password: 'Admin123!' };

// The password must satisfy PASSWORD_RULES, which every password field is
// checked against.
const ADMIN_USER = { ...ADMIN, first_name: 'System', last_name: 'Admin' };

/**
 * A booted app holding the seeded roles plus one admin user, closed
 * automatically when the test ends. Each call gets its own isolated in-memory
 * store.
 *
 * The admin is created here rather than seeded by the server: a fresh database
 * has no users at all, so tests bootstrap the account they log in with.
 */
export async function buildTestApp(t) {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  await app.ready();

  const adminRole = (await app.models.roles.findAll()).find((role) => role.name === 'admin');
  await app.models.users.create({
    ...ADMIN_USER,
    is_active: true,
    roles: adminRole ? [adminRole.id] : [],
  });

  return app;
}

/** Unseeded repositories, for exercising the model layer without HTTP. */
export function freshRepositories() {
  return createRepositories();
}

/** Convenience: inject and return [statusCode, parsedBody]. */
export async function call(app, method, url, payload, cookies) {
  const res = await app.inject({ method, url, payload, cookies });
  return [res.statusCode, res.json()];
}

/** Logs in and returns the session cookie jar for use with inject(). */
export async function login(app, credentials = ADMIN) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: credentials });
  if (res.statusCode !== 200) {
    throw new Error(`Login failed (${res.statusCode}): ${res.body}`);
  }
  const session = res.cookies.find((cookie) => cookie.name === 'session');
  return { session: session.value };
}

/**
 * An app plus a `call` already carrying an admin session — the starting point
 * for tests about anything other than authentication itself.
 */
export async function asAdmin(t) {
  const app = await buildTestApp(t);
  const cookies = await login(app);
  return {
    app,
    cookies,
    call: (method, url, payload) => call(app, method, url, payload, cookies),
    inject: (options) => app.inject({ ...options, cookies }),
  };
}

/**
 * A multipart body, for inject(). Built by hand rather than with a library:
 * the format is four lines and a boundary, and a test that builds its own
 * request says exactly what the server is being sent.
 *
 *   upload([{ name: 'notes.txt', body: 'hello' }])
 */
export function upload(files, field = 'file') {
  const boundary = '----chattytestboundary';
  const chunks = [];

  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${field}"; filename="${file.name}"\r\n`
      + `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
    ));
    chunks.push(Buffer.isBuffer(file.body) ? file.body : Buffer.from(String(file.body)));
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** The app on a real port: WebSockets cannot be injected. */
export async function listening(t) {
  const app = await buildTestApp(t);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app;
}

/**
 * A socket with a frame queue, so a test can await the frame it cares about
 * without racing the ones that arrive first.
 */
export function connect(app, cookies) {
  const { port } = app.server.address();
  const headers = cookies ? { cookie: `session=${cookies.session}` } : {};
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });

  const frames = [];
  const waiters = [];

  socket.on('message', (raw) => {
    frames.push(JSON.parse(String(raw)));
    for (const waiter of [...waiters]) {
      const index = frames.findIndex(waiter.predicate);
      if (index === -1) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frames[index]);
    }
  });

  const client = {
    socket,
    frames,
    /** Resolves with the first frame matching, past or future. */
    waitFor(predicate, label = 'a frame') {
      const match = typeof predicate === 'string'
        ? (frame) => frame.type === predicate
        : predicate;

      const found = frames.find(match);
      if (found) return Promise.resolve(found);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          3000
        );
        waiters.push({
          predicate: match,
          resolve: (frame) => { clearTimeout(timer); resolve(frame); },
        });
      });
    },
    send: (payload) => socket.send(JSON.stringify(payload)),
    close: () => new Promise((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.on('close', resolve);
      socket.close();
    }),
  };

  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve(client));
    socket.on('error', reject);
  });
}

/** Polls until the assertion holds, for state that settles asynchronously. */
export async function eventually(check, label) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * Creates a user holding a role with exactly `permissions`, and returns a
 * `call` bound to their session. For testing what a permission does NOT allow.
 */
export async function asUserWith(t, app, adminCookies, permissions, suffix = '') {
  const [, role] = await call(app, 'POST', '/api/roles', {
    name: `test-role${suffix}`,
    permissions,
  }, adminCookies);

  const credentials = { email: `test${suffix}@example.com`, password: 'Testpass1!' };
  await call(app, 'POST', '/api/users', {
    ...credentials,
    first_name: 'Test',
    last_name: 'User',
    roles: [role.role.id],
  }, adminCookies);

  const cookies = await login(app, credentials);
  return {
    cookies,
    call: (method, url, payload) => call(app, method, url, payload, cookies),
  };
}
