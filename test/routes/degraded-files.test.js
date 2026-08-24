import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import t from 'tap';

/*
 * Built by hand rather than through helper.js, for the same reason
 * degraded.test.js is: config/env.js freezes itself at import time, so the
 * environment has to be set before the server is loaded, and a static import
 * would be hoisted above these lines.
 *
 * Production, because that is the only place this rule applies: a bucket that
 * cannot be reached falls back to the disk in development, and must not in
 * production, where the disk does not survive the next deploy.
 *
 * Port 1 on loopback is closed, so the check fails in milliseconds and nothing
 * leaves the machine.
 */
process.env.NODE_ENV = 'production';
process.env.DB_STRING = '';
process.env.DATABASE_URL = '';
process.env.FILE_PROVIDER = 's3';
process.env.AWS_ENDPOINT_URL_S3 = 'http://127.0.0.1:1';
process.env.S3_BUCKET = 'absent-bucket';
process.env.AWS_ACCESS_KEY_ID = 'test-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
process.env.S3_TIMEOUT_MS = '2000';
process.env.FILE_BOOT_TIMEOUT_MS = '5000';

process.env.ADMIN_EMAIL = '';
process.env.ADMIN_PASSWORD = '';
process.env.GOOGLE_CLIENT_ID = '';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.FILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatty-nofiles-'));
process.env.STATIC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'static'
);

process.on('exit', () => {
  fs.rmSync(process.env.FILE_DIR, { recursive: true, force: true });
});

const { buildApp } = await import('../../server/app.js');

/**
 * What the server does when the bucket is gone.
 *
 * Unlike the database, attachment storage is not something the application
 * cannot work without: a conversation is still a conversation with no
 * photographs in it. So the fault is recorded, the routes that need bytes
 * refuse, and everything else — messages, groups, sign-in, the static site —
 * carries on as though nothing had happened.
 *
 * What must not happen is the silent version: falling back to the container's
 * disk, accepting the upload, reporting success, and losing the file at the next
 * deploy. That is what this file is really guarding.
 */
async function app(t) {
  const instance = await buildApp({ logger: false });
  t.after(() => instance.close());
  await instance.ready();
  return instance;
}

t.test('the server starts, and says the storage is what is broken', async (t) => {
  const server = await app(t);

  t.ok(server.server, 'buildApp resolved rather than throwing');
  t.notOk(server.subsystems.ok('files'), 'attachment storage is down');
  t.match(
    server.subsystems.report().files.error,
    /unreachable|did not finish|ECONNREFUSED/i,
    'with the reason kept'
  );
  t.ok(server.subsystems.ok('database'), 'and the database is not blamed for it');
});

t.test('readiness stays green, because attachments are not required', async (t) => {
  const server = await app(t);

  const res = await server.inject({ method: 'GET', url: '/readyz' });
  t.equal(res.statusCode, 200, 'the API can still be served');

  const body = res.json();
  t.equal(body.ok, true);
  t.equal(body.subsystems.files.ok, false, 'though the report still names the fault');
});

t.test('the routes that need bytes refuse, and say why', async (t) => {
  const server = await app(t);

  // Refused before authentication: the storage is missing whoever is asking, so
  // there is nothing to gain by checking a session first.
  const attempts = [
    ['POST', '/api/files'],
    ['GET', '/api/files/1/content'],
    ['PUT', '/api/users/1/picture'],
    ['DELETE', '/api/users/1/picture'],
  ];

  for (const [method, url] of attempts) {
    const res = await server.inject({ method, url });
    t.equal(res.statusCode, 503, `${method} ${url}`);
    t.match(res.json().error, /Attachment storage is unavailable/);
    t.equal(res.headers['retry-after'], '30', 'and that it is worth trying again');
  }
});

t.test('the rest of the API is untouched', async (t) => {
  const server = await app(t);

  // 401 rather than 503: these need a session, which is a different answer from
  // "the server cannot serve this at all". The point is only that the storage
  // being down did not take them with it.
  for (const url of ['/api/users', '/api/user_groups', '/api/user_messages', '/api/files']) {
    const res = await server.inject({ method: 'GET', url });
    t.not(res.statusCode, 503, `${url} is not refused`);
    t.equal(res.statusCode, 401, 'it just wants a session');
  }
});

t.test('reading and listing file rows still works, since that is the database', async (t) => {
  const server = await app(t);

  // The generic CRUD surface for the files model touches no bytes at all, so it
  // has no reason to be caught by the guard on the upload and download routes.
  t.same(await server.models.files.findAll(), [], 'the model is readable');
});

t.test('the static site is still served', async (t) => {
  const server = await app(t);

  const res = await server.inject({ method: 'GET', url: '/' });
  t.equal(res.statusCode, 200);
});
