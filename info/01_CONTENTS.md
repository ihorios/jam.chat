# JAM.chat — documentation

A group messenger with attachments and voice calls, on a Fastify 5 backend and
a React 19 client, plus an admin dashboard that builds itself from the models
the server registers.

```
React 19 + Vite ── HTTP + WebSocket ── Fastify 5 ── Postgres
                                          ├─ WebRTC signalling
                                          └─ S3-compatible object storage
```

This directory is the detailed reference. The project [`README.md`](../README.md)
is the short version — how to run it, and what it does.

---

## Contents

Fourteen documents. Every one is written to be read on its own, so each repeats
the little it needs from the others rather than sending you away mid-sentence.

| File | Document | What is in it |
| :--- | :--- | :--- |
| [`README.md`](README.md) | **This index** | The summary, the feature list, a map of every source file, and the notes on what is broken |
| **Platform** | | |
| [`fastify.md`](fastify.md) | [Fastify](fastify.md) | The server. Boot sequence, the eight plugins and why that order, the two global request guards, subsystems and degraded operation, error handling, static serving, configuration, and the full route table |
| [`react.md`](react.md) | [React](react.md) | The client. Layout, routing and the two-stage access check, the three contexts and why each is split across two files, `lib/api.js`, the self-building dashboard, icons, styling, the unread badge and the single breakpoint |
| [`models.md`](models.md) | [Models and the database](models.md) | The model kernel — the file to read first. The registry, field types and flags, relations **including columns on the link row**, ownership and membership, hooks, generated DDL and index rules, schema reconciliation, both drivers and their aggregate, seeding, and how to add a model |
| [`websocket.md`](websocket.md) | [WebSockets](websocket.md) | One socket per tab. The handshake, every frame in both directions, the store, permission-checked fan-out, **why messages follow membership rather than the read permission**, what is resolved once per event rather than per socket, the two group frames, presence, the client half, why a backing service failing is not fatal, and what is not there |
| [`throttling.md`](throttling.md) | [Throttling](throttling.md) | Flood control. The fixed-window counter and its known imprecision, the five policies, who a caller is, where each is applied, and the ceilings that are not rate limits |
| [`translation.md`](translation.md) | [Translation](translation.md) | Two languages. i18next setup, where the language comes from, keys and plurals, model labels, the three tests that fail the build, the icon subset, and how to add a language |
| **Identity** | | |
| [`oauth.md`](oauth.md) | [OAuth](oauth.md) | Sign in with Google. Configuration, ID-token verification and the two checks that matter most, claims to identity, account creation and linking, the route, the client button, and what is not implemented |
| [`permissions.md`](permissions.md) | [Users, roles and permissions](permissions.md) | The scoped permission model. The vocabulary, where scopes come from, the full 36-permission catalogue and what membership deliberately cannot grant, the enforcement mechanisms — including the two ways a caller may narrow a read — the three seeded roles, the users model, sessions, and the client mirror |
| **Storage** | | |
| [`file.md`](file.md) | [Files and S3](file.md) | The storage layer. The provider interface, the object reference and why the bucket travels with the row, object keys, boot-time provider choice, both providers, **why downloads are not signed URLs**, the sweep, pictures, every variable, and a bucket smoke test |
| [`attachments.md`](attachments.md) | [Files in messages](attachments.md) | Attachments as a feature. Why upload happens before send, attaching only your own files, the four ways to read one, **the four ways an attachment stops being wanted**, limits, and the interface |
| **The messenger** | | |
| [`user-groups.md`](user-groups.md) | [User groups](user-groups.md) | A group is its members. Why `members` is privileged, creating, inviting by exact address, leaving and the three things it does, ownership handover, deleting, and live updates |
| [`messages.md`](messages.md) | [Messages](messages.md) | The model and its four permissions, **lazy loading one conversation at a time**, sending, replying, editing and the order that matters, deleting, live delivery of all three event types, unread counting as an aggregate, and the interface — the authorship gate on edit and delete, and the unread badge |
| [`calls.md`](calls.md) | [Calls](calls.md) | WebRTC. The division of labour, why a participant is a connection, all ten frames, who offers to whom, the registry, authorisation, ringing and giving up, ICE and TURN credentials, the browser half, and what is not implemented |

Two documents are named for something other than their topic, and deliberately:
`file.md` because four places in the codebase already reference `docs/file.md`
by section number, and `attachments.md` because it is the *feature* half of the
same subject.

---

## The one idea worth reading first

**Models generate almost everything.** A model is a single file in
`server/db/models/`. Registering it produces, with no other edit anywhere in
the codebase:

| From the model | What appears |
| :--- | :--- |
| its fields | tables, columns, indexes |
| its relations | side tables, eager loading |
| its declared actions | REST routes at `/api/<model>` |
| its `permissions()` | entries in the permission catalogue |
| `ownedBy` / `membership` | the `:own` and `:member` scopes |
| `/api/meta` | a tab in the dashboard, with a generated form |

Five models exist: `roles`, `users`, `files`, `user_groups` and
`user_messages`. They are installed in that order, which is dependency order
derived from each model's `requires`.

A relation may also carry columns of its own, for data belonging to the pair
rather than to either end — see [Models §4](models.md#4-relations).

Almost every other document here is downstream of this one. Start with
[Models and the database](models.md) if you intend to read only one.

---

## Features

**Conversations.** A group is a set of people rather than a named room. You
create one, invite by an email address you already know, and leave whenever you
like. Leaving never destroys a group somebody is still in — the owner walking
out hands it to a remaining member, and only the last member left can delete
it. Departures are announced in the conversation itself, as an ordinary message
flagged `system`.

**Messages** carry replies, edits, emoji and up to three attachments each. A
message may be nothing but attachments. Deleting one takes its attachments with
it, unless another message still uses them.

**Voice calls** over WebRTC, signalled on the same socket the messages use. One
press rings every open tab of every group member. No media passes through the
server.

**Live everything.** One WebSocket per tab carries new messages, edits,
deletions, unread counts, presence and call signalling. Delivery is decided by
the same permissions a request would be — except a message, which follows
membership, so an administrator's chats page is their own conversations rather
than every one in the installation.

**Two languages**, English and Ukrainian, chosen from the browser and then from
the account. Every string is a key, and a test fails the build if one is not.

**An admin dashboard** built from `/api/meta`. A model added on the server gets
a working screen with no frontend work.

**It stays up when its dependencies do not.** An unreachable database or bucket
is recorded against a subsystem, logged once, and the routes that need it answer
`503` while everything else carries on.

---

## Reading the code

The code is commented on the assumption that the reader wants to know *why*,
not what the next line does. The three files worth reading in full:

| | |
| :--- | :--- |
| `server/db/models/model.js` | the model kernel — 570 lines that generate the rest |
| `server/routes/crud.js` | how a model becomes a guarded REST surface |
| `server/plugins/realtime.js` | how an event finds the sockets entitled to it |

---

## Every file, and what it is for

131 source files: 47 on the server, 43 in the client, 41 tests.

### Root

| File | |
| :--- | :--- |
| `package.json` | scripts and dependencies. Two `"//"` keys explain non-obvious choices: why Vite is a runtime dependency, and why `@fastify/multipart` is pinned exactly |
| `vite.config.js` | `root: 'src'`, the dev proxy to `:3000` (including `ws: true` for the socket), and the Lightning CSS config that resolves `@custom-media` |
| `.env.example` | every setting and why it exists — the authoritative configuration reference |
| `.oxlintrc.json` | lint rules |
| `README.md` | the short version: run it, and what it does |
| `app.md` | a plan for an Android wrapper. Not implemented |

### `server/` — entry and wiring

| File | |
| :--- | :--- |
| `index.js` | starts the server: signal handling, the shutdown deadline (`config.shutdownTimeoutMs`), the boot banner |
| `app.js` | builds the Fastify instance without listening. Plugin order, the two global `onRequest` guards, and the loop that mounts a CRUD surface per model |
| `subsystems.js` | which backing services are working and why not. `REQUIRED`, and `withDeadline` |
| `config/env.js` | the only module that reads `process.env`. Loads `.env`, freezes `config` |

### `server/plugins/` — registered in this order

| File | |
| :--- | :--- |
| `subsystems.js` | first, so everything below has somewhere to report failure |
| `error-handler.js` | one place that turns a thrown error into a response. 5xx never returns its message |
| `rate-limit.js` | decorates `rateLimit` (preHandler) and `limiter` (raw counter, for socket frames) |
| `db.js` | brings the data layer up and exposes `fastify.models`. Cannot stop the boot |
| `auth.js` | session cookie, `authenticate`, `authorize`, `requirePermission`, `sessionUser`, and `grantedScope` — shared with the realtime layer |
| `realtime.js` | the WebSocket, and the permission-checked fan-out. The hardest file in the server |
| `files.js` | multipart parser, storage provider, and the 15-minute orphan sweep |
| `static.js` | serves `dist/` and nothing else. The SPA fallback, and the two cases that must stay real 404s |

### `server/routes/`

| File | |
| :--- | :--- |
| `crud.js` | **builds the REST surface for any model.** Scope filtering, ownership pinning, privilege stripping, and the two link checks |
| `auth.js` | login, register, Google, logout, `/me` |
| `messenger.js` | unread, read, invite, leave — the operations that are not CRUD |
| `files.js` | upload and download. The download is here because readability follows the *message*, not the file |
| `user-picture.js` | a picture is two writes at once, so it is not a field update |
| `calls.js` | `GET /api/calls/ice` — minted per request, `no-store` |
| `presence.js` | who is connected, gated on unscoped `users:read` |
| `meta.js` | `/api/meta` and `/api/permissions` — what the dashboard builds itself from |
| `health.js` | `/liveness`, `/healthz`, `/readyz` — liveness and readiness are different questions |

### `server/db/` — the model layer

| File | |
| :--- | :--- |
| `models/model.js` | the kernel. DDL generation, index rules, `parseInput`, the hooks |
| `models/fields.js` | field types, `PASSWORD_RULES`, `ValidationError` |
| `models/catalog.js` | the permission vocabulary. **No imports at all**, to avoid a cycle |
| `models/index.js` | auto-registers every model file, sorts by dependency, links, builds the catalogue |
| `models/roles.js` | the three seeded roles. `admin` self-heals; `BACKFILL` covers the rest |
| `models/users.js` | fields, `privileged` flags, `normaliseLogo`, `FIRST_USER_ID`, the admin seed |
| `models/files.js` | a row pointing at bytes elsewhere. `beforeDelete` removes the object first, so a failure refuses the delete |
| `models/user-groups.js` | owner + members. `parseInput` puts the creator in the group |
| `models/user-messages.js` | `afterDelete` removes attachments no other message carries |
| `schema.js` | reconciles tables against the models on every boot, plus the legacy migrations |
| `repository.js` | one repository per model, on whichever driver is live |
| `pg-repository.js` | the Postgres driver. Hydration, relation writes, the scope filters |
| `memory-repository.js` | the array-backed driver, mirroring the same interface |
| `index.js` | the pool. Returns `false` with no connection string; **throws** when one is set and unreachable |
| `seed.js` | walks the registry in dependency order |

### `server/realtime/` and `server/files/`

| File | |
| :--- | :--- |
| `realtime/store.js` | who is connected, and publish/subscribe. Shaped like Redis, backed by a `Map` |
| `realtime/calls.js` | the call registry and hub. Testable without a WebSocket |
| `realtime/ice.js` | STUN/TURN, and the HMAC that mints an expiring TURN credential |
| `realtime/unread.js` | what is new, and marking it seen |
| `files/index.js` | the provider interface, `objectKey`, `providerFor`, `removeObject` |
| `files/providers/s3.js` | SigV4 via `aws4fetch` — no SDK, three verbs, every request deadlined |
| `files/providers/local.js` | disk. What the tests run against |
| `files/picture.js` | picture rules, read from the PNG/JPEG header rather than trusted |
| `auth/google.js` | ID-token verification: issuer, **audience**, pinned `RS256` |
| `auth/accounts.js` | what a new account is, whichever way it was created |
| `rate-limit/index.js` | the fixed-window counter |

### `src/` — entry, contexts, lib

| File | |
| :--- | :--- |
| `main.jsx` | mount. Imports `./i18n` for its side effect |
| `App.jsx` | providers, routes, chrome. Nesting order is load-bearing |
| `index.css` | ~2,500 lines, the whole stylesheet. One `@custom-media --mobile` breakpoint |
| `index.html` | the Vite entry |
| `context/AuthContext.jsx` | session, `can`/`scope`, `canAdminister`, language |
| `context/RealtimeContext.jsx` | one socket for the app, plus unread |
| `context/CallContext.jsx` | one call at a time, above the routes |
| `context/{auth,realtime,call}.js` | the context objects and hooks, split out so the `.jsx` exports only a component (Fast Refresh) |
| `lib/api.js` | `fetch` wrapper. Every failure is a thrown `Error`; uploads are separate |
| `lib/socket.js` | the WebSocket with exponential-backoff reconnection |
| `lib/webrtc.js` | the peer mesh. **The only file that knows what an offer is** |
| `lib/permissions.js` | mirrors the server's `grantedScope`, and decides what is administrative |
| `lib/messages.js` | `saveMessageEdit` — update first, then delete dropped files |
| `lib/labels.js` | model words as keys, falling back to the server's English |
| `lib/format.js` | names, dates, and `emojiOnly` (counted in graphemes) |
| `lib/password.js` | mirrors `PASSWORD_RULES`, deliberately duplicated |
| `lib/picture.js` | mirrors the picture rules, for feedback before uploading |
| `lib/pagination.js` | ten rows per page, shared by every panel |
| `lib/thread.js` | what the messenger shows while one conversation is swapped for another |
| `i18n/index.js` | i18next setup, `LANGUAGES`, `normaliseLanguage` |
| `i18n/en.json`, `uk.json` | 336 and 345 keys |

### `src/pages/` and `src/panels/`

| File | |
| :--- | :--- |
| `pages/LoginPage.jsx` | sign in, register, and Google's own button |
| `pages/MessengerPage.jsx` | the largest client file: groups, conversation, composer, invite, calls |
| `pages/DashboardPage.jsx` | tabs from `/api/meta`, bespoke panel or generic fallback |
| `pages/ProfilePage.jsx` | the account editing itself |
| `panels/GenericModelPanel.jsx` | **CRUD for any model, built from its meta alone** |
| `panels/UsersPanel.jsx` | roles, picture, and no delete button for the bootstrap account |
| `panels/RolesPanel.jsx` | the permission matrix |
| `panels/UserGroupsPanel.jsx` | owners and memberships resolved to people |
| `panels/UserMessagesPanel.jsx` | messages with their group, author and attachments |

### `src/components/`

| File | |
| :--- | :--- |
| `Navbar.jsx` | header, links by permission, unread dot, language, account menu |
| `UserMenu.jsx` | who you are signed in as, and the way out |
| `Avatar.jsx` | picture, or initials when there is none |
| `PictureField.jsx` | upload or remove a picture |
| `Icon.jsx` | one Material Symbol, drawn as a font ligature |
| `Logo.jsx` | the mark, inline SVG |
| `EmojiButton.jsx` | the lazy-loaded picker, pinned to Emoji 12.0 |
| `Attachments.jsx` | drafts above the composer, and the list on a sent message |
| `IncomingCallDialog.jsx` | the popup, wherever the person is looking |
| `CallPanel.jsx` | the call in progress. Streams are *assigned* to elements, not passed as props |
| `ConfirmDialog.jsx` | "Are you sure?", drawn by the page rather than `window.confirm` |
| `Pagination.jsx` | the footer of every dashboard list |
| `PresenceMetrics.jsx` | live connection counts |
| `RequireAuth.jsx` | the route gate, with an `administrative` variant |

### `test/` — 40 files, plain node-tap, run by `test/run.js`

No database, no bucket, no network: the harness forces the in-memory store and a
temporary directory, so the suite cannot touch a real one even if `.env` points
at production.

| Area | Files |
| :--- | :--- |
| harness | `run.js`, `helper.js`, `fixtures/images.js`, `fixtures/static/` |
| models | `model`, `registry`, `repository`, `schema`, `role-backfill` |
| routes | `auth`, `register`, `users`, `roles`, `permissions`, `own-profile`, `membership`, `group-membership`, `user-groups`, `user-messages`, `meta`, `health`, `ice`, `rate-limit`, `static`, `static-unbuilt` |
| files | `files`, `files-limits`, `user-picture`, `degraded-files`, `files/picture` |
| realtime | `socket`, `calls`, `ring-timeout`, `group-frames` |
| degraded | `degraded` — builds its own app, because `helper.js` blanks `DB_STRING` |
| auth | `accounts`, `google` — the verifier runs against a key set of the test's own |
| UI invariants | `i18n`, `icons`, `access`, `pagination`, `thread` |

The last group is the interesting one: those guard things that **fail silently**
rather than loudly — a translation key present in one language and not the other,
a string written into a component instead of a key, an icon missing from the
shipped font subset, a dashboard list that forgot its pagination.

### `public/` — copied verbatim

`icon.svg`, `favicon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`,
`icons.svg`, `logo.svg`, `logo-lockup.png`, `logo-lockup-light.png`, and
`fonts/material-symbols-rounded-subset.woff2` — the 33 KB icon font subset.

---

## Notes on this documentation

Everything here was written by reading the source at the commit it accompanies.
Two things found in the process that are worth knowing:

- **`config.sessionMaxAgeSeconds` is 210 days, not 30.** The value is
  `60 * 60 * 24 * 7 * 30`, and the comment beside it in `server/config/env.js`
  reads `// Session 30 days.` The extra `* 7` makes it thirty *weeks*. Nothing
  depends on it being one or the other, so this is a discrepancy rather than a
  fault — but the comment is wrong, and the cookie lives seven times longer than
  it says.
- **`@fastify/multipart` is pinned to an exact `10.1.0`**, alone among the
  dependencies. In `10.1.1` an upload exceeding the `files` limit surfaces as
  `ERR_STREAM_PREMATURE_CLOSE` rather than `FST_FILES_LIMIT`, which
  `routes/files.js` cannot recognise — so "too many files" returns `500` instead
  of `400`. `test/routes/files-limits.test.js` catches it. The reason is
  recorded in `package.json` under `"//multipart"`.
- **`test/ui/icons.test.js` reads `docs/icons/export-subset.js`, which does not
  exist**, so one test fails on a clean checkout. That file is the source list
  the shipped Material Symbols subset is built from; it has never been in the
  repository. It is not created here, because its contents are a build artefact
  rather than documentation. See [Translation](translation.md#7-the-icon-subset)
  for what the test is guarding.
