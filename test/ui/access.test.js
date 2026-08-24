import t from 'tap';

import { buildTestApp } from '../helper.js';
import { hasAdministrativePermission } from '../../src/lib/permissions.js';

/**
 * Which accounts the dashboard is for.
 *
 * The client decides this from the permissions it holds — the header shows the
 * links it may use and the routes turn away the rest (src/App.jsx,
 * components/RequireAuth.jsx). The rule and the roles it is applied to live on
 * opposite sides of the app, so this checks them against each other: a change
 * to what the `user` role carries should fail here rather than quietly hand an
 * ordinary account the dashboard.
 */

t.test('the seeded roles land where they are meant to', async (t) => {
  const app = await buildTestApp(t);
  const roles = new Map((await app.models.roles.findAll()).map((r) => [r.name, r.permissions]));

  t.equal(
    hasAdministrativePermission(roles.get('user')),
    false,
    'an ordinary account has nothing to administer, so "/" is the messenger'
  );
  t.equal(
    hasAdministrativePermission(roles.get('moderator')),
    true,
    'a moderator may edit other people, so "/" is the dashboard'
  );
  t.equal(
    hasAdministrativePermission(roles.get('admin')),
    true,
    'and an administrator, likewise'
  );
});

t.test('what counts as administrative', async (t) => {
  t.equal(hasAdministrativePermission([]), false, 'no permissions at all');
  t.equal(hasAdministrativePermission(undefined), false, 'no session');
  t.equal(hasAdministrativePermission(null), false, 'no permissions field');

  t.equal(
    hasAdministrativePermission(['users:read']),
    false,
    'reading the directory is what the messenger needs to name people'
  );
  t.equal(
    hasAdministrativePermission([
      'users:read', 'users:update:own', 'user_messages:create:member', 'files:read:own',
    ]),
    false,
    'a scoped permission only reaches the holder’s own corner'
  );

  t.equal(
    hasAdministrativePermission(['users:read', 'users:update']),
    true,
    'an unscoped write reaches rows somebody else owns'
  );
  t.equal(
    hasAdministrativePermission(['users:read', 'roles:read']),
    true,
    'so does reading the roles: there is a screen for it'
  );
  t.equal(
    hasAdministrativePermission(['files:read']),
    true,
    'a read-only auditor of somebody else’s files belongs there too'
  );
});
