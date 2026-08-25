# 💬 JAM.chat

A messenger — group conversations, attachments and voice calls — on a Fastify
backend and a React client, with an admin dashboard that builds itself from the
models the server registers.

```
React 19 + Vite ── HTTP + WebSocket ── Fastify 5 ── Postgres
                                          ├─ WebRTC signalling
                                          └─ S3-compatible object storage
```

---

## Getting it running

```bash
npm install
cp .env.example .env      # then fill in SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm run dev               # client on :5173, proxying the API to :3000
npm run server            # the backend, in another terminal
```

**Nothing else is required.** With no `DB_STRING` the app runs on an in-memory
store, with no bucket configured attachments go to `./.files`, and calls work over
public STUN. Everything is a fallback until you configure the real thing — see
`.env.example`, which explains each variable and why it exists.

To run it the way it is deployed — one process serving the built client and the
API together:

```bash
npm run up                # build, then start on :3000
```

**A fresh database has no way in** unless `ADMIN_EMAIL` and `ADMIN_PASSWORD` are
set: self-registration is the only public write and it deliberately grants no
roles. The first account is seeded on boot, only when the address is free, so a
password change survives a restart.

### Scripts

| | |
| :--- | :--- |
| `npm run dev` | Vite dev server with HMR |
| `npm run server` | the API, without building the client |
| `npm run build` | bundle the client into `dist/` |
| `npm run up` | build, then serve everything from one process |
| `npm test` | the whole suite (`npm test -- users` filters by path) |
| `npm run lint` | Oxlint |

---

## What it does

**Conversations.** A group is a set of people rather than a named room — it reads
as who is in it. You start one, invite by an email address you already know, and
leave whenever you like. Leaving never destroys a group somebody is still in; the
owner walking out hands it to a remaining member, and the last member left can
delete it deliberately. Departures are announced in the conversation itself.

**Messages** carry replies, edits, emoji and up to three attachments each. Edit
and delete appear where the permission reaches: on your own words with an
own-scoped grant, on anybody's with an unscoped one, and nowhere without. Attachments are
read through the server, never from the bucket directly, so leaving a group ends
access to what was said in it.

**A conversation loads when you open it.** The sidebar draws itself from the
unread frame alone — a count and a last line per group — so visiting the
messenger costs one list of groups rather than every message in every one of
them. A group with something new in it is drawn brighter and carries a red
count, which clears the moment it is opened.

**Voice calls** over WebRTC, signalled on the same socket the messages use. One
press rings every open tab of every member.

**Live everything.** One WebSocket per tab carries new messages, edits,
deletions, unread counts, presence and call signalling. Delivery is decided by
the same permissions a request would be — except a message, which follows
membership, so /chats is somebody's own conversations whatever their role.

**Two languages**, English and Ukrainian, chosen from the browser and then from
the account. Every string in the interface is a key; a test fails the build if
one is not.

---

## How it is put together

### Models define almost everything

A model is one file in `server/db/models/`. Adding it gives you, with no other
edit anywhere:

- its tables, and the side tables for its relations
- its indexes, derived from what it declares
- a permission per action, at every scope it can be granted at
- REST routes at `/api/<model>`
- a repository on both drivers
- a tab in the dashboard, with a form built from its fields

There are five: `users`, `roles`, `files`, `user_groups` and `user_messages`.

A relation may also carry columns of its own — data belonging to the *pair*
rather than to either end of it. How far somebody has read in a group is the one
today, and it lives on `user_group_users` beside the membership it describes.

### Permissions have scope

A permission is `<model>:<action>` optionally narrowed to `:own` or `:member`.

A scope exists only where the model can answer it — and only where it should be
grantable. Membership grants sight of a conversation and very little else: a
group publishes `:member` for reading alone, a message for reading and writing.
Editing or deleting other people's words, or the group around them, is `:own` or
nothing.

| | means |
| :--- | :--- |
| `user_messages:read` | every message there is |
| `user_messages:read:member` | everything said in the groups you are in |
| `user_messages:read:own` | only what you wrote |

The catalogue is generated from the models, so a newly registered model is
protected the moment it exists and appears on the roles screen without being
added to a list. Three roles are seeded: **admin** (kept in sync with the
catalogue), **moderator**, and **user** — the messenger and nothing else.

Scoped writes are narrowed on the way in as well as on the way out: fields marked
privileged are stripped from a scoped request, so `users:update:own` means "edit
yourself" and can never mean "promote yourself".

### It stays up when its dependencies do not

A database that cannot be reached, a bucket that has gone quiet, a schema
statement that fails — none of them stop the server starting. Each is recorded
against a subsystem, logged once, and the routes that need it answer **503** while
everything else carries on. `/liveness` stays green so the platform does not
restart-loop an instance that is up and explaining itself; `/readyz` says what is
actually wrong.

A configured-but-unreachable database deliberately does **not** fall back to the
in-memory store: an app that boots looking healthy and loses every write on
restart is worse than one that refuses the request.

---

## Layout

```
server/
├── app.js              # the Fastify instance; routes are mounted from the registry
├── db/
│   ├── models/         # one file per model — the source of truth for everything
│   ├── schema.js       # tables, columns and indexes, reconciled on boot
│   ├── pg-repository.js
│   └── memory-repository.js
├── plugins/            # auth, db, files, rate-limit, realtime, static, subsystems
├── realtime/           # the socket store, calls, unread
├── routes/             # crud.js builds most of them; the rest are the exceptions
└── subsystems.js       # what is broken, and what to answer while it is

src/
├── pages/              # login, messenger, dashboard, profile
├── panels/             # one per model; GenericModelPanel covers the rest
├── components/
├── context/            # auth, realtime, calls
├── lib/                # api, permissions, pagination, native bridge shim
└── i18n/               # en.json, uk.json

test/                   # 37 files, run by test/run.js on plain node
```

### The API, roughly

| | |
| :--- | :--- |
| `POST /api/auth/login`, `/register`, `/google`, `/logout` · `GET /api/auth/me` | sessions |
| `GET/POST/PUT/DELETE /api/<model>` | generated per model |
| `?search=` · `?scope=` · `?<reference>=` | narrow a list: by text, to your own corner, or to one parent row |
| `POST /api/messenger/groups/:id/invite` · `/leave` | the two changes that are not CRUD |
| `GET /api/messenger/unread` · `POST /api/messenger/read` | what is new |
| `POST /api/files` · `GET /api/files/:id/content` | upload and download |
| `GET /api/meta`, `/api/permissions` | what the dashboard builds itself from |
| `GET /liveness`, `/healthz`, `/readyz` | probes |
| `WS /ws` | messages, presence, unread, call signalling |

---

## Testing

```bash
npm test                 # everything
npm test -- messenger    # filters match the whole relative path
npm test -- -v           # full TAP output rather than a summary
```

Each file is a standalone node-tap program run by `test/run.js`. The suite needs
no database, no bucket and no network: it forces the in-memory store and a
temporary directory, so it cannot touch a real one by accident even if `.env`
points at production.

Several tests guard things that fail silently rather than loudly — an icon
missing from the shipped font subset, a translation key present in one language
and not the other, a string written into a component instead of a key, a dashboard
list that forgot its pagination.

---

## Deploying

`render.yaml` describes it: `npm install && npm run build`, then `npm start`, with
the health check on `/liveness`. Everything else is environment variables set in
the dashboard rather than in a file. For anything real you want `DB_STRING`,
`SESSION_SECRET`, and an S3-compatible bucket — the first two because the
alternatives lose data on restart, the third because a container's disk does not
survive a deploy.

---

## Further reading

| | |
| :--- | :--- |
| `.env.example` | every setting, and why it is there |
| `docs/file.md` | attachments end to end, with a bucket smoke test |
| `app.md` | plan for an Android wrapper around this app |
| `docs/todos.md` | what is next |

The code is commented on the assumption that the reader wants to know *why*
something is the way it is, not what the next line does. The interesting ones are
`server/db/models/model.js`, `server/routes/crud.js` and `server/plugins/realtime.js`.
