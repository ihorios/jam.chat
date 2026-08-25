# Users, roles and permissions

Users hold no permissions of their own. They hold **roles**, and their effective
permissions are the union of those roles' grants, recomputed on every read.

```
user ──(user_roles)── role ──(role_permissions)── <model>:<action>[:scope]
```

---

## 1. The vocabulary

`server/db/models/catalog.js`. A permission is `<model>:<action>` optionally
narrowed by a scope suffix.

```js
export const CRUD_ACTIONS = Object.freeze(['create', 'read', 'update', 'delete']);
export const SCOPES       = Object.freeze(['any', 'member', 'own']);
```

`SCOPES` is ordered **broadest first**, and that order is load-bearing — it is
the order a permission check tries them in, so the unscoped permission wins when
both are held.

| Permission | Means |
| :--- | :--- |
| `user_messages:read` | every message there is |
| `user_messages:read:member` | everything said in the groups you are in |
| `user_messages:read:own` | only what you wrote |

`any` is spelled by omission: `permissionKey('users', 'read', 'any')` is
`users:read`, not `users:read:any`.

**Permissions are never written by hand.** The catalogue is built from the
registry at import time, so registering a model adds its permissions and
removing the file removes them. A newly registered model is protected the moment
it exists and appears on the roles screen without being added to a list.

`catalog.js` holds **no imports at all**, deliberately: both the model kernel and
the registry depend on it, and a dependency the other way would be a cycle.

---

## 2. Where scopes come from

A scope exists only where the model can answer it.

| Declaration | Brings into existence |
| :--- | :--- |
| `ownedBy: 'owner'` | `<model>:<action>:own` |
| `membership: {...}` | `<model>:<action>:member` |

The default `Model#permissions()` is one permission per declared action, plus a
member-scoped variant if `membership` is declared, plus an own-scoped variant if
`ownedBy` is. A model that guards itself differently overrides the method and
returns whatever set it means — the catalogue, the permission matrix and the
route guards all follow, because they read the model rather than assume.

Two models do override it:

**`users`** adds one permission by hand:

```js
permissions() {
  return [...super.permissions(), permissionKey(this.name, 'update', 'own')];
}
```

Only `update`, rather than the whole own-scoped set the base class would
generate — `users:delete:own` is an account deleting itself, and
`users:create:own` means nothing at all. (`users` declares no `ownedBy`, so
`super.permissions()` produces no own-scoped variants to begin with.)

**`files`** adds a create permission for a route the model has no action for —
see [Models §11](models.md#11-the-five-models).

### The full catalogue — 36 permissions

| Model | Permissions |
| :--- | :--- |
| `roles` | `create` `read` `update` `delete` |
| `users` | `create` `read` `update` `delete` `update:own` |
| `files` | `read` `update` `delete` `read:own` `update:own` `delete:own` `create` `create:own` |
| `user_groups` | all four × {`any`, `own`}, plus `read:member` = 9 |
| `user_messages` | `read` `create` × {`any`, `member`, `own`}, `update` `delete` × {`any`, `own`} = 10 |

### Membership grants sight, and very little else

Both messenger models declare a `membership`, so the base class would generate a
`:member` variant of all four actions for each. Most of those should not exist,
and they are filtered out in `permissions()` — **removed rather than simply left
ungranted, because a permission that exists is a checkbox on the roles screen,
and a checkbox is an invitation.**

| Model | `:member` published for | Withheld from |
| :--- | :--- | :--- |
| `user_groups` | `read` | `create` `update` `delete` |
| `user_messages` | `read` `create` | `update` `delete` |

What survives is what a conversation actually is: *"the groups you are in"*,
*"everything said in them"*, and *"a message has to land in a group you belong
to"*.

What was withheld, and why each one:

| | |
| :--- | :--- |
| `user_messages:update:member` | anybody in a group could rewrite anybody else's words in it |
| `user_messages:delete:member` | and remove them |
| `user_groups:delete:member` | anybody in a conversation could end it — contradicting the one rule leaving is built on, that a group is destroyed by its owner and not by the people drifting through it |
| `user_groups:create:member` | meaningless. A row that does not exist yet has nobody in it, so there is no membership to check — an exact synonym for `create:own` |
| `user_groups:update:member` | **an ownership hijack**, and the reason this is worth being careful about |

That last one deserves spelling out. A scoped write has its owner *imposed*
rather than taken from the body (see below), and every other field on a group is
privileged — so taking the group was the only thing the permission could do:

```
mallory PUTs the group she is a member of (empty body) -> 200
owner is now                                           -> mallory
mallory DELETEs the group                              -> 200
```

Correcting what **you** said is `:own`; moderating a conversation you are merely
part of is not a middle ground worth having, and the unscoped permission is what
an administrator holds.

**`read:member` is not optional**, though. It is not a convenience on top of
membership — it is the only thing that lets somebody see a group they were
invited to, since `read:own` means *groups you own* and an invitation is somebody
else's. Without it an ordinary account opens an empty messenger:

```
guest with read:member -> groups 1, messages 1
guest with read:own    -> groups 0, messages 1   (nothing to select, so nothing to read)
```

---

## 3. Enforcement

`server/plugins/auth.js` has one function that everything else is built on:

```js
export function grantedScope(model, action, permissions = []) {
  for (const scope of model.scopesFor(action)) {
    if (permissions.includes(permissionKey(model.name, action, scope))) return scope;
  }
  return null;
}
```

`scopesFor(action)` returns the scopes that action can be granted at, **broadest
first**, read back out of `permissions()`. So the unscoped grant is tried first
and wins when both are held.

It is exported because the realtime layer has to make **exactly the same
decision** about a socket that a route makes about a request. One function, two
callers, no chance of drift.

### The three preHandlers

| Decorator | Use |
| :--- | :--- |
| `fastify.authenticate` | requires a session; populates `request.user` |
| `fastify.authorize(model, action)` | requires the permission at either scope; sets `request.scope` |
| `fastify.requirePermission('users:read')` | an exact permission, no scope to resolve |

`authorize` leaves the scope that applied on `request.scope`, because *"may I?"*
and *"to which rows?"* are the same question asked twice.

The refusal names the permission **without the scope**:

```js
throw httpError(403, `Missing required permission: ${permissionKey(model.name, action)}`);
```

Mentioning the own-scoped variant would tell an unprivileged caller more about
the system than the refusal needs to.

There is also `fastify.sessionUser(request)`, which returns the user or `null`
rather than throwing — for the WebSocket handshake, which cannot throw an HTTP
error at a client that has not finished connecting. An anonymous socket is a
legitimate thing to have.

---

## 4. How a scope narrows a request

`server/routes/crud.js`. Six mechanisms — four that narrow a read, two that
constrain a write — and it is worth seeing all of them.

### Reads: filter the query

```js
const rows = await repository.findAll({
  search: request.query.search,
  ...(request.scope === 'own'    ? { owner:  request.user.id } : {}),
  ...(request.scope === 'member' ? { member: request.user.id } : {}),
});
```

### Reads by id: 404, not 403

```js
const findInScope = async (request) => {
  const row = await repository.findById(request.params.id);
  if (!row) return null;
  if (request.scope === 'own' && !model.ownedByUser(row, request.user.id)) return null;
  if (request.scope === 'member' && !(await repository.isMemberOf(row.id, request.user.id))) return null;
  return row;
};
```

A row belonging to somebody else is reported **missing rather than forbidden**,
so the response says nothing about what exists outside the caller's scope. The
same rule applies to groups in the messenger routes and to files.

### Reads: a caller may ask to be narrowed

```js
const readScope = (request) => {
  const asked = request.query?.scope;
  if (!asked || asked === request.scope) return request.scope;
  if (!model.scopesFor('read').includes(asked)) throw /* 400 */;
  // SCOPES is broadest first, so a later index is the narrower scope.
  return SCOPES.indexOf(asked) > SCOPES.indexOf(request.scope) ? asked : request.scope;
};
```

`authorize` sets the broadest scope the caller holds; `?scope=` lets them ask to
be answered at a narrower one. **Narrowing only** — a scope broader than the
grant is clamped back down to it, so this can never become a way to read past a
permission. A scope the model does not offer is a `400`, because answering it
with everything would be the worst of both.

This is what makes the messenger work for an administrator: `/chats` asks for
`?scope=member` and gets their own conversations, while the dashboard asks for
nothing and still sees the whole model. See [Messages §4](messages.md#4-sending).

### Reads: a caller may narrow by a foreign key

```js
// ?group=5 on a model declaring a `group` reference
const match = referenceFilters(request);
```

Only `reference` fields the model declares; anything else in the query string is
ignored, since `?search=` and `?scope=` arrive the same way. It is an extra
`AND` on top of whatever the scope already restricted the caller to, so it can
only ever narrow — asking for a group you are not in returns nothing. This is
what lets the messenger load one conversation at a time.

### Writes: impose ownership, strip privilege

```js
const withOwnership = (request) => {
  const body = { ...(request.body || {}) };
  if (model.ownedBy && (request.scope === 'own' || request.scope === 'member')) {
    body[model.ownedBy] = request.user.id;
  }
  if (request.scope !== 'any') {
    for (const key of model.privilegedKeys()) delete body[key];
  }
  return body;
};
```

**This is the escalation guard.** Without the second half, granting
`users:update:own` would be granting self-promotion: a `PUT` of your own row
carrying `roles: [<admin id>]` is a permission check that passes and an
escalation that succeeds.

Privileged keys are **dropped rather than refused**, for the same reason the
owner is imposed rather than validated — a client sending a whole row back
should save the parts it was allowed to change, not fail wholesale over parts it
was never offered.

### Writes: verify the claims a scope cannot fix

Two checks that ownership-pinning cannot cover:

**`assertCreateInScope`** — a member-scoped create must land somewhere the caller
belongs. Where that is comes from the row it points at (`membershipVia`), so the
reference in the body is checked against the same membership the read scope would
use. A model that decides membership for itself has nothing to check: a row that
does not exist yet has no members.

**`assertLinksInScope`** — a row may only be linked to rows the caller is
entitled to hand out. Today that means attachments: reading a file follows the
message it is attached to, so `files: [7]` without this check is a way to publish
somebody else's upload to a group *and* to read it, since being able to see the
message is the whole permission. It applies to any `manyToMany` whose target has
an owner, and only to a scoped caller.

---

## 5. The three seeded roles

`server/db/models/roles.js`.

### `admin` — a system role

```js
permissions: () => allPermissions()
```

Kept in sync with the catalogue on every boot, so registering a new model
automatically grants administrators access to it. `is_system: true`, and
`beforeDelete` refuses to delete it.

### `moderator`

`users:read`, `users:update`, `roles:read`. Not a system role, so edits to it are
respected. Carries `renamedFrom: 'editor'` — a renamed default role is the same
role, so the row is renamed rather than left beside a new one, but only when the
new name is free.

### `user` — the messenger and nothing else

This is the role every self-created account gets, and it is worth reading in
full because each line is a decision:

| Permission | Why this one |
| :--- | :--- |
| `users:read` | to name the people in a conversation |
| `users:update:own` | their own name and language; privileged fields keep it to that |
| `user_groups:read:member` | the groups they are in |
| `user_groups:create:own` | starting a conversation — filed under them, and a new group has exactly one person in it |
| `user_groups:delete:own` | ending one; the owner's decision alone |
| `user_messages:read:member` | **everything** said in their groups, not just their own |
| `user_messages:create:member` | writing as yourself is only half of it — the message must also land in a group you are in |
| `user_messages:update:own` | there is no `update:member` to hold — see §2 |
| `user_messages:delete:own` | same |
| `files:create:own` `files:read:own` `files:delete:own` | their own uploads |

There is deliberately **no `user_groups:update:*`**. Changing who is in a group
is what invite and leave are for, and `members` is privileged precisely so it
cannot be done by naming a list.

`files:read:own` is **not** what lets somebody read an attachment they were sent.
That follows from the message it is on. What `files:read:own` grants is the list
of your own uploads.

### `BACKFILL`

```js
const BACKFILL = Object.freeze({
  user: ['users:update:own', 'user_groups:create:own', 'user_groups:delete:own'],
});
```

A non-system role is deliberately not kept in sync — an installation may have
edited it. But a row created before a permission existed is missing something its
own description promises, which reads as a fault rather than a choice. A `user`
role without `users:update:own` leaves every ordinary account unable to edit its
own profile, and the only symptom is *"Missing required permission:
users:update"* from a screen that offers to save.

Additive and idempotent. The cost is that removing one of these by hand does not
stick — an entry should be dropped once the installations that needed it have
restarted.

---

## 6. Users

`server/db/models/users.js`.

| Field | Type | Privileged | Note |
| :--- | :--- | :---: | :--- |
| `email` | string, unique | ✔ | changing your sign-in address wants its own flow |
| `first_name` | string, required | | |
| `last_name` | string | | optional — plenty of people have one name |
| `password` | password, required | ✔ | stored as `password_hash`, never sent |
| `is_active` | boolean, default `true` | ✔ | |
| `email_confirmed` | boolean, default `false` | ✔ | shown but not editable on your own profile |
| `logo` | text | | a URL — *not* privileged; your own face is yours to change |
| `logo_file` | integer | ✔ | an uploaded picture's file id |

Deleting an account does **not** delete what it uploaded: `files.owner_id` is
`ON DELETE SET NULL`, so the files outlive it owned by nobody. It used to
cascade, and because Postgres performs a cascade itself no model hook ran — so
every object those rows pointed at stayed in the bucket with nothing left that
knew it was there.
| `language` | string, default `en` | | |
| `roles` | manyToMany | ✔ | **the relation that decides what an account may do** |

### `transform` — three derived fields

```js
user.name = [user.first_name, user.last_name].filter(Boolean).join(' ');
user.picture = Users.pictureUrl(user);          // logo_file → /api/files/<id>/content, else logo
user.permissions = [...new Set((user.roles || []).flatMap((r) => r.permissions || []))].sort();
```

None is stored. `picture` means no client has to know there are two places a
picture could come from.

### `normaliseLogo`

A logo is rendered as an `<img src>` wherever the person appears, so only an
`http(s)` URL may go in it — `javascript:` and `data:` in that position are a
script and a payload rather than a picture. Google's account picture arrives the
same way as one somebody typed and gets the same check: the claim is only as
trustworthy as the token it rode in on.

### The first account

```js
export const FIRST_USER_ID = 1;
```

`beforeDelete` refuses to delete it. Not because it is special in itself, but
because it is **the way back in**: an installation whose last administrator is
gone has no route to a new one, since the only write an anonymous caller may
perform is self-registration and that grants no roles. Deleting it also cascades
— the groups it owns, the conversations in them, the files in those.

`UsersPanel` hides the delete button for id 1 too. That is a courtesy; the model
hook is the rule. A button that is merely absent is still a request anybody can
make by hand.

---

## 7. Sessions

The cookie carries **nothing but a signed user id**.

```js
reply.setCookie(SESSION_COOKIE, String(user.id), {
  path: '/', httpOnly: true, sameSite: 'lax',
  signed: true, secure: config.isProduction,
  maxAge: config.sessionMaxAgeSeconds,
});
```

Identity, roles and permissions are **re-read from the database on every
request**, so a role change or a deactivated account takes effect immediately
instead of lingering until the cookie expires. The realtime layer does the same
per frame, for the same reason.

`httpOnly` means JavaScript cannot read it, which is why `src/lib/api.js` attaches
no token and `src/lib/socket.js` has nothing to send — the handshake is an
ordinary HTTP request and the browser sends the cookie itself.

> **`maxAge` is 210 days, not 30.** `sessionMaxAgeSeconds` is
> `60 * 60 * 24 * 7 * 30`; the comment beside it reads `// Session 30 days.`
> The extra `* 7` makes it thirty weeks.

### Credential checking is timing-flat

```js
const hash = raw?.password_hash || '$2b$10$invalidinvalid…';
const matches = await bcrypt.compare(String(password || ''), hash);
if (!raw || !matches) return null;
```

An unknown account is compared against a dummy hash, so a missing account and a
wrong password take the same time to reject. The login route then returns one
message for both — distinguishing them tells an attacker which addresses are
registered.

---

## 8. The client mirror

`src/lib/permissions.js` mirrors the server, and says so:

```js
export function scopeOf(permissions, permission) {
  if (permissions?.includes(permission))            return 'any';
  if (permissions?.includes(`${permission}:member`)) return 'member';
  if (permissions?.includes(`${permission}:own`))    return 'own';
  return null;
}
```

`AuthContext` exposes `can(permission)` as `scopeOf(...) !== null`, and
`scope(permission)` as the scope itself.

**`can()` is for reaching a screen; `scopeReaches` is for drawing a control on a
row.** Holding only the own-scoped form is enough to open the messenger — the
server then decides which rows come back, and gating the UI more tightly would
hide features from the very people entitled to use them. It is *not* enough to
put an Edit button on somebody else's message:

```js
export function scopeReaches(scope, { own = false, member = false } = {}) {
  if (scope === 'any') return true;
  if (scope === 'member') return Boolean(member);
  if (scope === 'own') return Boolean(own);
  return false;
}
```

The caller describes the row, because only it knows what the row is to this
reader — and sometimes knows the answer outright. The messenger passes `{ own }` alone,
because `user_messages` publishes no `:member` for update or delete — there is
no membership question left for those two to ask. Used for message edit and delete, and for deleting
a group from its header — see [Messages §10](messages.md#10-in-the-interface).

### What counts as administrative

```js
export function hasAdministrativePermission(permissions) {
  return (permissions || []).some((permission) => {
    const parts = permission.split(':');
    if (parts.length !== 2) return false;              // three parts = :own or :member
    const [model, action] = parts;
    return !(model === 'users' && action === 'read');
  });
}
```

The dashboard exists to manage rows somebody else owns, so the accounts that
belong there are those holding a permission with **no scope on it**.
`users:read` is the one unscoped permission that is not administrative — every
account holds it so the messenger can name people, and knowing who exists is not
the same as administering them.

This decides three things at once, which is why it lives in one place: which
links the header offers, which routes open, and where `/` goes.

**The UI check is never the only check.** `RequireAuth administrative` turns an
ordinary account away from `/dashboard`, and every route behind it is
independently guarded on the server. Hiding a link is half of an access rule.

---

## 9. Adding a permission

You do not. Add a model, or add an action to one, and the catalogue follows.

To grant something narrower than the defaults, override `permissions()` on the
model — `users` and `files` both do. The roles screen reads
`/api/permissions`, which reads the catalogue, which reads `permissions()`, so a
bespoke set renders as a matrix without any frontend change.

Related: [Models and the database](models.md) · [OAuth](oauth.md) ·
[WebSockets](websocket.md)
