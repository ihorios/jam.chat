import t from 'tap';

import { call, login, asUserWith, connect, eventually, listening } from '../helper.js';

/**
 * Signalling only: no browser, no media, and the payloads are strings that say
 * what they are. That is the point of relaying an opaque blob — the server's
 * whole job can be tested without WebRTC being involved at all.
 */

/** A group holding the admin and two members, plus somebody outside it. */
async function callable(t) {
  const app = await listening(t);
  const adminCookies = await login(app);
  const adminCall = (method, url, payload) => call(app, method, url, payload, adminCookies);

  const permissions = ['user_groups:read:member', 'user_messages:read:member'];
  const member = await asUserWith(t, app, adminCookies, permissions, '-call1');
  const second = await asUserWith(t, app, adminCookies, permissions, '-call2');
  const outsider = await asUserWith(t, app, adminCookies, permissions, '-callout');

  const [, listed] = await adminCall('GET', '/api/users');
  const idOf = (suffix) => listed.users.find((user) => user.email === `test${suffix}@example.com`).id;
  member.id = idOf('-call1');
  second.id = idOf('-call2');
  outsider.id = idOf('-callout');

  const [, created] = await adminCall('POST', '/api/user_groups', {
    owner: 1, members: [1, member.id, second.id],
  });

  return { app, adminCookies, adminCall, member, second, outsider, group: created.user_group };
}

/** A connected socket that has said hello, with its connection id to hand. */
async function tab(app, cookies) {
  const socket = await connect(app, cookies);
  socket.id = (await socket.waitFor('hello')).connectionId;
  return socket;
}

t.test('calling a group rings its members, and nobody else', async (t) => {
  const { app, adminCookies, member, outsider, group } = await callable(t);

  const caller = await tab(app, adminCookies);
  const answerer = await tab(app, member.cookies);
  const bystander = await tab(app, outsider.cookies);

  caller.send({ type: 'call:start', group: group.id });

  const state = await caller.waitFor('call:state', 'the caller own view of the call');
  t.equal(state.group, group.id);
  t.equal(state.self, caller.id, 'a participant is a connection, not a person');
  t.same(state.peers, [], 'nobody has answered yet');

  const ringing = await answerer.waitFor('call:ringing', 'the popup');
  t.equal(ringing.group, group.id);
  t.equal(ringing.from.connectionId, caller.id, 'and it says which tab is calling');
  t.match(ringing.from, { name: 'System Admin' }, 'named, so the popup can say who');

  // Both sockets are rung by one fan-out, so the outsider's silence at the
  // moment the member's popup appeared is the whole of the assertion.
  t.notOk(
    bystander.frames.some((frame) => frame.type === 'call:ringing'),
    'somebody outside the group is never rung'
  );

  await Promise.all([caller.close(), answerer.close(), bystander.close()]);
});

t.test('answering joins the call at both ends', async (t) => {
  const { app, adminCookies, member, group } = await callable(t);

  const caller = await tab(app, adminCookies);
  const answerer = await tab(app, member.cookies);

  caller.send({ type: 'call:start', group: group.id });
  await answerer.waitFor('call:ringing');

  answerer.send({ type: 'call:join', group: group.id });

  const joined = await answerer.waitFor('call:state', 'what the answerer joined');
  t.equal(joined.self, answerer.id);
  t.equal(joined.peers.length, 1, 'the caller is already there');
  t.match(joined.peers[0], { connectionId: caller.id, name: 'System Admin' });

  const announced = await caller.waitFor('call:peer-joined', 'the caller being told');
  t.equal(announced.peer.connectionId, answerer.id);
  t.equal(announced.peer.userId, member.id, 'and who is behind that tab');

  await Promise.all([caller.close(), answerer.close()]);
});

t.test('signals reach the named peer, and only a peer can send one', async (t) => {
  const { app, adminCookies, member, outsider, group } = await callable(t);

  const caller = await tab(app, adminCookies);
  const answerer = await tab(app, member.cookies);
  const bystander = await tab(app, outsider.cookies);

  caller.send({ type: 'call:start', group: group.id });
  await answerer.waitFor('call:ringing');
  answerer.send({ type: 'call:join', group: group.id });
  await caller.waitFor('call:peer-joined');

  // The joining peer offers; the incumbent answers. The server neither knows
  // nor cares what an offer is.
  answerer.send({
    type: 'call:signal',
    group: group.id,
    to: caller.id,
    payload: { kind: 'offer', sdp: 'v=0 pretend' },
  });

  const offer = await caller.waitFor('call:signal', 'the relayed offer');
  t.equal(offer.from, answerer.id, 'stamped with who sent it, not who claims to have');
  t.same(offer.payload, { kind: 'offer', sdp: 'v=0 pretend' }, 'and passed through untouched');

  caller.send({
    type: 'call:signal',
    group: group.id,
    to: answerer.id,
    payload: { kind: 'answer', sdp: 'v=0 also pretend' },
  });
  t.equal((await answerer.waitFor('call:signal')).payload.kind, 'answer', 'and back again');

  // The guard the whole feature rests on: without it this is an authenticated
  // way to send anything to any socket in the system.
  bystander.send({ type: 'call:signal', group: group.id, to: caller.id, payload: 'let me in' });
  t.match(
    (await bystander.waitFor('error')).error,
    /not in that call/,
    'a stranger cannot signal into a call'
  );

  caller.send({ type: 'call:signal', group: group.id, to: bystander.id, payload: 'hello?' });
  t.match(
    (await caller.waitFor('error')).error,
    /not in the call/,
    'nor can a participant signal out of one'
  );
  t.notOk(
    bystander.frames.some((frame) => frame.type === 'call:signal'),
    'and nothing reached the socket either refusal was about'
  );

  await Promise.all([caller.close(), answerer.close(), bystander.close()]);
});

t.test('leaving ends the call for the leaver only, until the last one goes', async (t) => {
  const { app, adminCookies, member, second, group } = await callable(t);

  const caller = await tab(app, adminCookies);
  const answerer = await tab(app, member.cookies);
  const neverAnswers = await tab(app, second.cookies);

  caller.send({ type: 'call:start', group: group.id });
  await Promise.all([answerer.waitFor('call:ringing'), neverAnswers.waitFor('call:ringing')]);
  answerer.send({ type: 'call:join', group: group.id });
  await caller.waitFor('call:peer-joined');

  answerer.send({ type: 'call:leave', group: group.id });

  const forTheLeaver = await answerer.waitFor('call:ended', 'the leaver being released');
  t.equal(forTheLeaver.reason, 'left', 'their window closes');

  const departed = await caller.waitFor('call:peer-left', 'the caller being told');
  t.equal(departed.peer.connectionId, answerer.id);
  t.notOk(
    caller.frames.some((frame) => frame.type === 'call:ended'),
    'but the call itself carries on for whoever is still in it'
  );

  // The last participant leaves, so there is nothing left to answer.
  caller.send({ type: 'call:leave', group: group.id });
  t.equal((await caller.waitFor('call:ended')).reason, 'left');

  const stopRinging = await neverAnswers.waitFor('call:ended', 'the unanswered popup closing');
  t.equal(stopRinging.reason, 'ended', 'a popup for a call nobody is in is dismissed');

  await Promise.all([caller.close(), answerer.close(), neverAnswers.close()]);
});

t.test('a socket that drops has hung up', async (t) => {
  const { app, adminCookies, member, group } = await callable(t);

  const caller = await tab(app, adminCookies);
  const answerer = await tab(app, member.cookies);

  caller.send({ type: 'call:start', group: group.id });
  await answerer.waitFor('call:ringing');
  answerer.send({ type: 'call:join', group: group.id });
  await caller.waitFor('call:peer-joined');

  await answerer.close();

  const departed = await caller.waitFor('call:peer-left', 'the closed tab leaving the call');
  t.equal(departed.peer.connectionId, answerer.id, 'a closed tab and a hangup are the same thing');

  await caller.close();
});

t.test('a call belongs to the group, and a tab to one call', async (t) => {
  const { app, adminCookies, adminCall, outsider, member, group } = await callable(t);

  const stranger = await tab(app, outsider.cookies);
  stranger.send({ type: 'call:start', group: group.id });
  t.match(
    (await stranger.waitFor('error')).error,
    /not found/,
    'a group you are not in is a group you cannot call'
  );

  // A second refusal, counted rather than awaited: both say the same thing, so
  // waiting for "an error" would match the one already in the queue.
  stranger.send({ type: 'call:join', group: group.id });
  t.ok(
    await eventually(
      () => stranger.frames.filter((frame) => frame.type === 'error').length === 2,
      'the answer to be refused too'
    ),
    'and cannot answer either'
  );

  const caller = await tab(app, adminCookies);
  caller.send({ type: 'call:start' });
  t.match((await caller.waitFor('error')).error, /not found/, 'a call needs a group');

  const [, elsewhere] = await adminCall('POST', '/api/user_groups', {
    owner: 1, members: [1, member.id],
  });

  caller.send({ type: 'call:start', group: group.id });
  await caller.waitFor('call:state');

  caller.send({ type: 'call:start', group: elsewhere.user_group.id });
  t.match(
    (await caller.waitFor((frame) => frame.type === 'error' && /already in a call/.test(frame.error))).error,
    /already in a call/,
    'one tab, one conversation'
  );

  await Promise.all([stranger.close(), caller.close()]);
});
