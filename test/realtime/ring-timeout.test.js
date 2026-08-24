import t from 'tap';

// A one-second ring, so the test does not sit through the real forty. Set
// before the helper loads the server, and dynamically imported for the same
// reason — see test/routes/ice.test.js.
process.env.CALL_RING_SECONDS = '1';

const { call, login, asUserWith, connect, listening } = await import('../helper.js');

/** An admin and one member who is never going to pick up. */
async function group(t) {
  const app = await listening(t);
  const adminCookies = await login(app);

  const member = await asUserWith(
    t, app, adminCookies, ['user_groups:read:member'], '-ring'
  );

  const [, listed] = await call(app, 'GET', '/api/users', undefined, adminCookies);
  member.id = listed.users.find((user) => user.email === 'test-ring@example.com').id;

  const [, created] = await call(app, 'POST', '/api/user_groups', {
    owner: 1, members: [1, member.id],
  }, adminCookies);

  return { app, adminCookies, member, group: created.user_group };
}

t.test('a call nobody answers gives up, and says so to the caller', async (t) => {
  const { app, adminCookies, member, group: shared } = await group(t);

  const caller = await connect(app, adminCookies);
  const ignored = await connect(app, member.cookies);
  await Promise.all([caller.waitFor('hello'), ignored.waitFor('hello')]);

  caller.send({ type: 'call:start', group: shared.id });
  await Promise.all([caller.waitFor('call:state'), ignored.waitFor('call:ringing')]);

  const gaveUp = await caller.waitFor('call:ended', 'the call to give up');
  t.equal(gaveUp.reason, 'unanswered', 'the caller is told why the ringing stopped');

  const dismissed = await ignored.waitFor('call:ended', 'the popup to close');
  t.equal(dismissed.reason, 'ended', 'and a missed call just closes its popup');

  // The call is gone rather than merely quiet: the same group can be called
  // again, from the same tab, as if nothing had happened.
  caller.send({ type: 'call:start', group: shared.id });
  const again = await caller.waitFor(
    (frame) => frame.type === 'call:state' && frame.peers.length === 0,
    'a second call to the same group'
  );
  t.equal(again.group, shared.id, 'the group is free to be called again');

  await Promise.all([caller.close(), ignored.close()]);
});

t.test('answering in time stops the clock', async (t) => {
  const { app, adminCookies, member, group: shared } = await group(t);

  const caller = await connect(app, adminCookies);
  const answerer = await connect(app, member.cookies);
  await Promise.all([caller.waitFor('hello'), answerer.waitFor('hello')]);

  caller.send({ type: 'call:start', group: shared.id });
  await answerer.waitFor('call:ringing');
  answerer.send({ type: 'call:join', group: shared.id });
  await caller.waitFor('call:peer-joined');

  // Well past the ring, which is now somebody else's problem: a conversation
  // in progress must never be hung up by the timer that was waiting for it.
  await new Promise((resolve) => setTimeout(resolve, 1400));

  t.notOk(
    caller.frames.some((frame) => frame.type === 'call:ended'),
    'a call that was answered is still going'
  );
  t.notOk(
    answerer.frames.some((frame) => frame.type === 'call:ended'),
    'at both ends'
  );

  await Promise.all([caller.close(), answerer.close()]);
});
