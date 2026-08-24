import t from 'tap';

import { asAdmin, asUserWith } from '../helper.js';

/** The admin is the only user a fresh app has; tests that need more make them. */
async function extraUser(call, suffix) {
  const [, body] = await call('POST', '/api/users', {
    email: `member${suffix}@example.com`,
    first_name: 'Mem',
    last_name: `Ber${suffix}`,
    password: 'Passw0rd!',
  });
  return body.user;
}

t.test('POST /api/user_groups records an owner and members', async (t) => {
  const { call } = await asAdmin(t);
  const member = await extraUser(call, '1');

  const [status, body] = await call('POST', '/api/user_groups', {
    owner: 1,
    members: [1, member.id],
  });

  t.equal(status, 201);
  t.equal(body.ok, true);
  t.equal(body.user_group.owner, 1, 'the owner comes back as an id');
  t.match(
    body.user_group.uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'and the row carries a global identifier'
  );
  t.ok(body.user_group.created_at, 'created_at is stamped by the table itself');
  t.same(
    body.user_group.members.map((user) => user.email).sort(),
    ['admin@example.com', 'member1@example.com'],
    'members are expanded into user rows'
  );
  t.notMatch(JSON.stringify(body), /password|\$2[aby]\$/, 'and carry no credential material');
});

t.test('GET /api/user_groups', async (t) => {
  const { call } = await asAdmin(t);
  t.same((await call('GET', '/api/user_groups'))[1], { ok: true, count: 0, user_groups: [] });

  const [, created] = await call('POST', '/api/user_groups', { owner: 1, members: [1] });

  const [status, list] = await call('GET', '/api/user_groups');
  t.equal(status, 200);
  t.equal(list.count, 1);

  const [okStatus, single] = await call('GET', `/api/user_groups/${created.user_group.id}`);
  t.equal(okStatus, 200);
  t.equal(single.user_group.id, created.user_group.id);

  const [missing, missingBody] = await call('GET', '/api/user_groups/9999');
  t.equal(missing, 404);
  t.same(missingBody, { ok: false, error: 'User Group not found' });
});

t.test('POST /api/user_groups rejects bad input', async (t) => {
  const { call } = await asAdmin(t);

  const cases = [
    [{ members: [1] }, /Owner is required/],
    [{ owner: 'nobody' }, /is not a row id/],
    [{ owner: 1, members: 1 }, /must be an array/],
    [{ owner: 1, members: ['everyone'] }, /Invalid members id/],
  ];

  for (const [payload, expected] of cases) {
    const [status, body] = await call('POST', '/api/user_groups', payload);
    t.equal(status, 400, `${JSON.stringify(payload)} is rejected`);
    t.match(body.error, expected);
  }
});

t.test('PUT /api/user_groups/:id changes membership', async (t) => {
  const { call } = await asAdmin(t);
  const member = await extraUser(call, '2');
  const [, created] = await call('POST', '/api/user_groups', { owner: 1, members: [1] });
  const { id, uuid } = created.user_group;

  const [status, body] = await call('PUT', `/api/user_groups/${id}`, {
    members: [1, member.id],
  });
  t.equal(status, 200);
  t.equal(body.user_group.members.length, 2, 'a member was added');
  t.equal(body.user_group.uuid, uuid, 'the identifier is not touched by a write');

  const [emptied] = await call('PUT', `/api/user_groups/${id}`, { members: [] });
  t.equal(emptied, 200, 'a group may have no members');

  const [reowned, reownedBody] = await call('PUT', `/api/user_groups/${id}`, {
    owner: member.id,
  });
  t.equal(reowned, 200, 'an unscoped caller may hand a group to someone else');
  t.equal(reownedBody.user_group.owner, member.id);

  t.equal((await call('PUT', '/api/user_groups/9999', { members: [] }))[0], 404);
});

t.test('DELETE /api/user_groups/:id', async (t) => {
  const { call } = await asAdmin(t);
  const [, created] = await call('POST', '/api/user_groups', { owner: 1, members: [1] });
  const { id } = created.user_group;

  const [status, body] = await call('DELETE', `/api/user_groups/${id}`);
  t.equal(status, 200);
  t.match(body.message, /deleted successfully/);

  t.equal((await call('DELETE', `/api/user_groups/${id}`))[0], 404, 'already gone');
  t.equal((await call('GET', '/api/user_groups'))[1].count, 0);
  t.equal((await call('GET', '/api/users'))[1].count, 1, 'and the members outlive the group');
});

/**
 * Someone holding nothing but the own-scoped permissions, plus their user id
 * so a test can tell their rows from anybody else's.
 */
async function ownScoped(t, app, adminCookies, adminCall, actions, suffix) {
  const actor = await asUserWith(
    t,
    app,
    adminCookies,
    actions.map((action) => `user_groups:${action}:own`),
    suffix
  );
  const [, list] = await adminCall('GET', '/api/users');
  const row = list.users.find((user) => user.email === `test${suffix}@example.com`);
  return { ...actor, id: row.id };
}

t.test('an own-scoped caller only ever sees their own groups', async (t) => {
  const { app, cookies, call: adminCall } = await asAdmin(t);
  const actor = await ownScoped(t, app, cookies, adminCall, ['read'], '-reader');

  const [, mine] = await adminCall('POST', '/api/user_groups', { owner: actor.id, members: [1] });
  const [, theirs] = await adminCall('POST', '/api/user_groups', { owner: 1, members: [actor.id] });

  const [status, list] = await actor.call('GET', '/api/user_groups');
  t.equal(status, 200, 'the own-scoped permission opens the route');
  t.equal(list.count, 1, 'and closes it around one row');
  t.equal(list.user_groups[0].id, mine.user_group.id);

  t.equal(
    (await actor.call('GET', `/api/user_groups/${mine.user_group.id}`))[0],
    200,
    'their own group is readable by id'
  );
  t.equal(
    (await actor.call('GET', `/api/user_groups/${theirs.user_group.id}`))[0],
    404,
    'and a group they merely belong to is reported missing, not forbidden'
  );

  t.equal((await adminCall('GET', '/api/user_groups'))[1].count, 2, 'while an admin sees both');
});

t.test('an own-scoped create is filed under the caller, whatever they ask for', async (t) => {
  const { app, cookies, call: adminCall } = await asAdmin(t);
  const actor = await ownScoped(t, app, cookies, adminCall, ['create', 'read'], '-author');

  const [status, body] = await actor.call('POST', '/api/user_groups', {
    owner: 1,
    members: [actor.id],
  });

  t.equal(status, 201);
  t.equal(body.user_group.owner, actor.id, 'the owner they named was ignored');
  t.equal((await actor.call('GET', '/api/user_groups'))[1].count, 1, 'and it is theirs to see');
});

t.test('an own-scoped write cannot reach another owner row', async (t) => {
  const { app, cookies, call: adminCall } = await asAdmin(t);
  const actor = await ownScoped(
    t, app, cookies, adminCall, ['read', 'update', 'delete'], '-writer'
  );

  const [, mine] = await adminCall('POST', '/api/user_groups', { owner: actor.id, members: [] });
  const [, theirs] = await adminCall('POST', '/api/user_groups', { owner: 1, members: [] });

  t.equal(
    (await actor.call('PUT', `/api/user_groups/${mine.user_group.id}`, { members: [1] }))[0],
    200,
    'their own group is theirs to change'
  );
  t.equal(
    (await actor.call('PUT', `/api/user_groups/${theirs.user_group.id}`, { members: [] }))[0],
    404
  );
  t.equal((await actor.call('DELETE', `/api/user_groups/${theirs.user_group.id}`))[0], 404);

  const [, survivor] = await adminCall('GET', `/api/user_groups/${theirs.user_group.id}`);
  t.equal(survivor.user_group.id, theirs.user_group.id, 'the other group is untouched');

  const [handedOff] = await actor.call('PUT', `/api/user_groups/${mine.user_group.id}`, {
    owner: 1,
  });
  t.equal(handedOff, 200);
  t.equal(
    (await adminCall('GET', `/api/user_groups/${mine.user_group.id}`))[1].user_group.owner,
    actor.id,
    'and they cannot give their own group away and lose sight of it'
  );

  t.equal((await actor.call('DELETE', `/api/user_groups/${mine.user_group.id}`))[0], 200);
});

t.test('an own-scoped permission grants nothing beyond its own action', async (t) => {
  const { app, cookies, call: adminCall } = await asAdmin(t);
  const actor = await ownScoped(t, app, cookies, adminCall, ['read'], '-narrow');

  const denied = [
    ['POST', '/api/user_groups', { owner: actor.id }],
    ['PUT', '/api/user_groups/1', { members: [] }],
    ['DELETE', '/api/user_groups/1', undefined],
  ];

  for (const [method, url, payload] of denied) {
    const [status, body] = await actor.call(method, url, payload);
    t.equal(status, 403, `${method} ${url} is refused`);
    t.match(body.error, /Missing required permission: user_groups:/);
    t.notMatch(body.error, /:own/, 'the refusal does not advertise the scoped variant');
  }
});

t.test('deleting a member removes them from the groups they were in', async (t) => {
  const { call } = await asAdmin(t);
  const member = await extraUser(call, '3');
  const [, created] = await call('POST', '/api/user_groups', {
    owner: 1,
    members: [1, member.id],
  });

  await call('DELETE', `/api/users/${member.id}`);

  const [, body] = await call('GET', `/api/user_groups/${created.user_group.id}`);
  t.same(body.user_group.members.map((user) => user.id), [1], 'the membership row goes with them');
});
