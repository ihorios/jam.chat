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

t.test('a socket says hello, signed in or not', async (t) => {
  const app = await listening(t);

  const anonymous = await connect(app);
  const hello = await anonymous.waitFor('hello');
  t.equal(hello.user, null, 'an anonymous socket is welcome');
  t.ok(hello.connectionId, 'and is still identified as a connection');
  t.equal(hello.total, 0, 'with nothing unread, having nowhere to read');

  const admin = await connect(app, await login(app));
  const greeting = await admin.waitFor('hello');
  t.equal(greeting.user.email, ADMIN.email, 'the session cookie is read at the handshake');
  t.same(greeting.groups, {}, 'the admin is in no group yet');

  await anonymous.close();
  await admin.close();
});

t.test('presence counts sockets, and separates signed in from not', async (t) => {
  const app = await listening(t);
  const cookies = await login(app);

  const [status, empty] = await call(app, 'GET', '/api/presence', undefined, cookies);
  t.equal(status, 200);
  t.same(
    { total: empty.total, authenticated: empty.authenticated, anonymous: empty.anonymous },
    { total: 0, authenticated: 0, anonymous: 0 },
    'nobody is connected until a socket opens'
  );

  const anonymous = await connect(app);
  const first = await connect(app, cookies);
  const second = await connect(app, cookies);
  await Promise.all([anonymous.waitFor('hello'), first.waitFor('hello'), second.waitFor('hello')]);

  const [, busy] = await call(app, 'GET', '/api/presence', undefined, cookies);
  t.equal(busy.total, 3, 'three sockets');
  t.equal(busy.authenticated, 2, 'two of them signed in');
  t.equal(busy.anonymous, 1);
  t.equal(busy.users.length, 1, 'but only one person: tabs are not people');
  t.match(busy.users[0], { email: ADMIN.email, connections: 2 });
  t.ok(busy.users[0].since, 'and how long they have been here');

  await second.close();
  await eventually(async () => {
    const [, after] = await call(app, 'GET', '/api/presence', undefined, cookies);
    return after.total === 2 && after.users[0].connections === 1;
  }, 'the closed socket to be forgotten');

  await anonymous.close();
  await first.close();
});

t.test('presence is pushed as it changes, to the sockets allowed it', async (t) => {
  const app = await listening(t);
  const cookies = await login(app);

  const watcher = await connect(app, cookies);
  const first = await watcher.waitFor('presence', 'presence for its own socket');
  t.match(
    first,
    { total: 1, authenticated: 1, anonymous: 0, people: 1 },
    'the dashboard socket counts itself'
  );

  const anonymous = await connect(app);
  const joined = await watcher.waitFor(
    (frame) => frame.type === 'presence' && frame.total === 2,
    'the guest to be counted'
  );
  t.match(joined, { authenticated: 1, anonymous: 1, people: 1 }, 'a guest is counted apart');

  // A second tab of the same person: another connection, still one user.
  const secondTab = await connect(app, cookies);
  const busy = await watcher.waitFor(
    (frame) => frame.type === 'presence' && frame.total === 3,
    'the second tab'
  );
  t.equal(busy.people, 1, 'tabs are not people');
  t.equal(busy.authenticated, 2);

  await secondTab.close();
  await anonymous.close();
  await watcher.waitFor(
    (frame) => frame.type === 'presence' && frame.total === 1,
    'the closed sockets to be forgotten'
  );

  t.notOk(
    anonymous.frames.some((frame) => frame.type === 'presence'),
    'a socket without users:read is never told who is online'
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
