import t from 'tap';

import { call, login, asUserWith, connect, listening } from '../helper.js';

/**
 * Membership changes over the socket.
 *
 * An invitation and a departure are both news to more than one person, and to
 * each of them differently: whoever is in the group now gets the group, and
 * whoever has just stopped being in it gets its id and nothing else. Which
 * makes the second one the interesting case — the person a removal is about is,
 * by the time it happens, no longer a member of anything, so the audience
 * cannot be worked out from membership alone.
 */

const ORDINARY = [
  'users:read',
  'user_groups:read:member',
  'user_groups:create:own',
  'user_groups:delete:own',
  'user_messages:read:member',
  'user_messages:create:member',
];

async function cast(t) {
  const app = await listening(t);
  const adminCookies = await login(app);
  const adminCall = (method, url, payload) => call(app, method, url, payload, adminCookies);

  const people = {};
  for (const name of ['alice', 'bob', 'carol']) {
    people[name] = await asUserWith(t, app, adminCookies, ORDINARY, `-${name}`);
    people[name].email = `test-${name}@example.com`;
  }

  const [, list] = await adminCall('GET', '/api/users');
  for (const person of Object.values(people)) {
    person.id = list.users.find((user) => user.email === person.email).id;
  }

  return { app, adminCall, ...people };
}

t.test('an invitation puts the group on the invitee’s screen', async (t) => {
  const { app, alice, bob, carol } = await cast(t);

  const bobSocket = await connect(app, bob.cookies);
  const carolSocket = await connect(app, carol.cookies);
  await Promise.all([bobSocket.waitFor('hello'), carolSocket.waitFor('hello')]);

  const [, created] = await alice.call('POST', '/api/user_groups', {});
  const group = created.user_group.id;
  await alice.call('POST', '/api/user_messages', { group, value: 'anyone there?' });

  await alice.call('POST', `/api/messenger/groups/${group}/invite`, { email: bob.email });

  const arrived = await bobSocket.waitFor('group', 'the group they were invited to');
  t.equal(arrived.group.id, group, 'delivered without being asked for');
  t.same(
    arrived.group.members.map((member) => member.id).sort((a, b) => a - b),
    [alice.id, bob.id].sort((a, b) => a - b),
    'with both people in it'
  );

  const counted = await bobSocket.waitFor(
    (frame) => frame.type === 'unread' && frame.total > 0,
    'what was said before they arrived'
  );
  t.equal(counted.groups[group], 1, 'a conversation joined is a conversation to catch up on');

  t.notOk(
    carolSocket.frames.some((frame) => frame.type === 'group'),
    'somebody else’s group never reached them'
  );

  await bobSocket.close();
  await carolSocket.close();
});

t.test('leaving tells the people still there, and the one who left', async (t) => {
  const { app, alice, bob, carol } = await cast(t);
  const [, created] = await alice.call('POST', '/api/user_groups', {});
  const group = created.user_group.id;
  await alice.call('POST', `/api/messenger/groups/${group}/invite`, { email: bob.email });
  await alice.call('POST', `/api/messenger/groups/${group}/invite`, { email: carol.email });

  const aliceSocket = await connect(app, alice.cookies);
  const carolSocket = await connect(app, carol.cookies);
  await Promise.all([aliceSocket.waitFor('hello'), carolSocket.waitFor('hello')]);

  await carol.call('POST', `/api/messenger/groups/${group}/leave`);

  const changed = await aliceSocket.waitFor('group', 'the group, one member lighter');
  t.same(
    changed.group.members.map((member) => member.id).sort((a, b) => a - b),
    [alice.id, bob.id].sort((a, b) => a - b)
  );

  // The notice travels as an ordinary message, which is what gets it delivered.
  const notice = await aliceSocket.waitFor(
    (frame) => frame.type === 'message' && frame.message.system,
    'the departure notice'
  );
  t.match(notice.message.value, /left the group/);
  t.equal(notice.message.group, group);

  const gone = await carolSocket.waitFor('group-gone', 'the group they walked out of');
  t.equal(gone.id, group);
  t.notOk(
    carolSocket.frames.some((frame) => frame.type === 'group'),
    'and the row itself never followed them out'
  );
  t.notOk(
    carolSocket.frames.some((frame) => frame.type === 'message'),
    'nor did anything said about them after they went'
  );

  await aliceSocket.close();
  await carolSocket.close();
});

t.test('a group the owner deletes leaves every screen it was on', async (t) => {
  const { app, alice, bob, carol } = await cast(t);
  const [, created] = await alice.call('POST', '/api/user_groups', {});
  const group = created.user_group.id;
  await alice.call('POST', `/api/messenger/groups/${group}/invite`, { email: bob.email });
  await alice.call('POST', `/api/messenger/groups/${group}/invite`, { email: carol.email });

  const sockets = {
    alice: await connect(app, alice.cookies),
    bob: await connect(app, bob.cookies),
    carol: await connect(app, carol.cookies),
  };
  await Promise.all(Object.values(sockets).map((socket) => socket.waitFor('hello')));

  // Ending it is the owner's own decision, taken deliberately — people leaving
  // never destroys a group anybody is still in.
  t.equal((await alice.call('DELETE', `/api/user_groups/${group}`))[0], 200);

  for (const [who, socket] of Object.entries(sockets)) {
    const gone = await socket.waitFor('group-gone', `the removal reaching ${who}`);
    t.equal(gone.id, group, `${who} is told, owner and member alike`);
    t.notOk(
      socket.frames.some((frame) => frame.type === 'group'),
      `and ${who} is not sent a group that no longer exists`
    );
  }

  await Promise.all(Object.values(sockets).map((socket) => socket.close()));
});

t.test('the last member left in a group keeps it, and is told who went', async (t) => {
  const { app, alice, bob } = await cast(t);
  const [, created] = await alice.call('POST', '/api/user_groups', {});
  const group = created.user_group.id;
  await alice.call('POST', `/api/messenger/groups/${group}/invite`, { email: bob.email });

  const aliceSocket = await connect(app, alice.cookies);
  await aliceSocket.waitFor('hello');

  const [, body] = await bob.call('POST', `/api/messenger/groups/${group}/leave`);
  t.equal(body.removed, false, 'one person left in it is not nobody');

  const kept = await aliceSocket.waitFor('group', 'the group, one member lighter');
  t.same(kept.group.members.map((member) => member.id), [alice.id], 'and it is hers alone');

  const notice = await aliceSocket.waitFor(
    (frame) => frame.type === 'message' && frame.message.system,
    'being told that bob went'
  );
  t.match(notice.message.value, /left the group/);

  t.notOk(
    aliceSocket.frames.some((frame) => frame.type === 'group-gone'),
    'nothing was taken away from her'
  );

  await aliceSocket.close();
});

/**
 * The handover, live.
 *
 * bob owns the group and walks out of it, leaving alice. What alice's screen has
 * to learn is not only that bob has gone but that the group is now hers — the
 * header names its owner, and an owner who left is the one thing it must not
 * still be naming.
 */
t.test('the new owner arrives with the group it was handed to', async (t) => {
  const { app, alice, bob } = await cast(t);
  const [, created] = await bob.call('POST', '/api/user_groups', {});
  const group = created.user_group.id;
  await bob.call('POST', `/api/messenger/groups/${group}/invite`, { email: alice.email });

  const aliceSocket = await connect(app, alice.cookies);
  await aliceSocket.waitFor('hello');

  t.equal(
    (await alice.call('GET', `/api/user_groups/${group}`))[1].user_group.owner,
    bob.id,
    'bob owns it to begin with'
  );

  await bob.call('POST', `/api/messenger/groups/${group}/leave`);

  const frame = await aliceSocket.waitFor('group', 'the group, handed over');
  t.same(frame.group.members.map((member) => member.id), [alice.id]);
  t.equal(frame.group.owner, alice.id, 'the frame carries the new owner, not the one who left');

  await aliceSocket.close();
});

t.test('a member the dashboard removes is told, without being sent the group', async (t) => {
  const { app, adminCall, alice, bob } = await cast(t);
  const [, created] = await alice.call('POST', '/api/user_groups', {});
  const group = created.user_group.id;
  await alice.call('POST', `/api/messenger/groups/${group}/invite`, { email: bob.email });

  const bobSocket = await connect(app, bob.cookies);
  await bobSocket.waitFor('hello');

  // Not the leave route: an unscoped PUT, which is the one write that can take
  // somebody out of a group without their doing anything. The pre-change row
  // travelling with the event is what makes them findable at all.
  await adminCall('PUT', `/api/user_groups/${group}`, { members: [alice.id] });

  const gone = await bobSocket.waitFor('group-gone', 'the group being taken away');
  t.equal(gone.id, group);
  t.notOk(
    bobSocket.frames.some((frame) => frame.type === 'group'),
    'a group they are no longer in is not sent to them'
  );

  await bobSocket.close();
});
