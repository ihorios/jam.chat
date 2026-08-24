import t from 'tap';

import { buildTestApp, call } from '../helper.js';

t.test('liveness and health probes', async (t) => {
  const app = await buildTestApp(t);

  for (const url of ['/liveness', '/healthz']) {
    const [status, body] = await call(app, 'GET', url);
    t.equal(status, 200, `${url} responds`);
    t.same(body, { ok: 1 });
  }
});
