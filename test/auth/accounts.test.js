import t from 'tap';

import { buildTestApp } from '../helper.js';
import { googleAccount, defaultRoleIds } from '../../server/auth/accounts.js';

/**
 * What an account is when it creates itself.
 *
 * The route around this is a token verifier and a session cookie, both covered
 * elsewhere; these are the rules the sign-in applies once it knows who somebody
 * is — which role they get, whether their address counts as proven, and what
 * happens to a picture they may already have chosen.
 */

const IDENTITY = {
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  picture: 'https://lh3.googleusercontent.com/a/ada',
};

t.test('a first Google sign-in creates a confirmed account with the user role', async (t) => {
  const app = await buildTestApp(t);

  const { user, created } = await googleAccount(app.models, IDENTITY, { language: 'uk' });

  t.equal(created, true);
  t.equal(user.email, 'ada@example.com');
  t.equal(user.first_name, 'Ada');
  t.equal(user.last_name, 'Lovelace');
  t.equal(user.language, 'uk');
  t.equal(user.is_active, true);
  t.equal(user.email_confirmed, true, 'Google only hands over an address it verified');
  t.equal(user.logo, IDENTITY.picture, 'the account picture becomes the logo');
  t.same(user.roles.map((role) => role.name), ['user'], 'the ordinary account role');
  t.ok(user.permissions.includes('user_messages:create:member'), 'the messenger is usable');
  t.notOk(user.permissions.includes('users:delete'), 'and nothing administrative');
});

t.test('a provider that sends no picture leaves the logo empty', async (t) => {
  const app = await buildTestApp(t);

  const { user } = await googleAccount(app.models, { ...IDENTITY, picture: null }, {});

  t.equal(user.logo, null);
  t.equal(user.email_confirmed, true, 'which has nothing to do with the picture');
});

t.test('an unusable picture is dropped rather than failing the sign-in', async (t) => {
  const app = await buildTestApp(t);
  const warnings = [];
  const log = { warn: (message) => warnings.push(message) };

  const { user } = await googleAccount(
    app.models,
    { ...IDENTITY, picture: 'javascript:alert(1)' },
    { log }
  );

  t.equal(user.logo, null, 'nothing that is not an http(s) URL is stored');
  t.equal(warnings.length, 1, 'and it is said out loud');
});

t.test('a second sign-in reuses the account and does not duplicate it', async (t) => {
  const app = await buildTestApp(t);

  const first = await googleAccount(app.models, IDENTITY, {});
  const second = await googleAccount(app.models, IDENTITY, {});

  t.equal(second.created, false);
  t.equal(second.user.id, first.user.id);
  t.equal(
    (await app.models.users.findAll()).filter((user) => user.email === IDENTITY.email).length,
    1
  );
});

t.test('signing in with Google confirms an address that was only typed before', async (t) => {
  const app = await buildTestApp(t);

  // The account somebody registered with a password: unconfirmed, no picture.
  const registered = await app.models.users.create({
    email: IDENTITY.email,
    first_name: 'Ada',
    password: 'Testpass1!',
    is_active: true,
    email_confirmed: false,
    roles: [],
  });

  const { user, created } = await googleAccount(app.models, IDENTITY, {});

  t.equal(created, false, 'it is the same account, matched on the address');
  t.equal(user.id, registered.id);
  t.equal(user.email_confirmed, true, 'now proven');
  t.equal(user.logo, IDENTITY.picture, 'and a picture where there was none');
});

t.test('a logo somebody chose survives a Google sign-in', async (t) => {
  const app = await buildTestApp(t);

  const chosen = 'https://example.com/mine.png';
  await app.models.users.create({
    email: IDENTITY.email,
    first_name: 'Ada',
    password: 'Testpass1!',
    is_active: true,
    email_confirmed: true,
    logo: chosen,
    roles: [],
  });

  const { user } = await googleAccount(app.models, IDENTITY, {});

  t.equal(user.logo, chosen, 'signing in again is not a reason to overwrite it');
});

t.test('a missing user role leaves the account with none rather than failing', async (t) => {
  const app = await buildTestApp(t);
  const warnings = [];

  const role = (await app.models.roles.findAll()).find((r) => r.name === 'user');
  await app.models.roles.remove(role.id);

  t.same(await defaultRoleIds(app.models, { warn: (m) => warnings.push(m) }), []);
  t.equal(warnings.length, 1, 'said out loud, since it leaves new accounts unable to do anything');

  const { user } = await googleAccount(app.models, IDENTITY, {});
  t.same(user.roles, [], 'the account still exists and can be given a role by hand');
});
