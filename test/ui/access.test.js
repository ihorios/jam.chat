import fs from 'node:fs';
import path from 'node:path';

import t from 'tap';

import { buildTestApp } from '../helper.js';
import { hasAdministrativePermission, scopeReaches } from '../../src/lib/permissions.js';

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
 * A control is drawn from two things: the scope somebody holds over an action,
 * and whether that scope reaches the row in front of them. Drawn from the first
 * alone it lies — `can()` is true for the `:own` form every ordinary account
 * carries, so a Delete drawn from it appeared on everybody's messages while the
 * server answered 404 on anybody else's.
 *
 * The rule is a plain function so it can be checked directly; the second test
 * is the crude half, reading the source to confirm the messenger actually uses
 * it, since the suite cannot render a component.
 */
t.test('a scope reaches only what it is granted over', async (t) => {
  const message = { own: true, member: true };
  const somebody_elses = { own: false, member: true };
  const another_group = { own: false, member: false };

  t.ok(scopeReaches('any', another_group), 'unscoped reaches anything, anywhere');
  t.ok(scopeReaches('any', somebody_elses), 'including somebody else’s words');

  t.ok(scopeReaches('member', somebody_elses), 'member reaches a group you are in');
  t.notOk(scopeReaches('member', another_group), 'and nothing outside it');

  t.ok(scopeReaches('own', message), 'own reaches your own words');
  t.notOk(scopeReaches('own', somebody_elses), 'and not the person’s beside them');

  t.notOk(scopeReaches(null, message), 'holding nothing reaches nothing');
  t.notOk(scopeReaches(undefined, message), 'nor does holding an unknown scope');
  // `any` means every row, so it has no question to ask about this one.
  t.ok(scopeReaches('any'), 'unscoped needs to know nothing about a row to reach it');
  t.notOk(scopeReaches('own'), 'while a scoped one, told nothing, reaches nothing');
});

t.test('the messenger draws its message controls from a scope', async (t) => {
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
      /scopeReaches\(/,
      'and ' + action + ' is offered where the granted scope reaches this message, '
      + 'rather than wherever the permission happens to be held at all'
    );
  }
});

/*
 * Which attachments the messenger tries to draw.
 *
 * The set is derived from the icon map rather than written twice, so adding an
 * extension to ICONS is the whole of making it previewable. This checks the
 * derivation holds — a second, drifting list is exactly the kind of thing that
 * shows a paperclip beside a photograph forever.
 */
t.test('image attachments are recognised from the icon map', async (t) => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', 'src', 'components', 'Attachments.jsx'),
    'utf8'
  );

  t.match(
    source,
    /const IMAGES = new Set\(\s*Object\.entries\(ICONS\)/,
    'the previewable set is read off the icon map, not maintained beside it'
  );

  // Every extension the map calls an image should be one somebody would expect
  // to see drawn.
  for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']) {
    t.match(
      source,
      new RegExp(`${extension}: 'image'`),
      `${extension} is an image, so it draws itself`
    );
  }

  // And the fallback is what makes trusting a filename safe.
  t.match(source, /onError=\{\(\) => setDrawable\(false\)\}/,
    'a file that will not decode falls back to its glyph');
});
