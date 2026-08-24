import fs from 'node:fs';
import path from 'node:path';

import t from 'tap';

/**
 * Every icon the app can draw has to be in the font it ships.
 *
 * The font in public/fonts is subset to a list of names (docs/icons/export-subset.js).
 * An icon missing from that list does not fail loudly: it renders as its own
 * name, in text, where a picture belongs — which is what happened before the
 * font was self-hosted at all. This is the check that keeps that from coming
 * back the next time somebody adds an icon.
 */

const ROOT = path.join(import.meta.dirname, '..', '..');

/** The names the shipped subset was built from. */
function subsetNames() {
  const source = fs.readFileSync(path.join(ROOT, 'docs/icons/export-subset.js'), 'utf8');
  const list = source.match(/const NAMES = \[([\s\S]*?)\]/);
  t.ok(list, 'export-subset.js declares NAMES');
  return new Set([...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
}

/** Every source file that renders an icon. */
function sourceFiles(dir = path.join(ROOT, 'src')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.jsx') ? [full] : [];
  });
}

/**
 * The names one file asks for: the literal `name="…"` props, the ones inside a
 * `name={…}` expression, and the two lookup tables that map a file type and a
 * dashboard tab to an icon.
 */
function namesIn(source) {
  const names = [
    ...[...source.matchAll(/name="([a-z_]+)"/g)].map((m) => m[1]),
    ...[...source.matchAll(/name=\{([^}]*)\}/g)]
      .flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((q) => q[1])),
  ];

  // The lookup tables — a file extension and a dashboard tab each map to an
  // icon — are read by slicing the object out of the source rather than with a
  // regex built at runtime, which is a great deal easier to be sure of.
  for (const table of ['ICONS', 'TAB_ICONS']) {
    const opening = source.indexOf(`const ${table} = {`);
    if (opening === -1) continue;
    const body = source.slice(opening, source.indexOf('};', opening));
    // Values only: a key is a file extension or a model name ('7z', 'users'),
    // and neither is an icon.
    names.push(...[...body.matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1]));
  }

  return names;
}

t.test('every icon the app renders is in the shipped subset', async (t) => {
  const shipped = subsetNames();
  t.ok(shipped.size >= 30, `the subset covers ${shipped.size} icons`);

  const missing = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes("from '../components/Icon'") && !source.includes("from './Icon'")) continue;

    for (const name of namesIn(source)) {
      // A name that is not an icon at all — a model name in a lookup, say —
      // would be a false alarm, so only names asked of <Icon> are collected
      // above. Anything left that the font does not hold is a real problem.
      if (!shipped.has(name)) missing.push(`${path.relative(ROOT, file)}: ${name}`);
    }
  }

  t.same(missing, [], 'no icon renders as its own name');
});

t.test('the subset font is actually there', async (t) => {
  const font = path.join(ROOT, 'public/fonts/material-symbols-rounded-subset.woff2');
  t.ok(fs.existsSync(font), 'public/fonts holds the woff2');
  t.ok(fs.statSync(font).size > 5000, 'and it is a font rather than an error page');

  const css = fs.readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');
  t.match(css, /@font-face[\s\S]*material-symbols-rounded-subset\.woff2/, 'declared in the CSS');
  t.match(css, /font-display: block/, 'and never shows the name while it loads');
});
