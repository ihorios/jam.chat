# User groups

A group is **a set of people rather than a named room** — it reads as who is in
it. There is no title field, no description, no avatar.

---

## 1. The model

`server/db/models/user-groups.js`. Two fields' worth of substance:

```js
super({
  name: 'user_groups',
  requires: ['users'],
  ownedBy: 'owner',
  membership: { relation: 'members' },
  fields: {
    owner: { type: 'reference', target: 'users', required: true },
  },
  relations: {
    members: { type: 'manyToMany', target: 'users', through: 'user_group_users', privileged: true },
  },
});
```

| | |
| :--- | :--- |
| `owner` | a single foreign key, `user_groups.owner_id`. Deleting the owner **deletes the group** |
| `members` | many-to-many through `user_group_users`. Deleting a member only drops their membership row |

`ownedBy` and `membership` are what make those two roles mean something beyond
bookkeeping — they are what `user_groups:*:own` and `user_groups:read:member`
resolve against. The two are independent: a role can be granted *"the groups you
are in"* or *"the ones you own"*.

There is deliberately **no `seed()`**: a default group would need an owner, and a
fresh database has no users to own one.

---

## 2. `members` is privileged, and that is the whole design

```js
members: { …, privileged: true }
```

`routes/crud.js` deletes privileged keys from the body of any scoped request. So
an ordinary account **cannot set the member list**, ever. Without that, naming
your own members would let you put anybody into a conversation with anybody.

This forces the entire membership API into two explicit operations — invite and
leave — where each can be checked properly. It is also why the `user` role holds
no `user_groups:update:*` at all:

> Changing who is in a group is what invite and leave are for, and `members` is
> privileged precisely so that it cannot be done by naming a list.

The dashboard, holding the unscoped permission, writes the field directly like
any other.

---

## 3. Creating one

`user_groups:create:own`. The scoped create pins the owner to the session, and
`members` is stripped — so `parseInput` puts the owner in:

```js
async parseInput(input, options = {}) {
  const parsed = await super.parseInput(input, options);
  const owner = parsed.columns[this.fields.owner.column];
  if (!options.partial && owner && !parsed.relations.members?.length) {
    parsed.relations.members = [Number(owner)];
  }
  return parsed;
}
```

**A new group has exactly one person in it: whoever created it.** A group nobody
is in is a group nobody can read. This is also what makes *"create a group, then
invite somebody"* the only way an ordinary account builds one.

An unscoped caller says who the members are and is left alone.

---

## 4. Inviting

`POST /api/messenger/groups/:id/invite`, body `{ email }`.

**No permission beyond a session.** Membership is the authority:

```js
const groupFor = async (request) => {
  const id = Number.parseInt(request.params.id, 10);
  if (Number.isNaN(id)) return null;
  if (!(await fastify.models.user_groups.isMemberOf(id, request.user.id))) return null;
  return fastify.models.user_groups.findById(id);
};
```

Only somebody in a group may invite to it, and a group they are not in is
reported as **missing rather than forbidden** — the same answer a read would
give, so the response says nothing about what exists outside their groups.

### An exact address, and nothing else

No partial match, no list to pick from, no id. **That is the whole protection**:
you can only add someone whose address you already have, so a group cannot be
filled by working through ids or guessing at names.

Matched case-insensitively, as signing in with it is.

| Case | Response |
| :--- | :--- |
| no such address | `404` — *"No account uses that address."* |
| the account is disabled | `404`, same message |
| already in the group | `409` — *"<name> is already in this group."* |
| success | `200` with the updated group |

A disabled account is refused because it cannot sign in, so adding it would put
somebody in the conversation who can never read it.

### Two decisions worth reading

**An address that belongs to nobody is said so plainly.** It is not an
enumeration oracle worth guarding: every account holds `users:read`, so who
exists is already readable — and an invite that silently did nothing would leave
a typo looking like a success.

**Already-a-member is a refusal, not a no-op**, because it is almost always a
mistake worth knowing about: the wrong person picked out of a list of similar
names, or an address typed from memory. Answering "done" would hide it.

Which is only useful if the refusal means what it says. A form that submits twice
would otherwise add the person on the first request and report them as already
present on the second — the same message, for an invitation that had in fact just
worked. **What stops that is the guard in the client**, not this check:

```js
if (!inviteEmail.trim() || invitingRef.current || selectedId === null) return;
invitingRef.current = true;
```

A ref rather than state, because two submits in the same tick would both read the
old state.

The route publishes `{ type: 'updated', model: 'user_groups', row: updated,
previous: group }`. `previous` is what tells the realtime layer who a membership
change *cost* the group — an invite costs nobody, but the same event carries
both. See [WebSockets §5](websocket.md#5-groups-two-frames-because-it-is-two-pieces-of-news).

---

## 5. Leaving

`POST /api/messenger/groups/:id/leave`. At any moment, without asking anybody.

**Leaving never destroys a group somebody is still in** — not even a group of
one. Ending it is a decision its owner makes, deliberately, by deleting it. So
the last person in a conversation keeps it: they are told who left, and it is
then theirs to invite somebody into or to throw away.

Which leaves two things for the route to do, and one it used to have to.

### a. The owner leaving is not the group ending

```js
const ownerLeft = Number(group.owner) === Number(request.user.id);
await fastify.models.user_groups.update(group.id, {
  members: remaining.map((m) => m.id),
  ...(ownerLeft ? { owner: Math.min(...remaining.map((m) => m.id)) } : {}),
});
```

The column is what `user_groups:*:own` resolves against, so leaving it pointing at
somebody who walked out would both go on giving them the group *and* leave nobody
inside it able to delete it.

**The new owner is the lowest remaining user id** — the oldest account left in
it, and when one person is left, simply them. Not the longest-standing *member*,
which would be the better rule and is not available: `user_group_users` records
who is in a group and not when they joined, and `writeRelations` replaces the
whole set on every change, so neither a column nor row order can be read as join
order.

What this rule does guarantee is that the answer is **the same on both drivers**
rather than following whatever order a repository returns members in — and that
it always names somebody inside the group.

### b. Everybody still there is told

```js
const notice = await fastify.models.user_messages.create({
  owner: request.user.id, group: group.id,
  value: `${nameOf(request.user)} left the group.`, system: true,
});
```

An ordinary message, so it arrives live, counts as unread and keeps its place in
the thread. Created **after** the membership change, so it reaches the people
still there rather than the person it is about.

### c. Their read position goes with them — for free

There is no code here for it any more. `last_read_at` lives on the
`user_group_users` row, so removing the membership removes the read position in
the same statement.

That used to be a hand-written cleanup, and it existed because the two could
drift: a marker left behind would come back if the person were ever invited
again, silently marking everything said before today as already read. Putting
the value on the membership makes the stale state unrepresentable rather than
tidied up. See [Models §4](models.md#4-relations).

### The one case where leaving does remove a group

```js
if (remaining.length === 0) {
  await fastify.models.user_groups.remove(group.id);
  await fastify.realtime?.publish({ type: 'deleted', model: 'user_groups', row: group });
  return { ok: true, removed: true };
}
```

The last one out. Nobody is left to be told, and nothing to tell them in. It is
not a policy so much as an absence: no member to read it, no member to invite
anybody into it, no owner inside it to delete it. Kept, it would be reachable
only from the dashboard.

The row **as it was** travels with the event — it is the only thing left that can
say who was entitled to hear that it is gone.

The client reflects the same distinction in one button:

```js
const last = group.members.length <= 1;
setConfirming({
  message: t(last ? 'messenger.confirm.leaveLastBody' : 'messenger.confirm.leaveBody'),
  destructive: last,
  …
});
```

> Leaving, which is two different questions wearing one button. With somebody
> else still in the group it is reversible in every way that matters — they can
> invite you back. Alone in it, leaving is the delete.

---

## 6. Deleting

`DELETE /api/user_groups/:id`, the ordinary CRUD route, granted by
`user_groups:delete:own`. **The owner's decision alone** — there is no
`delete:member` to hold, because a group is not destroyed by the people drifting
through it. Membership grants sight of a group and nothing more: no
`create:member`, `update:member` or `delete:member` exists, and the middle one
was an ownership hijack (a scoped write has its owner imposed, so any member
PUTting the group became its owner). See
[Permissions §2](permissions.md#2-where-scopes-come-from).

Ownership follows the people in it — §5a hands the column to a remaining member
— so the person who can end a group is always somebody inside it.

Everything cascades: the messages in it, and (via `user_messages.afterDelete`)
their attachments.

---

## 7. Reading

`user_groups:read:member` — the groups you are in. The filter is built by the
repository:

```js
const relation = model.membershipRelation;
const res = await query(
  `SELECT ${relation.localKey} AS id FROM ${relation.through} WHERE ${relation.targetKey} = $1`,
  [userId]
);
return { column: 'id', values: res.rows.map((row) => row.id) };
```

A read of `user_group_users` by `user_id` — which is why `Model#indexes()` indexes
the **target key** of every many-to-many. The table's primary key is
`(group_id, user_id)`, which serves lookups by group and nothing at all by user,
and the user side is the hot one: this runs on every member-scoped request there
is.

```js
if (values.length === 0) return [];
```

**Belonging to nothing is not the same as no filter at all** — without that line,
a member of no groups would see every group.

---

## 8. Live updates

Two frames, because a membership change is two different pieces of news depending
which side of it you are on:

| You are | Frame |
| :--- | :--- |
| in the group now | `group` — the whole row |
| in it a moment ago | `group-gone` — **the id and nothing else** |

Somebody removed has just lost the right to read the group, so the row must not
travel with the news that it is gone. And they cannot be found by asking who is a
member — by then they are not — which is why `previous` exists.

Full detail: [WebSockets §5](websocket.md#5-groups-two-frames-because-it-is-two-pieces-of-news).

---

## 9. Calls follow membership

```js
const callableGroup = async (value, userId) => {
  const id = groupId(value);
  return (await models.user_groups.isMemberOf(id, userId)) ? id : null;
};
```

**Membership of the group is the whole test**, and deliberately the same one the
messenger applies: if you may be told what is said in a group, you may be in its
call. An administrator who can read every group is not thereby a member of any,
and does not get rung.

---

## 10. What is not implemented

- **No names, descriptions or pictures.** A group is its members.
- **No roles within a group** beyond owner/member. No moderators, no kicking —
  you can invite, and you can remove yourself.
- **No invitation acceptance.** An invite adds the person immediately; there is
  no pending state and no way to decline other than leaving.
- **No join links or discovery.** An exact address is the only way in.
- **No transfer of ownership** except implicitly, by the owner leaving.
- **No archive.** A group is present or deleted.

Related: [Messages](messages.md) · [Calls](calls.md) ·
[Users, roles and permissions](permissions.md)
