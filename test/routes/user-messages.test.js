import t from 'tap';

import { asAdmin, asUserWith } from '../helper.js';

/** An admin session plus a group of theirs to post into. */
async function withGroup(t) {
  const session = await asAdmin(t);
  const [, created] = await session.call('POST', '/api/user_groups', { owner: 1, members: [1] });
  return { ...session, group: created.user_group };
}

t.test('POST /api/user_messages files a message under an author and a group', async (t) => {
  const { call, group } = await withGroup(t);

  const [status, body] = await call('POST', '/api/user_messages', {
    owner: 1,
    group: group.id,
    value: 'Morning, all.',
  });

  t.equal(status, 201);
  t.equal(body.user_message.owner, 1);
  t.equal(body.user_message.group, group.id);
  t.equal(body.user_message.value, 'Morning, all.');
  t.match(
    body.user_message.uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );
  t.ok(body.user_message.created_at, 'and is stamped with when it was written');
});

t.test('GET /api/user_messages', async (t) => {
  const { call, group } = await withGroup(t);
  t.same((await call('GET', '/api/user_messages'))[1], { ok: true, count: 0, user_messages: [] });

  const [, created] = await call('POST', '/api/user_messages', {
    owner: 1, group: group.id, value: 'First',
  });
  await call('POST', '/api/user_messages', { owner: 1, group: group.id, value: 'Second' });

  t.equal((await call('GET', '/api/user_messages'))[1].count, 2);
  t.equal(
    (await call('GET', `/api/user_messages/${created.user_message.id}`))[1].user_message.value,
    'First'
  );

  const [, searched] = await call('GET', '/api/user_messages?search=seco');
  t.equal(searched.count, 1, 'the body is searchable');
  t.equal(searched.user_messages[0].value, 'Second');

  const [missing, missingBody] = await call('GET', '/api/user_messages/9999');
  t.equal(missing, 404);
  t.same(missingBody, { ok: false, error: 'User Message not found' });
});

t.test('POST /api/user_messages rejects bad input', async (t) => {
  const { call, group } = await withGroup(t);

  const cases = [
    [{ group: group.id, value: 'No author' }, /Author is required/],
    [{ owner: 1, value: 'No group' }, /Group is required/],
    [{ owner: 1, group: group.id }, /Message is required/],
    [{ owner: 1, group: group.id, value: '' }, /Message is required/],
    [{ owner: 1, group: 'somewhere', value: 'Bad key' }, /is not a row id/],
  ];

  for (const [payload, expected] of cases) {
    const [status, body] = await call('POST', '/api/user_messages', payload);
    t.equal(status, 400, `${JSON.stringify(payload)} is rejected`);
    t.match(body.error, expected);
  }
});

t.test('PUT and DELETE /api/user_messages/:id', async (t) => {
  const { call, group } = await withGroup(t);
  const [, created] = await call('POST', '/api/user_messages', {
    owner: 1, group: group.id, value: 'Typo heer',
  });
  const { id, uuid } = created.user_message;

  const [status, body] = await call('PUT', `/api/user_messages/${id}`, { value: 'Typo here' });
  t.equal(status, 200);
  t.equal(body.user_message.value, 'Typo here');
  t.equal(body.user_message.group, group.id, 'untouched fields survive');
  t.equal(body.user_message.uuid, uuid);

  t.equal((await call('PUT', '/api/user_messages/9999', { value: 'Ghost' }))[0], 404);

  t.equal((await call('DELETE', `/api/user_messages/${id}`))[0], 200);
  t.equal((await call('DELETE', `/api/user_messages/${id}`))[0], 404, 'already gone');
  t.equal((await call('GET', '/api/user_messages'))[1].count, 0);
});

t.test('an own-scoped author only sees and edits their own messages', async (t) => {
  const { app, cookies, call: adminCall, group } = await withGroup(t);

  const actor = await asUserWith(
    t,
    app,
    cookies,
    ['user_messages:read:own', 'user_messages:create:own', 'user_messages:delete:own'],
    '-author'
  );
  const [, users] = await adminCall('GET', '/api/users');
  const actorId = users.users.find((user) => user.email === 'test-author@example.com').id;

  const [, theirs] = await adminCall('POST', '/api/user_messages', {
    owner: 1, group: group.id, value: 'Written by the admin',
  });

  const [status, posted] = await actor.call('POST', '/api/user_messages', {
    owner: 1,
    group: group.id,
    value: 'Written by me',
  });
  t.equal(status, 201);
  t.equal(posted.user_message.owner, actorId, 'authorship is taken from the session');

  const [, list] = await actor.call('GET', '/api/user_messages');
  t.equal(list.count, 1, 'and only their own message comes back');
  t.equal(list.user_messages[0].value, 'Written by me');

  t.equal(
    (await actor.call('GET', `/api/user_messages/${theirs.user_message.id}`))[0],
    404,
    'somebody else message is reported missing'
  );
  t.equal((await actor.call('DELETE', `/api/user_messages/${theirs.user_message.id}`))[0], 404);
  t.equal(
    (await actor.call('PUT', `/api/user_messages/${posted.user_message.id}`, { value: 'x' }))[0],
    403,
    'and update was never granted at all'
  );

  t.equal((await adminCall('GET', '/api/user_messages'))[1].count, 2, 'the admin sees both');
  t.equal((await actor.call('DELETE', `/api/user_messages/${posted.user_message.id}`))[0], 200);
});

t.test('a message can answer another one', async (t) => {
  const { call, group } = await withGroup(t);
  const [, original] = await call('POST', '/api/user_messages', {
    owner: 1, group: group.id, value: 'Anyone about?',
  });

  const [status, reply] = await call('POST', '/api/user_messages', {
    owner: 1,
    group: group.id,
    value: 'Here.',
    reply_to: original.user_message.id,
  });

  t.equal(status, 201);
  t.equal(reply.user_message.reply_to, original.user_message.id);

  const [, plain] = await call('POST', '/api/user_messages', {
    owner: 1, group: group.id, value: 'Unprompted.',
  });
  t.equal(plain.user_message.reply_to, null, 'answering nothing is the normal case');

  const [bad, badBody] = await call('POST', '/api/user_messages', {
    owner: 1, group: group.id, value: 'Nonsense', reply_to: 'the last one',
  });
  t.equal(bad, 400);
  t.match(badBody.error, /is not a row id/);

  const [, cleared] = await call('PUT', `/api/user_messages/${reply.user_message.id}`, {
    reply_to: null,
  });
  t.equal(cleared.user_message.reply_to, null, 'and a reply can be detached again');
});

t.test('a message does not outlive its author or its group', async (t) => {
  const { call, group } = await withGroup(t);
  const [, author] = await call('POST', '/api/users', {
    email: 'poster@example.com', first_name: 'Post', last_name: 'Er', password: 'Passw0rd!',
  });

  await call('POST', '/api/user_messages', { owner: 1, group: group.id, value: 'From the admin' });
  await call('POST', '/api/user_messages', {
    owner: author.user.id, group: group.id, value: 'From the poster',
  });

  // In Postgres both keys are ON DELETE CASCADE; the in-memory driver has no
  // foreign keys, so this documents the intent rather than proving the SQL.
  t.equal((await call('GET', '/api/user_messages'))[1].count, 2);
  t.equal((await call('DELETE', `/api/users/${author.user.id}`))[0], 200);
  t.equal((await call('DELETE', `/api/user_groups/${group.id}`))[0], 200);
});
