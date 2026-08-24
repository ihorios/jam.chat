import t from 'tap';

import { asAdmin, asUserWith, call, login } from '../helper.js';

/**
 * The messenger's access rules, from the outside: what a member-scoped session
 * may see and do over HTTP.
 *
 * The cast is an admin (user #1), a member of the shared group, and an
 * outsider who is in a group of their own.
 */
async function messengerFixture(t) {
  const { app, cookies: adminCookies, call: adminCall } = await asAdmin(t);

  const member = await asUserWith(
    t,
    app,
    adminCookies,
    ['users:read', 'user_groups:read:member', 'user_messages:read:member',
      'user_messages:create:member'],
    '-member'
  );
  const outsider = await asUserWith(
    t,
    app,
    adminCookies,
    ['users:read', 'user_groups:read:member', 'user_messages:read:member',
      'user_messages:create:member'],
    '-outsider'
  );

  const [, list] = await adminCall('GET', '/api/users');
  const idOf = (suffix) => list.users.find((u) => u.email === `test${suffix}@example.com`).id;
  member.id = idOf('-member');
  outsider.id = idOf('-outsider');

  const [, shared] = await adminCall('POST', '/api/user_groups', {
    owner: 1,
    members: [1, member.id],
  });
  const [, elsewhere] = await adminCall('POST', '/api/user_groups', {
    owner: outsider.id,
    members: [outsider.id],
  });

  return {
    app,
    adminCall,
    member,
    outsider,
    shared: shared.user_group,
    elsewhere: elsewhere.user_group,
  };
}

t.test('a member sees the groups they are in, and no others', async (t) => {
  const { adminCall, member, shared, elsewhere } = await messengerFixture(t);

  const [status, body] = await member.call('GET', '/api/user_groups');
  t.equal(status, 200);
  t.equal(body.count, 1, 'one group, though three exist');
  t.equal(body.user_groups[0].id, shared.id);

  t.equal(
    (await member.call('GET', `/api/user_groups/${shared.id}`))[0],
    200,
    'their group is readable by id'
  );
  t.equal(
    (await member.call('GET', `/api/user_groups/${elsewhere.id}`))[0],
    404,
    'somebody else group is reported missing'
  );

  t.equal((await adminCall('GET', '/api/user_groups'))[1].count, 2, 'the admin still sees both');
});

t.test('a member sees everything said in their group, not only their own', async (t) => {
  const { adminCall, member, outsider, shared, elsewhere } = await messengerFixture(t);

  await adminCall('POST', '/api/user_messages', {
    owner: 1, group: shared.id, value: 'Written by the admin',
  });
  await member.call('POST', '/api/user_messages', {
    group: shared.id, value: 'Written by the member',
  });
  await adminCall('POST', '/api/user_messages', {
    owner: outsider.id, group: elsewhere.id, value: 'Written elsewhere',
  });

  const [status, body] = await member.call('GET', '/api/user_messages');
  t.equal(status, 200);
  t.same(
    body.user_messages.map((message) => message.value),
    ['Written by the admin', 'Written by the member'],
    'the whole conversation, including what other people said'
  );

  const [, mine] = await outsider.call('GET', '/api/user_messages');
  t.same(
    mine.user_messages.map((message) => message.value),
    ['Written elsewhere'],
    'and nothing from a group they are not in'
  );
});

t.test('a member-scoped post lands in their group, as them', async (t) => {
  const { member, outsider, shared, elsewhere } = await messengerFixture(t);

  const [status, body] = await member.call('POST', '/api/user_messages', {
    owner: outsider.id,
    group: shared.id,
    value: 'Hello all',
  });

  t.equal(status, 201);
  t.equal(body.user_message.owner, member.id, 'the author they named was ignored');
  t.equal(body.user_message.group, shared.id);

  const [refused, refusedBody] = await member.call('POST', '/api/user_messages', {
    group: elsewhere.id,
    value: 'Butting in',
  });
  t.equal(refused, 403, 'posting into a group they are not in is refused');
  t.match(refusedBody.error, /you belong to/i);

  const [missing] = await member.call('POST', '/api/user_messages', {
    group: 9999,
    value: 'Into thin air',
  });
  t.equal(missing, 403, 'and so is a group that does not exist');
});

t.test('leaving a group takes its conversation with it', async (t) => {
  const { adminCall, member, shared } = await messengerFixture(t);

  await adminCall('POST', '/api/user_messages', {
    owner: 1, group: shared.id, value: 'While you were here',
  });
  t.equal((await member.call('GET', '/api/user_messages'))[1].count, 1);

  // Dropped from the members list, but the group and its messages remain.
  await adminCall('PUT', `/api/user_groups/${shared.id}`, { members: [1] });

  t.equal((await member.call('GET', '/api/user_groups'))[1].count, 0, 'the group is gone from view');
  t.equal((await member.call('GET', '/api/user_messages'))[1].count, 0, 'and so is what was said');
  t.equal(
    (await member.call('GET', `/api/user_messages/1`))[0],
    404,
    'including by id, immediately'
  );
  t.equal((await adminCall('GET', '/api/user_messages'))[1].count, 1, 'though nothing was deleted');
});

t.test('membership grants nothing the role did not ask for', async (t) => {
  const { app, adminCall, shared } = await messengerFixture(t);

  // Read-only: in the group, but with no permission to say anything.
  const lurker = await asUserWith(
    t, app, (await login(app)), ['user_groups:read:member', 'user_messages:read:member'], '-lurker'
  );
  const [, list] = await adminCall('GET', '/api/users');
  const lurkerId = list.users.find((u) => u.email === 'test-lurker@example.com').id;
  await adminCall('PUT', `/api/user_groups/${shared.id}`, { members: [1, lurkerId] });

  await adminCall('POST', '/api/user_messages', {
    owner: 1, group: shared.id, value: 'Anyone there?',
  });

  t.equal((await lurker.call('GET', '/api/user_messages'))[1].count, 1, 'they can read');

  const denied = [
    ['POST', '/api/user_messages', { group: shared.id, value: 'Hi' }],
    ['PUT', '/api/user_messages/1', { value: 'Edited' }],
    ['DELETE', '/api/user_messages/1', undefined],
    ['GET', '/api/users', undefined],
  ];

  for (const [method, url, payload] of denied) {
    const [status, body] = await lurker.call(method, url, payload);
    t.equal(status, 403, `${method} ${url} is refused`);
    t.match(body.error, /Missing required permission/);
  }
});

t.test('an anonymous caller gets nothing at all', async (t) => {
  const { app, shared } = await messengerFixture(t);

  for (const [method, url] of [
    ['GET', '/api/user_groups'],
    ['GET', `/api/user_groups/${shared.id}`],
    ['GET', '/api/user_messages'],
    ['POST', '/api/user_messages'],
  ]) {
    const [status] = await call(app, method, url, {});
    t.equal(status, 401, `${method} ${url} needs a session`);
  }
});
