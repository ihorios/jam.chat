import t from 'tap';

import { call, login, asUserWith, connect, eventually, listening, ADMIN } from '../helper.js';

/** Admin, a member of a shared group, and an outsider with a group of their own. */
async function messenger(t) {
  const app = await listening(t);
  const adminCookies = await login(app);
  const adminCall = (method, url, payload) => call(app, method, url, payload, adminCookies);

  const member = await asUserWith(
    t, app, adminCookies,
    ['user_groups:read:member', 'user_messages:read:member', 'user_messages:create:member'],
    '-ws'
  );
  const outsider = await asUserWith(
    t, app, adminCookies,
    ['user_groups:read:member', 'user_messages:read:member', 'user_messages:create:member'],
    '-wsout'
  );

  const [, users] = await adminCall('GET', '/api/users');
  member.id = users.users.find((u) => u.email === 'test-ws@example.com').id;
  outsider.id = users.users.find((u) => u.email === 'test-wsout@example.com').id;

  const [, shared] = await adminCall('POST', '/api/user_groups', {
    owner: 1, members: [1, member.id],
  });
  const [, elsewhere] = await adminCall('POST', '/api/user_groups', {
    owner: outsider.id, members: [outsider.id],
  });

  return {
    app,
    adminCookies,
    adminCall,
    member,
    outsider,
    shared: shared.user_group,
    elsewhere: elsewhere.user_group,
  };
}

t.test('a socket needs a session, and says hello with one', async (t) => {
  const app = await listening(t);

  const admin = await connect(app, await login(app));
  const greeting = await admin.waitFor('hello');
  t.equal(greeting.user.email, ADMIN.email, 'the session cookie is read at the handshake');
  t.ok(greeting.connectionId, 'and the connection is named');
  t.same(greeting.groups, {}, 'the admin is in no group yet');

  await admin.close();
});

/*
 * A socket without a session is refused rather than adopted.
 *
 * Anonymous connections used to be welcome, so that a browser on the login page
 * counted towards presence and could be promoted in place on sign-in. The
 * client reopens whenever the identity changes, so the promotion never
 * happened — and what remained was the only unauthenticated-reachable path in
 * the application with a database bill: every open publishes a presence event,
 * and every presence event reads every watching user.
 */
t.test('a socket with no session is closed, and leaves nothing behind', async (t) => {
  const app = await listening(t);

  const stranger = await connect(app);
  const code = await new Promise((resolve) => {
    if (stranger.socket.readyState === 3) return resolve(stranger.socket._closeCode ?? 1008);
    stranger.socket.on('close', resolve);
    setTimeout(() => resolve(null), 2000);
  });

  t.equal(code, 1008, 'closed with policy violation rather than left open');
  t.same(
    await app.realtime.connections(), [],
    'and never registered, so presence does not count somebody who never got in'
  );
});

t.test('presence counts sockets, not people', async (t) => {
  const app = await listening(t);
  const cookies = await login(app);

  const [status, empty] = await call(app, 'GET', '/api/presence', undefined, cookies);
  t.equal(status, 200);
  t.same(
    { total: empty.total, authenticated: empty.authenticated },
    { total: 0, authenticated: 0 },
    'nobody is connected until a socket opens'
  );

  const first = await connect(app, cookies);
  const second = await connect(app, cookies);
  await Promise.all([first.waitFor('hello'), second.waitFor('hello')]);

  const [, busy] = await call(app, 'GET', '/api/presence', undefined, cookies);
  t.equal(busy.total, 2, 'two sockets');
  t.equal(
    busy.authenticated, busy.total,
    'every one of them signed in — a socket cannot be opened otherwise'
  );
  t.equal(busy.anonymous, undefined, 'so there is no anonymous figure to report');
  t.equal(busy.users.length, 1, 'but only one person: tabs are not people');
  t.match(busy.users[0], { email: ADMIN.email, connections: 2 });
  t.ok(busy.users[0].since, 'and how long they have been here');

  await second.close();
  await eventually(async () => {
    const [, after] = await call(app, 'GET', '/api/presence', undefined, cookies);
    return after.total === 1 && after.users[0].connections === 1;
  }, 'the closed socket to be forgotten');

  await first.close();
});

t.test('presence is pushed as it changes, to the sockets allowed it', async (t) => {
  const app = await listening(t);
  const cookies = await login(app);

  const watcher = await connect(app, cookies);
  const first = await watcher.waitFor('presence', 'presence for its own socket');
  t.match(
    first,
    { total: 1, authenticated: 1, people: 1 },
    'the dashboard socket counts itself'
  );

  // A second tab of the same person: another connection, still one user.
  const secondTab = await connect(app, cookies);
  const busy = await watcher.waitFor(
    (frame) => frame.type === 'presence' && frame.total === 2,
    'the second tab'
  );
  t.equal(busy.people, 1, 'tabs are not people');
  t.equal(busy.authenticated, 2, 'and both are signed in, since nothing else may connect');

  await secondTab.close();
  await watcher.waitFor(
    (frame) => frame.type === 'presence' && frame.total === 1,
    'the closed socket to be forgotten'
  );

  await watcher.close();
});

t.test('presence is not public', async (t) => {
  const app = await listening(t);
  const [status] = await call(app, 'GET', '/api/presence');
  t.equal(status, 401, 'a session is required');

  const stranger = await asUserWith(t, app, await login(app), ['user_groups:read:member'], '-nosy');
  const [forbidden, body] = await stranger.call('GET', '/api/presence');
  t.equal(forbidden, 403, 'and so is permission to read users');
  t.match(body.error, /users:read/);
});

t.test('a message reaches the group over the socket, and nobody else', async (t) => {
  const { app, adminCall, member, outsider, shared, elsewhere } = await messenger(t);

  const memberSocket = await connect(app, member.cookies);
  const outsiderSocket = await connect(app, outsider.cookies);
  await Promise.all([memberSocket.waitFor('hello'), outsiderSocket.waitFor('hello')]);

  await adminCall('POST', '/api/user_messages', {
    owner: 1, group: shared.id, value: 'For the group',
  });

  const pushed = await memberSocket.waitFor('message', 'the pushed message');
  t.equal(pushed.message.value, 'For the group', 'delivered without being asked for');
  t.equal(pushed.message.group, shared.id);

  // The outsider must not get that one. Rather than waiting on nothing, send
  // them something they may see and check it arrives first.
  await adminCall('POST', '/api/user_messages', {
    owner: outsider.id, group: elsewhere.id, value: 'Only for the outsider',
  });
  const theirs = await outsiderSocket.waitFor('message', 'their own group message');
  t.equal(theirs.message.value, 'Only for the outsider', 'the first message they see is their own');
  t.notOk(
    outsiderSocket.frames.some((frame) => frame.message?.value === 'For the group'),
    'a conversation they are not in never reached them'
  );

  await memberSocket.close();
  await outsiderSocket.close();
});

/*
 * The socket carries the messenger, and the messenger is somebody's own
 * conversations — so delivery follows membership rather than the read
 * permission a route would use. It is the one place the two rules differ, and
 * this is what holds them apart: an administrator holds `user_messages:read`
 * unscoped, and used to be pushed every word said anywhere in the
 * installation. The dashboard, which is where that permission belongs,
 * subscribes to nothing.
 */
t.test('an administrator is not sent conversations they are not in', async (t) => {
  const { app, adminCall, outsider, elsewhere } = await messenger(t);

  const adminSocket = await connect(app, await login(app));
  const outsiderSocket = await connect(app, outsider.cookies);
  await Promise.all([adminSocket.waitFor('hello'), outsiderSocket.waitFor('hello')]);

  await adminCall('POST', '/api/user_messages', {
    owner: outsider.id, group: elsewhere.id, value: 'Between them and nobody else',
  });

  // The person actually in it is the control: once they have it, the frame has
  // been fanned out and the admin's silence means something.
  const theirs = await outsiderSocket.waitFor('message', 'the member gets it');
  t.equal(theirs.message.value, 'Between them and nobody else');

  t.notOk(
    adminSocket.frames.some((frame) => frame.message?.value === 'Between them and nobody else'),
    'reading every group is not being in one'
  );

  await adminSocket.close();
  await outsiderSocket.close();
});

t.test('an edit reaches the people who read the mistake', async (t) => {
  const { app, adminCall, member, shared } = await messenger(t);

  const socket = await connect(app, member.cookies);
  await socket.waitFor('hello');

  const [, posted] = await adminCall('POST', '/api/user_messages', {
    owner: 1, group: shared.id, value: 'Meeting at 3pm',
  });
  const original = await socket.waitFor('message', 'the message');
  t.equal(original.message.value, 'Meeting at 3pm');

  await socket.waitFor('unread', 'the unread count for it');

  await adminCall('PUT', `/api/user_messages/${posted.user_message.id}`, {
    value: 'Meeting at 4pm',
  });

  const corrected = await socket.waitFor(
    (frame) => frame.type === 'message' && frame.message.value === 'Meeting at 4pm',
    'the correction'
  );
  t.equal(corrected.message.id, posted.user_message.id, 'the same message, changed');

  // Reading it, then editing it again: a correction must not make a
  // conversation unread all over again.
  socket.send({ type: 'read', group: shared.id });
  await socket.waitFor((frame) => frame.type === 'unread' && frame.total === 0, 'the count clearing');

  await adminCall('PUT', `/api/user_messages/${posted.user_message.id}`, {
    value: 'Meeting at 5pm',
  });
  await socket.waitFor(
    (frame) => frame.type === 'message' && frame.message.value === 'Meeting at 5pm',
    'the second correction'
  );

  t.notOk(
    socket.frames.some((frame) => frame.type === 'unread' && frame.total > 0
      && socket.frames.indexOf(frame) > socket.frames.findIndex(
        (f) => f.type === 'unread' && f.total === 0
      )),
    'and nothing became unread again because of it'
  );

  await socket.close();
});

t.test('a deleted message is taken off everybody s screen', async (t) => {
  const { app, adminCall, member, outsider, shared } = await messenger(t);

  const reader = await connect(app, member.cookies);
  const stranger = await connect(app, outsider.cookies);
  await Promise.all([reader.waitFor('hello'), stranger.waitFor('hello')]);

  const [, posted] = await adminCall('POST', '/api/user_messages', {
    owner: 1, group: shared.id, value: 'Sent by mistake',
  });
  await reader.waitFor('message', 'the message');

  await adminCall('DELETE', `/api/user_messages/${posted.user_message.id}`);

  const removed = await reader.waitFor('message-deleted', 'the retraction');
  t.equal(removed.id, posted.user_message.id, 'named, so a client can drop it');
  t.equal(removed.group, shared.id, 'and placed, so it knows which conversation');

  // The membership check has to survive the row it was about: a message that
  // no longer exists cannot be looked up to ask who belonged to it.
  t.notOk(
    stranger.frames.some((frame) => frame.type === 'message-deleted'),
    'somebody who could not read it is not told it is gone'
  );

  await Promise.all([reader.close(), stranger.close()]);
});

t.test('unread rises, is cleared by reading, and survives signing in again', async (t) => {
  const { app, adminCall, member, shared } = await messenger(t);

  const socket = await connect(app, member.cookies);
  await socket.waitFor('hello');

  await adminCall('POST', '/api/user_messages', {
    owner: 1, group: shared.id, value: 'Did you see this?',
  });

  const unread = await socket.waitFor('unread', 'the unread count');
  t.equal(unread.total, 1, 'somebody else message is news');
  t.equal(unread.groups[shared.id], 1, 'and the group it is in is the one outlined');

  // Their own message is not news to them.
  await member.call('POST', '/api/user_messages', { group: shared.id, value: 'I did' });
  const [, viaHttp] = await member.call('GET', '/api/messenger/unread');
  t.equal(viaHttp.total, 1, 'still just the one');

  socket.send({ type: 'read', group: shared.id });
  const cleared = await socket.waitFor(
    (frame) => frame.type === 'unread' && frame.total === 0,
    'the count to clear'
  );
  t.equal(cleared.groups[shared.id], 0);

  // A new session, as if they closed the browser and came back.
  const returning = await connect(app, await login(app, {
    email: 'test-ws@example.com', password: 'Testpass1!',
  }));
  const hello = await returning.waitFor('hello');
  t.equal(hello.total, 0, 'reading is remembered by the server, not the tab');

  await adminCall('POST', '/api/user_messages', {
    owner: 1, group: shared.id, value: 'And this one is new',
  });
  const again = await returning.waitFor('unread');
  t.equal(again.total, 1, 'and anything said since counts again');

  await socket.close();
  await returning.close();
});

t.test('reading a group you are not in is refused', async (t) => {
  const { app, member, elsewhere } = await messenger(t);

  const [status, body] = await member.call('POST', '/api/messenger/read', { group: elsewhere.id });
  t.equal(status, 404, 'a group they cannot see cannot be marked read');
  t.match(body.error, /not found/);

  const [missing] = await member.call('POST', '/api/messenger/read', {});
  t.equal(missing, 400, 'and a group is required');

  const [anon] = await call(app, 'GET', '/api/messenger/unread');
  t.equal(anon, 401, 'unread is about somebody, so it needs a session');
});

t.test('a socket that says nonsense is told so, not dropped', async (t) => {
  const app = await listening(t);
  const socket = await connect(app, await login(app));
  await socket.waitFor('hello');

  socket.socket.send('not json at all');
  t.match((await socket.waitFor('error')).error, /JSON/);

  socket.send({ type: 'ping' });
  t.ok(await socket.waitFor('pong'), 'and the socket still works');

  socket.send({ type: 'interpretive dance' });
  t.match((await socket.waitFor((f) => f.type === 'error' && /Unknown/.test(f.error))).error, /Unknown/);

  await socket.close();
});

/*
 * A backing service failing must not take the server with it.
 *
 * A listener handed an async function is a promise nobody is holding: throw
 * inside one and it is an unhandled rejection, which Node answers by killing
 * the process. So a database that blinked while somebody's tab said `read`
 * brought down every other socket in the installation, for a frame that could
 * simply have been refused.
 *
 * Asserted by watching for the rejection rather than by watching the server
 * die, since a test that actually crashed the process could not report it.
 */
async function whileTheDatabaseIsGone(t, run) {
  const rejections = [];
  const watch = (err) => rejections.push(err);
  process.on('unhandledRejection', watch);
  t.teardown(() => process.off('unhandledRejection', watch));

  await run();
  // Long enough for a rejection to have surfaced if one was going to.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return rejections;
}

/** Makes one repository method fail the way a pool timeout does. */
function breaks(t, app, model, method) {
  const real = app.models[model][method].bind(app.models[model]);
  app.models[model][method] = async () => {
    throw new Error('Connection terminated due to connection timeout');
  };
  t.teardown(() => { app.models[model][method] = real; });
  return () => { app.models[model][method] = real; };
}

t.test('a frame that cannot be handled is refused, not fatal', async (t) => {
  const app = await listening(t);
  const socket = await connect(app, await login(app));
  await socket.waitFor('hello');

  /*
   * `user_groups.writeLink`, not `users.findById`: the socket remembers who it
   * belongs to for a few seconds (IDENTITY_TTL_MS), so breaking the identity
   * read proves nothing about a frame sent inside that window. What this needs
   * to break is something the frame itself reaches for — marking a group read.
   */
  const mend = breaks(t, app, 'user_groups', 'writeLink');

  const rejections = await whileTheDatabaseIsGone(t, async () => {
    socket.socket.send(JSON.stringify({ type: 'read', group: 1 }));
  });

  t.same(rejections, [], 'nothing is left unhandled, so the process lives');
  const refused = await socket.waitFor('error', 'a refusal');
  t.match(refused.error, /try again/i, 'and the tab is told, in words it can act on');
  t.equal(socket.socket.readyState, 1, 'with the socket still open for the next one');

  mend();
  await socket.close();
});

t.test('a handshake that fails leaves nothing behind', async (t) => {
  const app = await listening(t);
  t.equal((await app.realtime.connections()).length, 0, 'nothing connected yet');

  // The unread counts on the hello frame are a read, so a handshake can throw.
  const mend = breaks(t, app, 'user_groups', 'readLinks');

  let socket;
  const rejections = await whileTheDatabaseIsGone(t, async () => {
    socket = await connect(app, await login(app)).catch(() => null);
  });

  t.same(rejections, [], 'the failure is handled rather than fatal');
  mend();

  await eventually(
    async () => (await app.realtime.connections()).length === 0,
    'the connection is forgotten'
  );
  t.equal(
    (await app.realtime.connections()).length, 0,
    'presence does not go on counting somebody who never got in'
  );

  if (socket) await socket.close().catch(() => {});
});

/*
 * A socket remembers who it belongs to for a few seconds.
 *
 * Every frame used to re-read the account — three queries, since hydrating a
 * user pulls their roles for their permissions — which made establishing *who
 * was asking* the dominant cost of the socket: four repository calls to answer
 * an `unread`, three of them the question rather than the answer.
 *
 * What the re-read enforces is narrower than it looks. No frame handler
 * consults permissions; they consult membership, and each checks that for
 * itself and freshly. What is left is `is_active`, so what this trades is a few
 * seconds before a disabled account stops being able to send frames on a socket
 * it already had open.
 */
t.test('a socket does not re-read its account on every frame', async (t) => {
  const app = await listening(t);
  const socket = await connect(app, await login(app));
  await socket.waitFor('hello');

  let reads = 0;
  const real = app.models.users.findById.bind(app.models.users);
  app.models.users.findById = (...args) => { reads += 1; return real(...args); };
  t.teardown(() => { app.models.users.findById = real; });

  for (let i = 0; i < 20; i += 1) socket.socket.send(JSON.stringify({ type: 'unread' }));
  await eventually(
    () => socket.frames.filter((frame) => frame.type === 'unread').length >= 20,
    'all twenty frames to be answered'
  );

  t.equal(
    socket.frames.filter((frame) => frame.type === 'unread').length >= 20, true,
    'every frame is answered'
  );
  t.ok(reads <= 1, `and the account is read at most once for all of them (was ${reads})`);

  await socket.close();
});
