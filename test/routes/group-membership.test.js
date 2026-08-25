import t from 'tap';

import { asAdmin, asUserWith, call, upload } from '../helper.js';

/**
 * Groups as an ordinary account builds them: start one, invite by an address
 * you already know, and walk out whenever you like.
 *
 * Nothing here goes near PUT /api/user_groups. That is the point — `members` is
 * a privileged relation, so the only ways in and out are the two routes below,
 * and both answer to membership rather than to a permission.
 */

/** Exactly what the seeded `user` role holds: the messenger and nothing else. */
const ORDINARY = [
  'users:read',
  'user_groups:read:member',
  'user_groups:create:own',
  'user_messages:read:member',
  'user_messages:create:member',
  'user_groups:delete:own',
  'files:create:own',
  'files:read:own',
  'files:delete:own',
];

const emailOf = (suffix) => `test${suffix}@example.com`;
const carolEmail = emailOf('-carol');

/** An admin plus three ordinary accounts, each carrying their own id. */
async function cast(t) {
  const { app, cookies: adminCookies, call: adminCall } = await asAdmin(t);

  const people = {};
  for (const name of ['alice', 'bob', 'carol']) {
    people[name] = await asUserWith(t, app, adminCookies, ORDINARY, `-${name}`);
    people[name].email = emailOf(`-${name}`);
  }

  const [, list] = await adminCall('GET', '/api/users');
  for (const [name, person] of Object.entries(people)) {
    person.id = list.users.find((user) => user.email === person.email).id;
    person.name = name;
  }

  return { app, adminCookies, adminCall, ...people };
}

/** A group started by `person`, with the named others invited into it. */
async function groupWith(person, ...invitees) {
  const [, created] = await person.call('POST', '/api/user_groups', {});
  const id = created.user_group.id;
  for (const invitee of invitees) {
    await person.call('POST', `/api/messenger/groups/${id}/invite`, { email: invitee.email });
  }
  return id;
}

const idsOf = (group) => group.members.map((member) => member.id).sort((a, b) => a - b);

/*
 * Read position lives on the membership, which is the whole reason it was moved
 * there: it is a fact about the pair, not about either end of it.
 *
 * The first of these is the bug the move exists to make impossible. Membership
 * used to be rewritten wholesale on every change, so anything kept on the link
 * row was erased by the next invitation — everybody in a conversation would
 * have found it unread again the moment somebody new joined.
 */
t.test('an invitation does not reset what everybody else had read', async (t) => {
  const { app, alice, bob, carol } = await cast(t);

  const [, created] = await alice.call('POST', '/api/user_groups', { owner: alice.id });
  const group = created.user_group;
  await alice.call('POST', `/api/messenger/groups/${group.id}/invite`, { email: bob.email });

  await bob.call('POST', '/api/user_messages', { group: group.id, value: 'first' });
  const [read] = await alice.call('POST', '/api/messenger/read', { group: group.id });
  t.equal(read, 200, 'alice reads the conversation');

  const [, before] = await alice.call('GET', '/api/messenger/unread');
  t.equal(before.groups[group.id], 0, 'and has nothing waiting');

  // The membership rows are rewritten here. They must not be wiped.
  await alice.call('POST', `/api/messenger/groups/${group.id}/invite`, { email: carol.email });

  const [, after] = await alice.call('GET', '/api/messenger/unread');
  t.equal(after.groups[group.id], 0, 'and still has nothing waiting afterwards');

  const [, carolsView] = await carol.call('GET', '/api/messenger/unread');
  t.equal(
    carolsView.groups[group.id], 1,
    'while the new arrival finds the conversation waiting for them'
  );

  t.equal(app.models.user_group_reads, undefined, 'and there is no table of markers left');
});

t.test('leaving takes the read position with it', async (t) => {
  const { alice, bob } = await cast(t);

  const [, created] = await alice.call('POST', '/api/user_groups', { owner: alice.id });
  const group = created.user_group;
  await alice.call('POST', `/api/messenger/groups/${group.id}/invite`, { email: bob.email });
  await alice.call('POST', '/api/user_messages', { group: group.id, value: 'said early' });
  await bob.call('POST', '/api/messenger/read', { group: group.id });

  await bob.call('POST', `/api/messenger/groups/${group.id}/leave`);
  await alice.call('POST', `/api/messenger/groups/${group.id}/invite`, { email: bob.email });

  // Nothing was cleaned up by hand: the link row went, and took the marker.
  const [, unread] = await bob.call('GET', '/api/messenger/unread');
  t.ok(
    unread.groups[group.id] >= 1,
    'coming back, the conversation is new again rather than silently already read'
  );
});

t.test('a group starts with exactly one person in it: whoever made it', async (t) => {
  const { alice, bob } = await cast(t);

  // Naming somebody else as the owner, and a member list besides — both are
  // ignored, one imposed and one privileged.
  const [status, body] = await alice.call('POST', '/api/user_groups', {
    owner: bob.id,
    members: [bob.id],
  });

  t.equal(status, 201);
  t.equal(body.user_group.owner, alice.id, 'it is filed under the caller');
  t.same(idsOf(body.user_group), [alice.id], 'and they are the only member');

  t.equal((await bob.call('GET', '/api/user_groups'))[1].count, 0, 'bob knows nothing of it');
});

t.test('an invitation by exact address shows the group to both people', async (t) => {
  const { alice, bob } = await cast(t);
  const [, created] = await alice.call('POST', '/api/user_groups', {});
  const group = created.user_group.id;

  const [status, body] = await alice.call('POST', `/api/messenger/groups/${group}/invite`, {
    email: bob.email,
  });

  t.equal(status, 200);
  t.same(idsOf(body.user_group), [alice.id, bob.id].sort((a, b) => a - b));

  const [, mine] = await alice.call('GET', '/api/user_groups');
  const [, theirs] = await bob.call('GET', '/api/user_groups');
  t.equal(mine.count, 1);
  t.equal(theirs.count, 1, 'and it is now theirs too');
  t.equal(theirs.user_groups[0].id, group, 'the same group, not a copy of it');

  // Which is the whole point of being in it.
  t.equal(
    (await bob.call('POST', '/api/user_messages', { group, value: 'hello' }))[0],
    201,
    'and they can say something in it'
  );
});

t.test('the address is the whole of the invitation', async (t) => {
  const { alice, bob, carol } = await cast(t);
  const group = await groupWith(alice, bob);

  const [upper, upperBody] = await alice.call(`POST`, `/api/messenger/groups/${group}/invite`, {
    email: carol.email.toUpperCase(),
  });
  t.equal(upper, 200, 'matched case-insensitively, as signing in with it is');
  t.same(idsOf(upperBody.user_group).length, 3);

  const cases = [
    [{ email: 'nobody@example.com' }, 404, /No account uses that address/],
    // A partial match is no match: this is not a search.
    [{ email: 'test-bo' }, 404, /No account uses that address/],
    [{ email: '' }, 400, /email address is required/],
    [{}, 400, /email address is required/],
    // Refused, and named: picking somebody who is already here is a mistake
    // worth being told about rather than a no-op to hide.
    [{ email: bob.email }, 409, /already in this group/],
  ];

  for (const [payload, expected, message] of cases) {
    const [status, body] = await alice.call(
      'POST', `/api/messenger/groups/${group}/invite`, payload
    );
    t.equal(status, expected, `${JSON.stringify(payload)} -> ${expected}`);
    t.match(body.error, message);
  }
});

/**
 * Two members inviting the same newcomer at once.
 *
 * One of them gets there first and the other is told the person is already in —
 * which is the truth by the time it is asked, and the same answer it would give
 * an hour later. What matters is that the loser of the race cannot corrupt the
 * membership: carol is in the group exactly once, not twice and not zero times.
 *
 * This is the shape the refusal has to survive to be worth having. What it must
 * not do is fire for a single invitation submitted twice by one form — see the
 * guard in MessengerPage's handleInvite, which is why that cannot happen.
 */
t.test('two invitations racing for the same person leave them in it once', async (t) => {
  const { alice, bob, adminCall } = await cast(t);
  const group = await groupWith(alice, bob);

  const results = await Promise.all([
    alice.call('POST', `/api/messenger/groups/${group}/invite`, { email: carolEmail }),
    bob.call('POST', `/api/messenger/groups/${group}/invite`, { email: carolEmail }),
  ]);

  const statuses = results.map(([status]) => status).sort((a, b) => a - b);
  t.same(statuses, [200, 409], 'one adds her, the other is told she is already there');
  t.match(
    results.find(([status]) => status === 409)[1].error,
    /already in this group/
  );

  const [, after] = await adminCall('GET', `/api/user_groups/${group}`);
  t.equal(after.user_group.members.length, 3, 'and she is in it once, not twice');
});

t.test('only a member may invite, and any member may', async (t) => {
  const { alice, bob, carol } = await cast(t);
  const group = await groupWith(alice, bob);

  const [status, body] = await carol.call('POST', `/api/messenger/groups/${group}/invite`, {
    email: carol.email,
  });
  t.equal(status, 404, 'a group they are not in is reported missing, not forbidden');
  t.same(body, { ok: false, error: 'User Group not found' });

  // Bob was invited rather than starting it, and can invite in his turn.
  t.equal(
    (await bob.call('POST', `/api/messenger/groups/${group}/invite`, { email: carol.email }))[0],
    200
  );
  t.equal((await carol.call('GET', '/api/user_groups'))[1].count, 1);
});

t.test('a group with somebody still to talk to survives a departure', async (t) => {
  const { alice, bob, carol } = await cast(t);
  const group = await groupWith(alice, bob, carol);
  await alice.call('POST', '/api/user_messages', { group, value: 'hello all' });

  const [status, body] = await carol.call('POST', `/api/messenger/groups/${group}/leave`);
  t.equal(status, 200);
  t.equal(body.removed, false, 'two people is still a conversation');

  const [, remaining] = await alice.call('GET', '/api/user_groups');
  t.same(idsOf(remaining.user_groups[0]), [alice.id, bob.id].sort((a, b) => a - b));

  t.equal((await carol.call('GET', '/api/user_groups'))[1].count, 0, 'and gone for the leaver');
  t.equal(
    (await carol.call('GET', '/api/user_messages'))[1].count,
    0,
    'along with everything said in it'
  );
  t.equal(
    (await carol.call('POST', '/api/user_messages', { group, value: 'still here?' }))[0],
    403,
    'who cannot go on talking in it'
  );
});

t.test('leaving says so in the conversation', async (t) => {
  const { alice, bob, carol } = await cast(t);
  const group = await groupWith(alice, bob, carol);

  await carol.call('POST', `/api/messenger/groups/${group}/leave`);

  const [, thread] = await alice.call('GET', '/api/user_messages');
  const notices = thread.user_messages.filter((message) => message.system);

  t.equal(notices.length, 1, 'one notice, in the group itself');
  t.equal(notices[0].group, group);
  t.equal(notices[0].owner, carol.id, 'carrying the person it is about');
  t.match(notices[0].value, /left the group/);
  t.ok(notices[0].value.includes('Test'), 'and naming them');
});

t.test('a notice is the application talking, not an account', async (t) => {
  const { alice, bob } = await cast(t);
  const group = await groupWith(alice, bob);

  const [status, body] = await alice.call('POST', '/api/user_messages', {
    group,
    value: 'Bob left the group.',
    system: true,
  });

  t.equal(status, 201, 'the message is accepted');
  t.equal(body.user_message.system, false, 'but not as a notice — the field is privileged');
});

t.test('the owner leaving hands the group on rather than ending it', async (t) => {
  const { alice, bob, carol, adminCall } = await cast(t);
  const group = await groupWith(alice, bob, carol);

  const [status, body] = await alice.call('POST', `/api/messenger/groups/${group}/leave`);
  t.equal(status, 200);
  t.equal(body.removed, false);

  const [, survivor] = await adminCall('GET', `/api/user_groups/${group}`);
  t.same(idsOf(survivor.user_group), [bob.id, carol.id].sort((a, b) => a - b));
  t.equal(
    survivor.user_group.owner,
    Math.min(bob.id, carol.id),
    'the oldest account left in it becomes the owner'
  );

  t.equal(
    (await bob.call('GET', `/api/user_groups/${group}`))[0],
    200,
    'and the people still in it still have it'
  );
});

/**
 * The whole of it end to end, because the parts interact: A starts a group,
 * invites B, then invites C, everybody says something, and then A — the owner —
 * walks out.
 *
 * What each of the three can see afterwards is the point. A leaving is not A
 * deleting: what A said stays in the conversation for the people still in it,
 * and stops being readable by A. And a departure is not a bereavement — the
 * group carries on under a new owner.
 */
t.test('A starts a group, invites B and C, then leaves it', async (t) => {
  const { alice: a, bob: b, carol: c, adminCall } = await cast(t);
  const group = await groupWith(a, b, c);

  await a.call('POST', '/api/user_messages', { group, value: 'A: hello both' });
  await b.call('POST', '/api/user_messages', { group, value: 'B: hi' });

  const [, before] = await adminCall('GET', `/api/user_groups/${group}`);
  t.same(idsOf(before.user_group), [a.id, b.id, c.id].sort((x, y) => x - y));
  t.equal(before.user_group.owner, a.id, 'A owns it while A is in it');

  const [status, body] = await a.call('POST', `/api/messenger/groups/${group}/leave`);
  t.equal(status, 200);
  t.equal(body.removed, false, 'two people are left, so there is still a conversation');

  // ── The group ─────────────────────────────────────────────────────────
  const [, after] = await adminCall('GET', `/api/user_groups/${group}`);
  t.same(idsOf(after.user_group), [b.id, c.id].sort((x, y) => x - y), 'B and C remain');
  t.equal(after.user_group.owner, Math.min(b.id, c.id), 'and the group has a new owner');
  t.not(after.user_group.owner, a.id, 'never one who is not in it');

  // ── What A can see ────────────────────────────────────────────────────
  t.equal((await a.call('GET', '/api/user_groups'))[1].count, 0, 'A no longer has the group');
  t.equal(
    (await a.call('GET', '/api/user_messages'))[1].count,
    0,
    'nor anything said in it, including what A said'
  );
  t.equal((await a.call('GET', '/api/messenger/unread'))[1].total, 0, 'and nothing is new to A');

  // ── What B and C can see ──────────────────────────────────────────────
  for (const person of [b, c]) {
    const [, thread] = await person.call('GET', '/api/user_messages');
    t.same(
      thread.user_messages.map((message) => message.value),
      ['A: hello both', 'B: hi', thread.user_messages[2].value],
      `${person.name} keeps the conversation, in order, A's words included`
    );

    const notice = thread.user_messages[2];
    t.ok(notice.system, `${person.name} is told, in the thread itself`);
    t.equal(notice.owner, a.id, 'the notice carries the person it is about');
    t.match(notice.value, /left the group/);
  }

  // Their own words are never news to them, and neither is a notice about
  // somebody else — but everything else in the group is.
  t.equal((await b.call('GET', '/api/messenger/unread'))[1].groups[group], 2, 'B: A + notice');
  t.equal((await c.call('GET', '/api/messenger/unread'))[1].groups[group], 3, 'C: all three');

  // ── Coming back ───────────────────────────────────────────────────────
  const [reinvited] = await b.call('POST', `/api/messenger/groups/${group}/invite`, {
    email: a.email,
  });
  t.equal(reinvited, 200, 'B can invite A back in — leaving is not a ban');

  const [, back] = await a.call('GET', '/api/messenger/unread');
  t.equal(
    back.groups[group],
    1,
    'A returns as any new member would: the message from B is unread again, '
    + 'while what A said and the notice about A are not'
  );
});

t.test('a group with one person left in it is still that person’s group', async (t) => {
  const { alice, bob, adminCall } = await cast(t);
  const group = await groupWith(alice, bob);
  await alice.call('POST', '/api/user_messages', { group, value: 'just us two' });

  const [status, body] = await bob.call('POST', `/api/messenger/groups/${group}/leave`);
  t.equal(status, 200);
  t.equal(body.removed, false, 'somebody is still in it, so it stands');

  const [, survivor] = await adminCall('GET', `/api/user_groups/${group}`);
  t.same(idsOf(survivor.user_group), [alice.id], 'a group of one is a group');
  t.equal(survivor.user_group.owner, alice.id);

  const [, thread] = await alice.call('GET', '/api/user_messages');
  t.same(
    thread.user_messages.map((message) => message.value),
    ['just us two', thread.user_messages[1].value],
    'the conversation is kept'
  );
  t.ok(thread.user_messages[1].system, 'and says who left');

  // Which is the point of keeping it: it is still hers to do something with.
  t.equal(
    (await alice.call('POST', '/api/user_messages', { group, value: 'anyone about?' }))[0],
    201,
    'she can still write in it'
  );
});

/**
 * The rest of that story: B leaves too, and C is the only one left.
 *
 * The two rules meet here, and the removal wins — a notice about B would have
 * nowhere to be and nobody to read it, so C's conversation does not end with a
 * goodbye. It simply stops existing. That is worth knowing rather than
 * discovering: from C's side a group can vanish without a word in it.
 *
 * And it takes everything with it, down through two more models: the messages
 * belong to the group, and an attachment belongs to the message. The bytes
 * behind that attachment go too — see files.test.js, which owns that half.
 */
/**
 * The rest of that story, and the reason leaving and deleting are two things.
 *
 * A goes, then B goes, and C is alone with the conversation. Nothing has been
 * destroyed: C is told who left, owns what is left, and can either bring
 * somebody back into it or throw it away. Both are tried here.
 */
t.test('when B leaves too, C is left owning the conversation', async (t) => {
  const { app, adminCall, alice: a, bob: b, carol: c } = await cast(t);
  const group = await groupWith(a, b, c);

  // C attaches something, so the eventual deletion has to reach past
  // user_messages.
  const uploaded = await app.inject({
    method: 'POST',
    url: '/api/files',
    cookies: c.cookies,
    ...upload([{ name: 'notes.txt', body: 'hello from C' }]),
  });
  const file = uploaded.json().files[0];

  await a.call('POST', '/api/user_messages', { group, value: 'A: hello both' });
  await c.call('POST', '/api/user_messages', {
    group, value: 'C: here is a file', files: [file.id],
  });

  await a.call('POST', `/api/messenger/groups/${group}/leave`);
  await b.call('POST', `/api/messenger/groups/${group}/leave`);

  // ── C is alone in it, and owns it ─────────────────────────────────────
  const [, left] = await c.call('GET', `/api/user_groups/${group}`);
  t.same(idsOf(left.user_group), [c.id], 'C is the only one in it');
  t.equal(left.user_group.owner, c.id, 'and the owner, the column having followed B out');

  const [, thread] = await c.call('GET', '/api/user_messages');
  const notices = thread.user_messages.filter((message) => message.system);
  t.equal(notices.length, 2, 'C was told about both departures');
  t.same(notices.map((notice) => notice.owner), [a.id, b.id], 'in the order they happened');

  // ── Or bring somebody back ────────────────────────────────────────────
  const [reinvited] = await c.call('POST', `/api/messenger/groups/${group}/invite`, {
    email: a.email,
  });
  t.equal(reinvited, 200, 'a group of one is still a group to invite into');
  const [, rejoined] = await c.call('GET', `/api/user_groups/${group}`);
  t.same(idsOf(rejoined.user_group), [a.id, c.id].sort((x, y) => x - y));
  t.equal(
    (await a.call('GET', '/api/user_messages'))[1].count,
    4,
    'and A comes back to the whole conversation, notices about A included'
  );

  // ── Or throw it away, which is the owner’s alone ──────────────────
  t.equal(
    (await a.call('DELETE', `/api/user_groups/${group}`))[0],
    404,
    'not A, who is in it but does not own it'
  );

  const [deleted] = await c.call('DELETE', `/api/user_groups/${group}`);
  t.equal(deleted, 200, 'the owner ends it when the owner decides to');

  t.equal((await adminCall('GET', `/api/user_groups/${group}`))[0], 404, 'the group is gone');
  t.equal((await adminCall('GET', '/api/user_messages'))[1].count, 0, 'and every message in it');
  t.equal(
    (await adminCall('GET', `/api/files/${file.id}`))[0],
    404,
    'down to the attachment on one of them'
  );
  t.equal((await adminCall('GET', '/api/users'))[1].count, 4, 'the people outlive it');
});

/**
 * Deleting a group, and everything that hung off it.
 *
 * Four models deep: the group, the messages in it, the read markers for it, and
 * the attachments on those messages — rows and stored bytes both. The bytes are
 * checked through the download route rather than the filesystem, so the
 * assertion holds whichever provider is configured.
 *
 * Nothing in the application says any of that. The models declare their foreign
 * keys and Postgres does the work; the in-memory driver reads the same
 * declarations and imitates it (see memory-repository.js). This test is what
 * says the two agree.
 */
t.test('deleting a group deletes the whole conversation with it', async (t) => {
  const { app, adminCall, alice, bob } = await cast(t);
  const group = await groupWith(alice, bob);
  const untouched = await groupWith(bob, alice);

  const attach = async (person, name) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/files',
      cookies: person.cookies,
      ...upload([{ name, body: `bytes of ${name}` }]),
    });
    return res.json().files[0];
  };

  const mine = await attach(alice, 'alice.txt');
  const theirs = await attach(bob, 'bob.txt');
  const spared = await attach(bob, 'spared.txt');

  await alice.call('POST', '/api/user_messages', { group, value: 'mine', files: [mine.id] });
  const [, replied] = await bob.call('POST', '/api/user_messages', {
    group, value: 'theirs', files: [theirs.id],
  });
  await alice.call('POST', '/api/user_messages', {
    group, value: 'an answer', reply_to: replied.user_message.id,
  });
  // In the other group, so it must survive: the cascade has to follow the key,
  // not the model.
  await bob.call('POST', '/api/user_messages', {
    group: untouched, value: 'elsewhere', files: [spared.id],
  });

  // Read markers exist only once somebody has looked.
  await alice.call('POST', '/api/messenger/read', { group });
  await bob.call('POST', '/api/messenger/read', { group });

  t.equal((await adminCall('GET', '/api/user_messages'))[1].count, 4, 'four messages in total');
  t.equal((await adminCall('GET', '/api/files'))[1].count, 3, 'three attachments');
  for (const file of [mine, theirs, spared]) {
    t.equal(
      (await app.inject({ method: 'GET', url: `/api/files/${file.id}/content`,
        cookies: alice.cookies }))
        .statusCode,
      200,
      `${file.name} is readable while its message stands`
    );
  }

  t.equal((await alice.call('DELETE', `/api/user_groups/${group}`))[0], 200);

  // ── Gone ──────────────────────────────────────────────────────────────
  t.equal((await adminCall('GET', `/api/user_groups/${group}`))[0], 404, 'the group');
  t.same(
    (await adminCall('GET', '/api/user_messages'))[1].user_messages.map((m) => m.value),
    ['elsewhere'],
    'every message in it, the reply among them'
  );
  t.same(
    (await adminCall('GET', '/api/files'))[1].files.map((file) => file.name),
    ['spared.txt'],
    'and the attachment rows on those messages'
  );
  for (const file of [mine, theirs]) {
    const res = await app.inject({
      method: 'GET', url: `/api/files/${file.id}/content`, cookies: alice.cookies,
    });
    t.equal(res.statusCode, 404, `${file.name} cannot be downloaded either`);
  }

  // ── Spared ────────────────────────────────────────────────────────────
  t.equal((await adminCall('GET', `/api/user_groups/${untouched}`))[0], 200, 'the other group');
  t.equal(
    (await app.inject({ method: 'GET', url: `/api/files/${spared.id}/content`,
      cookies: bob.cookies })).statusCode,
    200,
    'and the attachment in it'
  );

  // Nothing is left pointing at a group that is not there: a member-scoped read
  // resolves membership through the group, so an orphan would simply be
  // invisible rather than absent, which is why the admin does the counting above.
  t.equal((await alice.call('GET', '/api/user_groups'))[1].count, 1, 'one group each remains');
  t.equal((await bob.call('GET', '/api/messenger/unread'))[1].groups[group], undefined);
});

/**
 * The two-person case, which is how a group ends up owned by its last member.
 *
 * Distinct from the three-person handover above because Math.min over a single
 * remaining member is the edge of that rule, and because the result — one
 * person, owning the group they are alone in — is what the messenger header
 * then has to describe.
 */
t.test('the owner leaving a pair hands the group to the one left', async (t) => {
  const { alice, bob, adminCall } = await cast(t);
  const group = await groupWith(alice, bob);
  await alice.call('POST', '/api/user_messages', { group, value: 'before I go' });

  const [status, body] = await alice.call('POST', `/api/messenger/groups/${group}/leave`);
  t.equal(status, 200);
  t.equal(body.removed, false, 'one person left is still somebody');

  const [, kept] = await adminCall('GET', `/api/user_groups/${group}`);
  t.same(idsOf(kept.user_group), [bob.id], 'bob alone');
  t.equal(kept.user_group.owner, bob.id, 'and bob owns it, the column having followed alice out');

  // Which is the point of the handover: the last member can end it.
  t.equal((await bob.call('DELETE', `/api/user_groups/${group}`))[0], 200);
});

t.test('a group with nobody left in it at all goes', async (t) => {
  const { alice, adminCall } = await cast(t);
  const [, created] = await alice.call('POST', '/api/user_groups', {});
  const group = created.user_group.id;

  // The one case where leaving removes a group: there is no member left to
  // read it, to invite anybody into it, or to delete it.
  const [status, body] = await alice.call('POST', `/api/messenger/groups/${group}/leave`);
  t.equal(status, 200);
  t.equal(body.removed, true);
  t.equal((await adminCall('GET', `/api/user_groups/${group}`))[0], 404);
});

t.test('leaving a group you are not in is nothing to report', async (t) => {
  const { alice, bob, carol, adminCall } = await cast(t);
  const group = await groupWith(alice, bob);

  const [status, body] = await carol.call('POST', `/api/messenger/groups/${group}/leave`);
  t.equal(status, 404);
  t.same(body, { ok: false, error: 'User Group not found' });

  t.equal((await adminCall('GET', `/api/user_groups/${group}`))[0], 200, 'and changes nothing');

  for (const url of [
    `/api/messenger/groups/9999/leave`,
    `/api/messenger/groups/nonsense/leave`,
    `/api/messenger/groups/9999/invite`,
  ]) {
    t.equal((await alice.call('POST', url, { email: bob.email }))[0], 404, url);
  }
});

t.test('an administrator holds the group without being in it', async (t) => {
  const { alice, bob, adminCall } = await cast(t);
  const group = await groupWith(alice, bob);

  // Unscoped user_groups:read, so the group is readable — but membership is
  // what the two routes answer to, and the admin has none here.
  t.equal((await adminCall('GET', `/api/user_groups/${group}`))[0], 200);
  t.equal(
    (await adminCall('POST', `/api/messenger/groups/${group}/invite`, { email: bob.email }))[0],
    404,
    'inviting into a conversation they are not in is not theirs to do'
  );
  t.equal(
    (await adminCall('POST', `/api/messenger/groups/${group}/leave`))[0],
    404,
    'and neither is leaving one'
  );
});

t.test('both routes need a session', async (t) => {
  const { app, alice, bob } = await cast(t);
  const group = await groupWith(alice, bob);

  for (const url of [
    `/api/messenger/groups/${group}/invite`,
    `/api/messenger/groups/${group}/leave`,
  ]) {
    const [status, body] = await call(app, 'POST', url, { email: bob.email });
    t.equal(status, 401, url);
    t.match(body.error, /Authentication required/);
  }
});

t.test('a disabled account is not somebody to invite', async (t) => {
  const { alice, bob, adminCall } = await cast(t);
  const [, created] = await alice.call('POST', '/api/user_groups', {});
  const group = created.user_group.id;

  await adminCall('PUT', `/api/users/${bob.id}`, { is_active: false });

  const [status, body] = await alice.call('POST', `/api/messenger/groups/${group}/invite`, {
    email: bob.email,
  });
  t.equal(status, 404, 'an account that cannot sign in cannot read the conversation');
  t.match(body.error, /No account uses that address/);
});
