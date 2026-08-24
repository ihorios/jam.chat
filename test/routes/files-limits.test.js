import t from 'tap';

// Set before helper.js loads the server: config/env.js freezes itself at
// import time, so limits can only be changed from out here. The helper is
// imported dynamically because a static import would be hoisted above these
// lines — the same trick as test/routes/ice.test.js.
process.env.FILE_MAX_BYTES = '64';
process.env.FILE_MAX_PER_MESSAGE = '2';
process.env.FILE_ALLOWED_EXTENSIONS = 'txt,png';
process.env.FILE_SWEEP_GRACE_SECONDS = '0';

const { asAdmin, upload } = await import('../helper.js');

const post = (app, cookies, files) => app.inject({
  method: 'POST', url: '/api/files', cookies, ...upload(files),
});

t.test('a file may not be bigger than the ceiling', async (t) => {
  const { app, cookies } = await asAdmin(t);

  const ok = await post(app, cookies, [{ name: 'small.txt', body: 'x'.repeat(64) }]);
  t.equal(ok.statusCode, 201, 'exactly the limit is within it');

  const tooBig = await post(app, cookies, [{ name: 'big.txt', body: 'x'.repeat(65) }]);
  t.equal(tooBig.statusCode, 413, 'one byte more is not');
  t.match(tooBig.json().error, /under/);

  const [, listed] = await app.inject({ method: 'GET', url: '/api/files', cookies })
    .then((res) => [res.statusCode, res.json()]);
  t.equal(listed.count, 1, 'and the refused one left no row behind');
});

t.test('a message may not carry more files than allowed', async (t) => {
  const { app, cookies } = await asAdmin(t);

  const two = await post(app, cookies, [
    { name: 'a.txt', body: 'one' },
    { name: 'b.txt', body: 'two' },
  ]);
  t.equal(two.statusCode, 201);
  t.equal(two.json().count, 2);

  const three = await post(app, cookies, [
    { name: 'a.txt', body: 'one' },
    { name: 'b.txt', body: 'two' },
    { name: 'c.txt', body: 'three' },
  ]);
  t.equal(three.statusCode, 400);
  t.match(three.json().error, /At most 2 files/);
});

t.test('only the extensions on the list are accepted', async (t) => {
  const { app, cookies } = await asAdmin(t);

  t.equal((await post(app, cookies, [{ name: 'fine.png', body: 'ok' }])).statusCode, 201);

  const refused = await post(app, cookies, [{ name: 'script.exe', body: 'no' }]);
  t.equal(refused.statusCode, 415);
  t.match(refused.json().error, /\.exe/);
});

t.test('a file attached to nothing is swept up', async (t) => {
  const { app, cookies, call } = await asAdmin(t);

  const [, group] = await call('POST', '/api/user_groups', { owner: 1, members: [1] });

  const kept = (await post(app, cookies, [{ name: 'kept.txt', body: 'attached' }])).json().files[0];
  const loose = (await post(app, cookies, [{ name: 'loose.txt', body: 'orphan' }])).json().files[0];

  await call('POST', '/api/user_messages', {
    owner: 1, group: group.user_group.id, value: 'With attachment', files: [kept.id],
  });

  const collected = await app.sweepFiles();
  t.equal(collected, 1, 'the one nothing points at');

  const [, remaining] = await call('GET', '/api/files');
  t.same(remaining.files.map((file) => file.id), [kept.id], 'the attached one is untouched');

  const gone = await app.inject({
    method: 'GET', url: `/api/files/${loose.id}/content`, cookies,
  });
  t.equal(gone.statusCode, 404, 'and its bytes went with it');
});

t.test('deleting a message takes its attachments with it', async (t) => {
  const { app, cookies, call } = await asAdmin(t);

  const [, group] = await call('POST', '/api/user_groups', { owner: 1, members: [1] });
  const file = (await post(app, cookies, [{ name: 'doomed.txt', body: 'bye' }])).json().files[0];

  const [, message] = await call('POST', '/api/user_messages', {
    owner: 1, group: group.user_group.id, value: 'Deleting this', files: [file.id],
  });

  const [status] = await call('DELETE', `/api/user_messages/${message.user_message.id}`);
  t.equal(status, 200);

  const [, after] = await call('GET', '/api/files');
  t.equal(after.count, 0, 'the row goes with the message, not an hour later');

  const gone = await app.inject({
    method: 'GET', url: `/api/files/${file.id}/content`, cookies,
  });
  t.equal(gone.statusCode, 404, 'and so do the bytes');
});

t.test('an attachment two messages share outlives the first of them', async (t) => {
  const { app, cookies, call } = await asAdmin(t);

  const [, group] = await call('POST', '/api/user_groups', { owner: 1, members: [1] });
  const file = (await post(app, cookies, [{ name: 'shared.txt', body: 'held twice' }]))
    .json().files[0];

  const posted = [];
  for (const value of ['First', 'Second']) {
    const [, body] = await call('POST', '/api/user_messages', {
      owner: 1, group: group.user_group.id, value, files: [file.id],
    });
    posted.push(body.user_message);
  }

  await call('DELETE', `/api/user_messages/${posted[0].id}`);

  const alive = await app.inject({
    method: 'GET', url: `/api/files/${file.id}/content`, cookies,
  });
  t.equal(alive.statusCode, 200, 'the other message still points at it');
  t.equal(alive.body, 'held twice');

  await call('DELETE', `/api/user_messages/${posted[1].id}`);

  const [, after] = await call('GET', '/api/files');
  t.equal(after.count, 0, 'and it goes with the last message holding it');
});
