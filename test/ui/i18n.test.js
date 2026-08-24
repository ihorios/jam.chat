import fs from 'node:fs';
import path from 'node:path';

import t from 'tap';

/**
 * The interface is offered in more than one language, which only works if every
 * word in it is a key rather than a string in a component.
 *
 * Three things go wrong on their own, and each has a check here:
 *
 *  - A key added to en.json and forgotten in uk.json. i18next falls back to
 *    English silently, so the only symptom is one English line in the middle of
 *    a Ukrainian page.
 *  - A key used in a component and defined in neither. That one renders the key
 *    itself — `panels.users.tota` — to whoever is reading.
 *  - A string written straight into JSX. It cannot be translated at all, and
 *    nothing complains: it just stays English forever.
 *
 * Written in the same shape as icons.test.js, which guards the icon font the
 * same way and for the same reason.
 */

const ROOT = path.join(import.meta.dirname, '..', '..');
const LOCALES = path.join(ROOT, 'src', 'i18n');

const load = (name) =>
  JSON.parse(fs.readFileSync(path.join(LOCALES, `${name}.json`), 'utf8'));

/** Every leaf, as a dotted path. */
function flatten(node, prefix = '') {
  return Object.entries(node).flatMap(([key, value]) => (
    value !== null && typeof value === 'object'
      ? flatten(value, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  ));
}

/**
 * A key with its plural suffix removed.
 *
 * English needs two forms and Ukrainian three, so `memberCount_other` and
 * `memberCount_many` are the same key expressed for different languages. The
 * comparison is between what each file *names*, not how many forms it needs.
 */
const PLURALS = ['_zero', '_one', '_two', '_few', '_many', '_other'];
const stem = (key) => {
  const suffix = PLURALS.find((candidate) => key.endsWith(candidate));
  return suffix ? key.slice(0, -suffix.length) : key;
};

/** Every .js/.jsx file under src/. */
function sourceFiles(dir = path.join(ROOT, 'src')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.jsx?$/.test(entry.name) ? [full] : [];
  });
}

const relative = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

/** Source with block and line comments removed, so prose in them is not read. */
function code(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

t.test('every key in en.json exists in uk.json, and the reverse', async (t) => {
  const en = new Set(flatten(load('en')).map(stem));
  const uk = new Set(flatten(load('uk')).map(stem));

  t.same([...en].filter((key) => !uk.has(key)), [], 'nothing is missing from uk.json');
  t.same([...uk].filter((key) => !en.has(key)), [], 'and nothing is stranded in it');
  t.ok(en.size > 250, `${en.size} keys, which is the whole interface`);
});

t.test('every key a component asks for is defined', async (t) => {
  const defined = new Set(flatten(load('en')).map(stem));
  const missing = [];

  for (const file of sourceFiles()) {
    // t('a.b.c') and i18n.t('a.b.c'). A key built from a template literal is
    // skipped: `models.${name}.label` cannot be checked without knowing the
    // name, and every one of those passes a defaultValue for exactly that
    // reason (see lib/labels.js).
    for (const [, key] of code(file).matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
      if (!defined.has(stem(key))) missing.push(`${relative(file)}: ${key}`);
    }
  }

  t.same(missing, [], 'no component asks for a key that does not exist');
});

/**
 * Words that look like prose but are not translatable text.
 *
 * The product's own name is the only one: it reads the same in every language,
 * and translating a brand is how you end up with two of them.
 */
const NOT_TRANSLATABLE = new Set(['JAM.chat']);

t.test('no user-facing string is written into a component', async (t) => {
  // Text between tags that starts like a sentence, and the attributes a person
  // actually reads. className, href and the rest are deliberately not here.
  const TEXT = />\s*([A-Z][^<>{}\n][^<>{}]*?)\s*</g;
  // Every attribute whose value a person reads. `hint` was missing from this
  // list once, and a sentence sat untranslated in UsersPanel for exactly as
  // long — so the rule is to add the attribute here first, not after.
  const ATTR = new RegExp(
    '\\b(title|placeholder|aria-label|alt|label|hint|caption|description'
    + '|tooltip|subtitle|summary|searchPlaceholder)="([^"]+)"',
    'g'
  );

  const found = [];
  for (const file of sourceFiles()) {
    const source = code(file);
    for (const [, text] of source.matchAll(TEXT)) {
      if (!NOT_TRANSLATABLE.has(text) && !/^(&\w+;|\d+)$/.test(text)) {
        found.push(`${relative(file)}: ${text}`);
      }
    }
    for (const [, , value] of source.matchAll(ATTR)) {
      if (!NOT_TRANSLATABLE.has(value)) found.push(`${relative(file)}: ${value}`);
    }
  }

  t.same(found, [], 'every readable string comes from a key');
});

t.test('no native dialog is used, since its buttons cannot be translated', async (t) => {
  // window.confirm and window.alert are drawn by the browser, in the browser's
  // language, and cannot be reached from here. See components/ConfirmDialog.jsx.
  const found = sourceFiles()
    .filter((file) => /\bwindow\.(confirm|alert)\s*\(/.test(code(file)))
    .map(relative);

  t.same(found, [], 'confirmations are rendered by the app');
});
