import { createHmac } from 'node:crypto';

import t from 'tap';

// Set before helper.js loads the server: config/env.js freezes itself at
// import time, so a TURN server can only be configured from out here. The
// helper is imported dynamically for the same reason a static import would
// defeat — it would be hoisted above these lines.
process.env.TURN_URLS = 'turn:turn.example.com:3478,turns:turn.example.com:5349';
process.env.TURN_SECRET = 'a-shared-secret';
process.env.TURN_TTL_SECONDS = '600';

const { asAdmin, call } = await import('../helper.js');

t.test('ice servers are minted for the session that asks', async (t) => {
  const admin = await asAdmin(t);

  const [status, body] = await admin.call('GET', '/api/calls/ice');
  t.equal(status, 200);
  t.equal(body.ttl, 600);

  const [stun, turn] = body.iceServers;
  t.same(stun.urls, ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']);
  t.notOk(stun.credential, 'STUN needs no credentials, and is given none');

  t.same(turn.urls, ['turn:turn.example.com:3478', 'turns:turn.example.com:5349']);

  const [expiry, userId] = turn.username.split(':');
  t.equal(Number(userId), 1, 'the credential names who it was minted for');
  t.ok(
    Number(expiry) > Math.floor(Date.now() / 1000),
    'and stops working, which is the whole point of minting it'
  );
  t.ok(Number(expiry) <= Math.floor(Date.now() / 1000) + 600, 'within the configured life');

  t.equal(
    turn.credential,
    createHmac('sha1', 'a-shared-secret').update(turn.username).digest('base64'),
    'the password is the username signed with the secret, as coturn expects'
  );

  t.notMatch(JSON.stringify(body), /a-shared-secret/, 'and the secret itself never leaves');
});

t.test('relay credentials are not public, and not cached', async (t) => {
  const admin = await asAdmin(t);

  const [status, body] = await call(admin.app, 'GET', '/api/calls/ice');
  t.equal(status, 401, 'they cost bandwidth, so they need a session');
  t.match(body.error, /Authentication required/);

  const res = await admin.inject({ method: 'GET', url: '/api/calls/ice' });
  t.equal(
    res.headers['cache-control'],
    'no-store',
    'nothing between here and the browser may keep a copy'
  );
});
