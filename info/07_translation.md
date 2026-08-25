# Translation

Two languages, English and Ukrainian, chosen from the browser and then from the
account. Every string in the interface is a key, and three tests fail the build
if one is not.

---

## 1. The languages

```js
export const LANGUAGES = [
  { code: 'en', nativeName: 'English' },
  { code: 'uk', nativeName: 'Українська' },
];
```

ISO 639-1 codes, matching `users.language` on the server. **`uk` is Ukrainian.**
`ua` is the *country* code for Ukraine and is what browsers put in the region
half of `uk-UA`, so using it as the language would fight every detector.

`nativeName` is deliberately in the language itself. Somebody who has landed on a
page they cannot read needs to recognise their own language in the switcher, not
read its English name.

---

## 2. i18next setup

`src/i18n/index.js`, imported by `main.jsx` **for its side effect** — i18next has
to be initialised before any component calls `useTranslation()`.

```js
i18n.use(LanguageDetector).use(initReactI18next).init({
  resources: { en: { translation: en }, uk: { translation: uk } },
  fallbackLng: 'en',
  supportedLngs: ['en', 'uk'],
  load: 'languageOnly',
  interpolation: { escapeValue: false },
  detection: {
    order: ['localStorage', 'navigator'],
    lookupLocalStorage: 'jamchat.language',
    caches: ['localStorage'],
  },
});
```

Three options carry weight:

**`load: 'languageOnly'`** — without it, `uk-UA` is looked up as its own language
and misses every key in `uk.json`.

**`escapeValue: false`** — React escapes for us. Leaving i18next's escaping on
would double-escape.

**`detection.order`** — `localStorage` before `navigator`, so a returning visitor
gets what they chose last time rather than what their browser prefers.

Both bundles are imported statically, not lazy-loaded. Two languages of ~340
keys are small enough that a second round trip would cost more than it saves.

---

## 3. Where the language comes from

Four sources, in increasing priority:

| Source | When |
| :--- | :--- |
| `fallbackLng: 'en'` | nothing else says anything |
| the browser (`navigator`) | first visit |
| `localStorage['jamchat.language']` | a returning visitor, signed out |
| **`users.language`** | signed in |

The account wins, and `AuthContext` applies it as soon as the session is known:

```js
function applyUserLanguage(user) {
  if (user?.language && user.language !== i18n.resolvedLanguage) {
    i18n.changeLanguage(user.language);
  }
}
```

Called after `/api/auth/me`, after a login, after a Google sign-in, and after a
profile update. It is the choice they made, on whichever device they made it.

### Changing it

```js
const setLanguage = useCallback(async (language) => {
  await i18n.changeLanguage(language);
  if (!user) return;
  try { await updateProfile({ language }); } catch { /* … */ }
}, [user, updateProfile]);
```

The interface changes **first**, and persisting is best-effort. A failure means
it will not follow them to another device — not a reason to snap the interface
back to a language they just left. Signed out it is still applied and cached, so
choosing a language before registering is what the new account is created with.

### The server side

`normaliseLanguage` exists **twice**, once on each side, with the same rule:

```js
const base = String(value || '').trim().toLowerCase().split('-')[0];
return LANGUAGES.includes(base) ? base : DEFAULT_LANGUAGE;
```

Region subtags are dropped, so `uk-UA` and `en-GB` both land somewhere useful
instead of nowhere. It **falls back rather than refusing**: a language tag
arrives from a browser or a sign-up form, and neither is worth failing a
registration over.

The registration route normalises what the client sends rather than trusting it:

```js
language: normaliseLanguage(language),
```

---

## 4. Keys

Dotted paths — `login.signIn`, `messenger.writePlaceholder`. Nesting in the JSON
mirrors the path.

```json
{ "common": { "save": "Save", "delete": "Delete" },
  "messenger": { "send": "Send", "memberCount_one": "{{count}} member" } }
```

**A key may never contain a colon.** `interpolation` leaves `:` as i18next's
namespace separator, so a colon in a key would be read as one.

Current size: **336 keys in `en.json`, 345 in `uk.json`.** The counts differ
legitimately — see plurals below.

### Plurals

English needs two forms and Ukrainian three:

```
nav.unreadAria_one / _few / _many        (uk)
nav.unreadAria_one / _other              (en)
```

i18next picks the form from the CLDR rules for the resolved language. The test
compares **stems**, not raw keys:

```js
const PLURALS = ['_zero', '_one', '_two', '_few', '_many', '_other'];
const stem = (key) => { const s = PLURALS.find((c) => key.endsWith(c)); return s ? key.slice(0, -s.length) : key; };
```

The comparison is between what each file *names*, not how many forms it needs.

---

## 5. Model labels, which are a special case

`/api/meta` publishes a label for every model and every field, and those come
from the model definitions on the server — written in English, because that is
where the code is written. The dashboard is built out of them: tab names, panel
headings, table columns.

`src/lib/labels.js` looks each up as a key **with the server's word as the
fallback**:

```js
export function modelLabel(t, model) {
  return t(`models.${model.name}.label`, { defaultValue: model.label });
}
```

That fallback is the whole point. A model registered tomorrow keeps working, in
English, until somebody adds two lines of translation — rather than showing
`models.widgets.label` to a person who never asked to see a key.

Four helpers: `modelLabel`, `itemLabel`, `fieldLabel`, `relationLabel`. They are
plain functions taking `t` rather than hooks, so they can be called from inside a
render loop.

---

## 6. The tests

`test/ui/i18n.test.js`. Three things go wrong on their own, and each has a check.

### a. A key in one file and not the other

i18next falls back silently, so the only symptom is one English line in the
middle of a Ukrainian page. The test compares both directions and asserts
`en.size > 250`.

### b. A key used in a component and defined nowhere

That one renders the key itself — `panels.users.tota` — to whoever is reading.

```js
for (const [, key] of code(file).matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) …
```

Template-literal keys are skipped: `` `models.${name}.label` `` cannot be checked
without knowing the name, and **every one of those passes a `defaultValue` for
exactly that reason**.

### c. A string written straight into JSX

It cannot be translated at all, and nothing complains — it just stays English
forever. Two regexes:

```js
const TEXT = />\s*([A-Z][^<>{}\n][^<>{}]*?)\s*</g;
const ATTR = /\b(title|placeholder|aria-label|alt|label|hint|caption|description
              |tooltip|subtitle|summary|searchPlaceholder)="([^"]+)"/g;
```

The attribute list carries its own history:

> `hint` was missing from this list once, and a sentence sat untranslated in
> `UsersPanel` for exactly as long — so the rule is to add the attribute here
> first, not after.

`className`, `href` and the rest are deliberately absent: a person does not read
them. Comments are stripped before matching, so prose in a comment is not
mistaken for a string. `JAM.chat` is the one allowed literal — it reads the same
in every language, and translating a brand is how you end up with two of them.

---

## 7. The icon subset

Not translation, but the same class of silent failure, and guarded the same way.

`components/Icon.jsx` renders a **font ligature**: `<span class="icon">edit</span>`
draws a pencil. The font is Material Symbols Rounded, subsetted to only the icons
this app names — 33 KB, served same-origin so it is present for the first paint.

An icon missing from the subset renders as **its own name**. `test/ui/icons.test.js`
guards that by reading the source list the subset was built from and checking
every `<Icon name="…">` in the codebase against it.

> **That test currently fails on a clean checkout.** It reads
> `docs/icons/export-subset.js`, which has never been in the repository. The
> font itself (`public/fonts/material-symbols-rounded-subset.woff2`) is present
> and its own sub-test passes. Recreating the source list is a build concern
> rather than a documentation one, so it is not done here.

`src/index.css` also references `docs/icons/README.md`, which likewise does not
exist.

---

## 8. Adding a language

1. Add `src/i18n/<code>.json` — a full copy of `en.json`, translated.
2. Add it to `LANGUAGES` in `src/i18n/index.js` and to the `resources` map.
3. Add the code to `LANGUAGES` in `server/db/models/users.js`, so
   `normaliseLanguage` accepts it and the column will store it.

Both `normaliseLanguage` implementations must agree. There is no shared module —
the client cannot import from `server/`, and the duplication is deliberate and
commented on both sides.

Then run `npm test`: the first check will list every key you missed.

## Adding a string

Never write it into a component. Add the key to **both** `en.json` and
`uk.json`, then `t('your.key')`. If you cannot translate it yet, the test still
requires the key to exist in both files — a Ukrainian value that is temporarily
English is visible and fixable; a missing key is neither.

Related: [React](react.md) · [Users, roles and permissions](permissions.md)
