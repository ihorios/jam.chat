import fs from 'node:fs';
import path from 'node:path';

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

/**
 * Buttons that could never be pressed.
 *
 * `can()` answers whether a permission is held at *any* scope, so it is true of
 * the `user_messages:update:own` and `:delete:own` every ordinary account
 * carries — which makes it the wrong thing to draw a per-message button from on
 * its own. Delete was drawn from it alone and so appeared on everybody's
 * messages, where the server answered 404 because the row was not theirs.
 *
 * The server is not what this guards; it was always right, and
 * routes/membership.test.js says so. What it guards is the offer: a control
 * that cannot do what it says is worse than no control, and the mistake is one
 * character wide and invisible in review.
 *
 * Read out of the source because the suite has no way to render a component —
 * crude, and still the difference between catching this and not.
 */
t.test('the messenger offers edit and delete on your own messages only', async (t) => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', 'src', 'pages', 'MessengerPage.jsx'),
    'utf8'
  );

  // Comments and whitespace collapsed away, so the guard reads as one line
  // whatever it happens to be wrapped to.
  const flat = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

  for (const [action, handler] of [['edit', 'startEdit'], ['delete', 'askToDeleteMessage']]) {
    const at = flat.indexOf(handler + '(message)');
    t.ok(at > 0, 'the messenger has a ' + action + ' control');

    // What stands in front of it: far enough back to reach past the button
    // element to the condition deciding whether it is drawn at all.
    const guard = flat.slice(Math.max(0, at - 120), at);
    t.match(
      guard,
      /mine &&/,
      'and ' + action + ' is offered on your own messages only, '
      + 'rather than wherever the permission happens to be held'
    );
  }
});
