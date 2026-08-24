import t from 'tap';

import { asAdmin, asUserWith, upload } from '../helper.js';
import { png, jpeg } from '../fixtures/images.js';

/**
 * Somebody's picture: uploading one, replacing it, removing it, and the two
 * things that follow from a picture being a file — it may be read by anybody
 * who can see the person, and the sweep has to leave it alone.
 */

const ORDINARY = ['users:read', 'users:update:own', 'files:create:own', 'files:read:own'];

/** An account that may edit itself, another like it, and an administrator. */
async function people(t) {
  const admin = await asAdmin(t);
  const me = await asUserWith(t, admin.app, admin.cookies, ORDINARY, '-pic1');
  const other = await asUserWith(t, admin.app, admin.cookies, ORDINARY, '-pic2');

  const [, listed] = await admin.call('GET', '/api/users');
  const idOf = (suffix) => listed.users.find((u) => u.email === `test${suffix}@example.com`).id;
  me.id = idOf('-pic1');
  other.id = idOf('-pic2');

  return { app: admin.app, admin, me, other };
}

/** Sends one picture as that session. */
async function send(app, cookies, id, file) {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/users/${id}/picture`,
    cookies,
    ...upload([file], 'picture'),
  });
  return [res.statusCode, res.json()];
}

const SQUARE = { name: 'me.png', type: 'image/png', body: png(256, 256) };

t.test('uploading a picture creates the file and points the user at it', async (t) => {
  const { app, me } = await people(t);

  const [status, body] = await send(app, me.cookies, me.id, SQUARE);

  t.equal(status, 200);
  t.ok(body.user.logo_file, 'the account carries the file id');
  t.equal(
    body.user.picture,
    `/api/files/${body.user.logo_file}/content`,
    'and one field says where the picture is, wherever it came from'
  );

  const [, file] = await me.call('GET', `/api/files/${body.user.logo_file}`);
  t.equal(file.file.owner, me.id, 'the picture belongs to the person in it');
  t.equal(file.file.mime_type, 'image/png');
  t.equal(file.file.size, SQUARE.body.length, 'stored whole');
});

t.test('a JPEG is equally acceptable', async (t) => {
  const { app, me } = await people(t);
  const [status] = await send(app, me.cookies, me.id, {
    name: 'me.jpg', type: 'image/jpeg', body: jpeg(300, 300),
  });
  t.equal(status, 200);
});

t.test('the rules are the ones Google applies', async (t) => {
  const { app, me } = await people(t);

  const cases = [
    ['not square', { name: 'wide.png', type: 'image/png', body: png(256, 128) }, /square/],
    ['too large', { name: 'huge.png', type: 'image/png', body: png(1200, 1200) }, /1024/],
    ['too small', { name: 'tiny.png', type: 'image/png', body: png(32, 32) }, /64/],
    [
      'too many bytes',
      { name: 'fat.png', type: 'image/png', body: png(256, 256, { padTo: 1024 * 1024 + 64 }) },
      /1024KB/,
    ],
    ['not an image', { name: 'notes.png', type: 'image/png', body: 'hello' }, /not a PNG or a JPEG/],
    ['wrong format', { name: 'me.gif', type: 'image/gif', body: png(256, 256) }, /PNG or a JPEG/],
  ];

  for (const [label, file, message] of cases) {
    const [status, body] = await send(app, me.cookies, me.id, file);
    t.equal(status, 415, `${label} is refused`);
    t.match(body.error, message, label);
  }

  const [, after] = await me.call('GET', '/api/auth/me');
  t.equal(after.user.logo_file, null, 'and nothing was set along the way');
});

t.test('replacing a picture takes the old file with it', async (t) => {
  const { app, me } = await people(t);

  const [, first] = await send(app, me.cookies, me.id, SQUARE);
  const [, second] = await send(app, me.cookies, me.id, {
    name: 'again.png', type: 'image/png', body: png(128, 128),
  });

  t.not(second.user.logo_file, first.user.logo_file, 'a new file');

  const [gone] = await me.call('GET', `/api/files/${first.user.logo_file}`);
  t.equal(gone, 404, 'and the one it replaced is not left behind');
});

t.test('an uploaded picture replaces the one a provider gave', async (t) => {
  const { app, admin, me } = await people(t);

  await admin.call('PUT', `/api/users/${me.id}`, { logo: 'https://example.com/google.png' });
  const [, body] = await send(app, me.cookies, me.id, SQUARE);

  t.equal(body.user.logo, null, 'the provider URL is not left underneath');
  t.equal(body.user.picture, `/api/files/${body.user.logo_file}/content`);
});

t.test('removing a picture clears both kinds', async (t) => {
  const { app, admin, me } = await people(t);

  const [, uploaded] = await send(app, me.cookies, me.id, SQUARE);
  const [status, body] = await me.call('DELETE', `/api/users/${me.id}/picture`);

  t.equal(status, 200);
  t.equal(body.user.logo_file, null);
  t.equal(body.user.picture, null, 'back to their initials');

  const [gone] = await admin.call('GET', `/api/files/${uploaded.user.logo_file}`);
  t.equal(gone, 404, 'and the file went with it');
});

t.test('a picture is readable by anybody signed in', async (t) => {
  const { app, me, other } = await people(t);

  const [, body] = await send(app, me.cookies, me.id, SQUARE);

  // Not their file, and not attached to a message they can read — but it is
  // drawn beside this person's name wherever they appear.
  const seen = await app.inject({
    method: 'GET',
    url: `/api/files/${body.user.logo_file}/content`,
    cookies: other.cookies,
  });
  t.equal(seen.statusCode, 200, 'somebody else may draw it');
  t.equal(seen.headers['content-type'], 'image/png');
  t.match(seen.headers['content-disposition'], /^inline/, 'shown rather than downloaded');
  t.equal(seen.rawPayload.length, SQUARE.body.length, 'the bytes, whole');

  const anonymous = await app.inject({
    method: 'GET', url: `/api/files/${body.user.logo_file}/content`,
  });
  t.equal(anonymous.statusCode, 401, 'but not to a stranger');
});

t.test('the sweep leaves pictures alone', async (t) => {
  const { app, me } = await people(t);

  const [, body] = await send(app, me.cookies, me.id, SQUARE);
  t.ok(await app.models.files.findById(body.user.logo_file), 'the picture exists');

  await app.sweepFiles();

  t.ok(
    await app.models.files.findById(body.user.logo_file),
    'a file attached to a person rather than a message is still attached'
  );
});

t.test('a picture is only yours to set unless you administer people', async (t) => {
  const { app, me, other, admin } = await people(t);

  const [mine] = await send(app, me.cookies, other.id, SQUARE);
  t.equal(mine, 404, 'an own-scoped account cannot set another picture');

  const [theirs, body] = await send(app, admin.cookies, other.id, SQUARE);
  t.equal(theirs, 200, 'an administrator can');
  t.ok(body.user.logo_file);
});

t.test('the file id is not a field an account may write', async (t) => {
  const { app, me, other } = await people(t);

  // The one that matters: a picture is readable by everyone signed in, so
  // pointing your own row at somebody else's file would publish it.
  const [, theirs] = await send(app, other.cookies, other.id, SQUARE);
  const [status, body] = await me.call('PUT', `/api/users/${me.id}`, {
    logo_file: theirs.user.logo_file,
  });

  t.equal(status, 200, 'the request succeeds');
  t.equal(body.user.logo_file, null, 'and the field was stripped from it');
});

t.test('deleting the file leaves nobody pointing at it', async (t) => {
  const { app, admin, me } = await people(t);

  const [, body] = await send(app, me.cookies, me.id, SQUARE);
  const [removed] = await admin.call('DELETE', `/api/files/${body.user.logo_file}`);
  t.equal(removed, 200, 'an administrator may delete the file itself');

  const [, after] = await me.call('GET', '/api/auth/me');
  t.equal(after.user.logo_file, null, 'and the account no longer claims it');
  t.equal(after.user.picture, null);
});
