import fs from 'node:fs';
import path from 'node:path';

import t from 'tap';

import { asAdmin, asUserWith, call, login, upload } from '../helper.js';

/**
 * Attachments, end to end, against the local filesystem provider the test
 * harness configures — no bucket, no credentials, no network.
 */

const MEMBER_PERMISSIONS = [
  'user_groups:read:member',
  'user_messages:read:member',
  'user_messages:create:member',
  'user_messages:update:own',
  'user_messages:delete:own',
  'files:create:own',
  'files:read:own',
  'files:delete:own',
];

/** Two people in a group, and one outside it. */
async function conversation(t) {
  const admin = await asAdmin(t);

  const member = await asUserWith(t, admin.app, admin.cookies, MEMBER_PERMISSIONS, '-att1');
  const other = await asUserWith(t, admin.app, admin.cookies, MEMBER_PERMISSIONS, '-att2');
  const outsider = await asUserWith(t, admin.app, admin.cookies, MEMBER_PERMISSIONS, '-attout');

  const [, listed] = await admin.call('GET', '/api/users');
  const idOf = (suffix) => listed.users.find((u) => u.email === `test${suffix}@example.com`).id;
  member.id = idOf('-att1');
  other.id = idOf('-att2');
  outsider.id = idOf('-attout');

  const [, created] = await admin.call('POST', '/api/user_groups', {
    owner: member.id, members: [member.id, other.id],
  });

  return { admin, member, other, outsider, group: created.user_group };
}

/** Uploads one file as that session and returns the created row. */
async function send(app, cookies, file) {
  const res = await app.inject({
    method: 'POST', url: '/api/files', cookies, ...upload([file]),
  });
  return [res.statusCode, res.json()];
}

t.test('the suite never talks to a bucket', async (t) => {
  const { admin } = await conversation(t);
  t.equal(
    admin.app.files.name,
    'local',
    'whatever .env configures, the tests write to their own directory'
  );
});

t.test('uploading stores the bytes and a row that points at them', async (t) => {
  const { admin, member } = await conversation(t);

  const [status, body] = await send(admin.app, member.cookies, {
    name: 'notes.txt', body: 'the quick brown fox', type: 'text/plain',
  });

  t.equal(status, 201);
  t.equal(body.count, 1);

  const [file] = body.files;
  t.equal(file.name, 'notes.txt');
  t.equal(file.extension, 'txt');
  t.equal(file.size, 19, 'measured from what arrived, not from what was claimed');
  t.equal(file.mime_type, 'text/plain');
  t.equal(file.provider_name, 'local');
  t.equal(file.owner, member.id, 'the uploader owns it, taken from the session');
  t.ok(file.uuid, 'and it gets the system columns every row gets');

  t.notMatch(file.provider_id, /notes/, 'the key is not built from the filename');
  t.match(
    file.provider_id,
    /^message_files\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.txt$/,
    'and everything attached to a message lives under one folder'
  );
  t.ok(
    fs.existsSync(path.join(process.env.FILE_DIR, file.provider_id)),
    'the bytes really are on disk where the row says'
  );
});

t.test('an upload is refused without a session', async (t) => {
  const { admin } = await conversation(t);

  const res = await admin.app.inject({
    method: 'POST', url: '/api/files', ...upload([{ name: 'x.txt', body: 'x' }]),
  });
  t.equal(res.statusCode, 401);

  const [empty] = await admin.app.inject({
    method: 'POST', url: '/api/files', cookies: admin.cookies, ...upload([]),
  }).then((r) => [r.statusCode]);
  t.equal(empty, 400, 'and a request carrying no file has nothing to store');
});

t.test('a file can be read by its owner, its group, and nobody else', async (t) => {
  const { admin, member, other, outsider, group } = await conversation(t);

  const [, uploaded] = await send(admin.app, member.cookies, {
    name: 'plan.txt', body: 'meet at noon', type: 'text/plain',
  });
  const [file] = uploaded.files;

  const [attached] = await member.call('POST', '/api/user_messages', {
    group: group.id, value: 'See attached', files: [file.id],
  });
  t.equal(attached, 201);

  const download = async (cookies) => admin.app.inject({
    method: 'GET', url: `/api/files/${file.id}/content`, cookies,
  });

  const mine = await download(member.cookies);
  t.equal(mine.statusCode, 200);
  t.equal(mine.body, 'meet at noon');
  t.match(mine.headers['content-disposition'], /filename="plan.txt"/);
  t.equal(mine.headers['cache-control'], 'private, no-store');

  const theirs = await download(other.cookies);
  t.equal(theirs.statusCode, 200, 'a recipient reads what they were sent');
  t.equal(theirs.body, 'meet at noon');

  const stranger = await download(outsider.cookies);
  t.equal(
    stranger.statusCode,
    404,
    'somebody outside the group is told it is missing, not that it is forbidden'
  );

  const administrator = await download(admin.cookies);
  t.equal(administrator.statusCode, 200, 'the unscoped permission reads every row');
});

t.test('a download can be resumed', async (t) => {
  const { admin, member } = await conversation(t);

  const [, uploaded] = await send(admin.app, member.cookies, {
    name: 'song.bin', body: '0123456789',
  });
  const [file] = uploaded.files;

  const res = await admin.app.inject({
    method: 'GET',
    url: `/api/files/${file.id}/content`,
    cookies: member.cookies,
    headers: { range: 'bytes=2-5' },
  });

  t.equal(res.statusCode, 206, 'a range is answered with the range');
  t.equal(res.body, '2345');
  t.equal(res.headers['content-range'], 'bytes 2-5/10');
  t.equal(res.headers['accept-ranges'], 'bytes', 'and a player is told it may ask');
});

t.test('attaching somebody else s file is refused', async (t) => {
  const { admin, member, other, group } = await conversation(t);

  const [, uploaded] = await send(admin.app, member.cookies, {
    name: 'private.txt', body: 'not for you',
  });
  const [file] = uploaded.files;

  const [status, body] = await other.call('POST', '/api/user_messages', {
    group: group.id, value: 'Look what I found', files: [file.id],
  });

  t.equal(status, 403, 'or attaching would be a way to publish what you cannot read');
  t.match(body.error, /only attach your own/);

  // And the same on the way through an edit.
  const [, own] = await other.call('POST', '/api/user_messages', {
    group: group.id, value: 'Mine', files: [],
  });
  const [edited] = await other.call('PUT', `/api/user_messages/${own.user_message.id}`, {
    value: 'Mine', files: [file.id],
  });
  t.equal(edited, 403, 'editing is the same claim made later');
});

t.test('deleting a file takes the bytes with it', async (t) => {
  const { admin, member } = await conversation(t);

  const [, uploaded] = await send(admin.app, member.cookies, {
    name: 'gone.txt', body: 'briefly here',
  });
  const [file] = uploaded.files;
  const onDisk = path.join(process.env.FILE_DIR, file.provider_id);

  t.ok(fs.existsSync(onDisk), 'stored to begin with');

  const [status] = await member.call('DELETE', `/api/files/${file.id}`);
  t.equal(status, 200);

  t.notOk(fs.existsSync(onDisk), 'the object goes when the row does');

  const [missing] = await member.call('GET', `/api/files/${file.id}`);
  t.equal(missing, 404);

  const res = await admin.app.inject({
    method: 'GET', url: `/api/files/${file.id}/content`, cookies: member.cookies,
  });
  t.equal(res.statusCode, 404, 'and there is nothing left to download');
});

t.test('a message carries its attachments to everyone who may read it', async (t) => {
  const { admin, member, other, group } = await conversation(t);

  const [, uploaded] = await send(admin.app, member.cookies, {
    name: 'photo.png', body: 'not really a png', type: 'image/png',
  });
  const [file] = uploaded.files;

  await member.call('POST', '/api/user_messages', {
    group: group.id, value: 'Here it is', files: [file.id],
  });

  const [, theirs] = await other.call('GET', '/api/user_messages');
  const message = theirs.user_messages.find((row) => row.value === 'Here it is');

  t.equal(message.files.length, 1, 'the relation is hydrated on the way out');
  t.match(message.files[0], { id: file.id, name: 'photo.png', size: 16 });
  t.notOk(
    'provider_id' in message.files[0] && message.files[0].provider_id === undefined,
    'and carries what a client needs to render and fetch it'
  );
});

t.test('editing a message drops the files it no longer carries', async (t) => {
  const { admin, member, group } = await conversation(t);

  const kept = (await send(admin.app, member.cookies, {
    name: 'kept.txt', body: 'still here',
  }))[1].files[0];
  const dropped = (await send(admin.app, member.cookies, {
    name: 'dropped.txt', body: 'not for long',
  }))[1].files[0];

  const [, posted] = await member.call('POST', '/api/user_messages', {
    group: group.id, value: 'Two files', files: [kept.id, dropped.id],
  });
  const message = posted.user_message;
  t.equal(message.files.length, 2);

  // What the client does: save the message first, then delete what it no
  // longer carries.
  const [status, edited] = await member.call('PUT', `/api/user_messages/${message.id}`, {
    value: 'One file now', files: [kept.id],
  });
  t.equal(status, 200);
  t.equal(edited.user_message.value, 'One file now', 'the words are corrected');
  t.same(edited.user_message.files.map((file) => file.id), [kept.id], 'and so is the list');

  const [removed] = await member.call('DELETE', `/api/files/${dropped.id}`);
  t.equal(removed, 200);

  t.notOk(
    fs.existsSync(path.join(process.env.FILE_DIR, dropped.provider_id)),
    'the dropped file is gone from storage'
  );
  t.ok(
    fs.existsSync(path.join(process.env.FILE_DIR, kept.provider_id)),
    'and the one still attached is untouched'
  );
});

t.test('only the author may edit, whatever else they can read', async (t) => {
  const { admin, member, other, outsider, group } = await conversation(t);

  const [, posted] = await member.call('POST', '/api/user_messages', {
    group: group.id, value: 'Mine to correct',
  });
  const message = posted.user_message;

  const [theirs] = await other.call('PUT', `/api/user_messages/${message.id}`, {
    value: 'Let me fix that for you',
  });
  t.equal(theirs, 404, 'a fellow member may read it but not rewrite it');

  const [stranger] = await outsider.call('PUT', `/api/user_messages/${message.id}`, {
    value: 'Nothing to do with me',
  });
  t.equal(stranger, 404);

  const [mine, updated] = await member.call('PUT', `/api/user_messages/${message.id}`, {
    value: 'Corrected',
  });
  t.equal(mine, 200);
  t.equal(updated.user_message.value, 'Corrected');

  const [asAdministrator, byAdmin] = await admin.call(
    'PUT', `/api/user_messages/${message.id}`, { value: 'Moderated' }
  );
  t.equal(asAdministrator, 200, 'the unscoped permission edits anybody s message');
  t.equal(byAdmin.user_message.value, 'Moderated');
  t.equal(byAdmin.user_message.owner, member.id, 'without taking authorship of it');
});

t.test('an admin sees every file in the dashboard', async (t) => {
  const { admin, member, other } = await conversation(t);

  await send(admin.app, member.cookies, { name: 'a.txt', body: 'one' });
  await send(admin.app, other.cookies, { name: 'b.txt', body: 'two' });

  const [status, body] = await admin.call('GET', '/api/files');
  t.equal(status, 200);
  t.equal(body.count, 2, 'both, whoever uploaded them');
  t.same(body.files.map((file) => file.name).sort(), ['a.txt', 'b.txt']);

  const [own, mine] = await member.call('GET', '/api/files');
  t.equal(own, 200);
  t.same(mine.files.map((file) => file.name), ['a.txt'], 'an own-scoped session sees only theirs');

  // The model publishes no create action, so there is no way to conjure a row
  // that points at bytes nobody uploaded.
  const [conjured] = await admin.call('POST', '/api/files', {
    owner: 1, name: 'forged.txt', provider_name: 'local', provider_id: '../../etc/passwd', size: 1,
  });
  t.equal(conjured, 406, 'JSON is not how a file comes into existence');
});

t.test('a row whose bytes are already gone still deletes cleanly', async (t) => {
  const { admin, member } = await conversation(t);

  const [, uploaded] = await send(admin.app, member.cookies, {
    name: 'vanished.txt', body: 'here for now',
  });
  const [file] = uploaded.files;

  // Whatever removed it — a wiped disk, a bucket restored from behind the
  // database, a delete that half-succeeded.
  fs.rmSync(path.join(process.env.FILE_DIR, file.provider_id));

  const [status, body] = await member.call('DELETE', `/api/files/${file.id}`);
  t.equal(status, 200, 'the row goes even though there was nothing to unlink');
  t.equal(body.ok, true);

  const [gone] = await member.call('GET', `/api/files/${file.id}`);
  t.equal(gone, 404, 'and it is really gone');
});

t.test('a row from storage this process cannot reach is a miss, not a crash', async (t) => {
  const { admin } = await conversation(t);

  // As if the bucket had been reconfigured out from under an existing row.
  const stranded = await admin.app.models.files.create({
    owner: 1,
    name: 'elsewhere.txt',
    provider_name: 's3',
    provider_id: 'some-other-bucket/message_files/2026/08/whatever.txt',
    size: 12,
  });

  const res = await admin.app.inject({
    method: 'GET', url: `/api/files/${stranded.id}/content`, cookies: admin.cookies,
  });
  t.equal(res.statusCode, 404, 'reported as missing rather than read with the wrong provider');

  // And the row can still be cleared away, which is the whole point of not
  // throwing: an attachment whose bytes are unreachable is exactly the one
  // somebody wants to delete.
  const [status] = await admin.call('DELETE', `/api/files/${stranded.id}`);
  t.equal(status, 200);

  const [gone] = await admin.call('GET', `/api/files/${stranded.id}`);
  t.equal(gone, 404, 'and it is gone');
});

t.test('files need a session, like everything else', async (t) => {
  const { admin } = await conversation(t);
  const [anonymous] = await call(admin.app, 'GET', '/api/files');
  t.equal(anonymous, 401);

  const stranger = await asUserWith(
    t, admin.app, await login(admin.app), ['user_groups:read:member'], '-attnoperm'
  );
  const [forbidden, body] = await stranger.call('GET', '/api/files');
  t.equal(forbidden, 403);
  t.match(body.error, /files:read/);
});
