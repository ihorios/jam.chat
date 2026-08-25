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

/*
 * The chats page is somebody's own conversations, whoever they are.
 *
 * An administrator holds the unscoped permissions, which is what the dashboard
 * is for. Without `?scope=`, /chats answered them with every group in the
 * installation and everything ever said in one — a moderation view wearing a
 * messenger's clothes. These lock the narrowing in, and lock in that it only
 * ever narrows.
 */
t.test('a read can be narrowed to the caller’s own corner, but never widened', async (t) => {
  const { adminCall, member, outsider, shared, elsewhere } = await messengerFixture(t);

  await adminCall('POST', '/api/user_messages', {
    owner: outsider.id, group: elsewhere.id, value: 'not the admin’s business',
  });
  await adminCall('POST', '/api/user_messages', {
    owner: 1, group: shared.id, value: 'in a group the admin is in',
  });

  // The dashboard, which asks for nothing, is unchanged.
  const [, all] = await adminCall('GET', '/api/user_messages');
  t.equal(all.count, 2, 'unscoped, an administrator still sees every message');
  const [, allGroups] = await adminCall('GET', '/api/user_groups');
  t.equal(allGroups.count, 2, 'and every group');

  // The messenger, which asks to be answered as a member.
  const [status, mine] = await adminCall('GET', '/api/user_messages?scope=member');
  t.equal(status, 200);
  t.equal(mine.count, 1, 'narrowed, only the conversations they are in');
  t.equal(mine.user_messages[0].value, 'in a group the admin is in');

  const [, myGroups] = await adminCall('GET', '/api/user_groups?scope=member');
  t.equal(myGroups.count, 1, 'and only the groups they are in');
  t.equal(myGroups.user_groups[0].id, shared.id);
  t.notOk(
    myGroups.user_groups.some((group) => group.id === elsewhere.id),
    'a group of strangers never reaches the chats page'
  );

  // Narrowing only. Asking for more than you hold gets you what you hold.
  const [, widened] = await member.call('GET', '/api/user_messages?scope=any');
  t.equal(widened.count, 1, 'a member asking for `any` is clamped back to their own');
  t.notOk(
    widened.user_messages.some((m) => m.value === 'not the admin’s business'),
    'and cannot reach a conversation they are not in'
  );

  const [refused, error] = await member.call('GET', '/api/user_messages?scope=nonsense');
  t.equal(refused, 400, 'a scope that does not exist is a mistake, not everything');
  t.match(error.error, /not a scope/);
});

/*
 * The chats page loads one conversation at a time, so the filter it does that
 * with has to narrow *within* the caller's scope rather than around it.
 */
t.test('a conversation can be fetched on its own, and only if it is yours', async (t) => {
  const { adminCall, member, outsider, shared, elsewhere } = await messengerFixture(t);

  await adminCall('POST', '/api/user_messages', { owner: 1, group: shared.id, value: 'here' });
  await adminCall('POST', '/api/user_messages', {
    owner: outsider.id, group: elsewhere.id, value: 'not here',
  });

  const [status, one] = await member.call('GET', `/api/user_messages?group=${shared.id}`);
  t.equal(status, 200);
  t.equal(one.count, 1, 'one group’s messages, not every group’s');
  t.equal(one.user_messages[0].value, 'here');

  // The filter narrows; it never reaches past the scope that was already applied.
  const [, theirs] = await member.call('GET', `/api/user_messages?group=${elsewhere.id}`);
  t.equal(theirs.count, 0, 'asking for a group you are not in narrows to nothing');

  const [bad] = await member.call('GET', '/api/user_messages?group=nonsense');
  t.equal(bad, 400, 'and an id that is not one is a mistake, not a missing filter');
});

/*
 * What the sidebar draws itself from once the messages are no longer loaded:
 * the count, and the last line said in each group.
 */
t.test('unread carries a count and a preview for every group', async (t) => {
  const { adminCall, member, shared } = await messengerFixture(t);

  await adminCall('POST', '/api/user_messages', { owner: 1, group: shared.id, value: 'first' });
  await adminCall('POST', '/api/user_messages', { owner: 1, group: shared.id, value: 'second' });

  const [status, unread] = await member.call('GET', '/api/messenger/unread');
  t.equal(status, 200);
  t.equal(unread.groups[shared.id], 2, 'both count against them');
  t.equal(unread.total, 2);
  t.equal(unread.latest[shared.id].value, 'second', 'and the preview is the last one said');

  const [, read] = await member.call('POST', '/api/messenger/read', { group: shared.id });
  t.equal(read.groups[shared.id], 0, 'reading it clears the count');
  t.equal(
    read.latest[shared.id].value, 'second',
    'but not the preview — the conversation still has a last line'
  );

  // Their own words are never news, but they are still the latest thing said.
  await member.call('POST', '/api/user_messages', { group: shared.id, value: 'mine' });
  const [, after] = await member.call('GET', '/api/messenger/unread');
  t.equal(after.groups[shared.id], 0, 'writing does not make a conversation unread to its author');
  t.equal(after.latest[shared.id].value, 'mine', 'and the preview follows whoever spoke last');
});

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
