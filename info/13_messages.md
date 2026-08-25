# Messages

Something a user said in a group. Two foreign keys and a body: `owner` is who
wrote it, `group` is where, `value` is what.

---

## 1. The model

`server/db/models/user-messages.js`.

| Field | Type | Notes |
| :--- | :--- | :--- |
| `owner` | reference → `users`, required | the author; **cascades** |
| `group` | reference → `user_groups`, required | **cascades** |
| `value` | text, required | |
| `reply_to` | reference → `user_messages` | optional, **`ON DELETE SET NULL`** |
| `system` | boolean, default `false`, **privileged** | written by the application |
| `files` | manyToMany → `files` | up to 3 |

```js
ownedBy: 'owner',
membership: { via: 'group' },
searchable: ['value'],
```

Author and group both cascade, so a message outlives neither — there is nowhere
for it to belong once either is gone.

**`reply_to` is the exception.** Deleting the message replied to sets it to null
rather than taking the reply with it: *a reply is a remark in its own right —
losing the thing it answered leaves it stranded, not meaningless.*

### `membership: { via: 'group' }`

Membership is not the message's own business: whoever belongs to its group
belongs to it. That is what makes `user_messages:read:member` mean **"everything
said in the groups you are in"** — including what other people said, which is the
whole point of a conversation.

### `system`

Written by the application rather than by a person: *"so-and-so left the group"*.
A message like any other, so it arrives live, counts as unread and keeps its
place in the conversation — and it carries the person it is about as its author,
because a message needs one.

**Privileged**, so a scoped caller cannot dress their own message up as a notice
from the application.

---

## 2. Permissions

The `user` role holds four, and each is scoped deliberately:

| Permission | Why that scope |
| :--- | :--- |
| `read:member` | everything said in your groups |
| `create:member` | writing as yourself is only half of it — the message must also land in a group you are in |
| `update:own` | there is no `update:member` to hold — it would let anybody in a group **rewrite anybody else's words**, so the model does not publish it |
| `delete:own` | same |

`create:member` is enforced by `assertCreateInScope`, which follows
`membershipVia` to check the claim:

```js
const via = model.membershipVia;                       // the `group` field
const target = fastify.models[via.target];
if (!(await target.isMemberOf(body[via.name], request.user.id))) throw /* 403 */;
```

**The chats page narrows itself.** `/chats` requests
`/api/user_messages?scope=member` and `/api/user_groups?scope=member`, so an
administrator opening it sees their own conversations rather than everybody's.
`routes/crud.js` clamps rather than widens, so an account holding only the
member- or own-scoped permission is unaffected by asking. Reading past your own
conversations is the dashboard's job.

The owner is pinned by `withOwnership` — a scoped author cannot file a message
under somebody else. The client sends `owner` anyway, for the unscoped case:

```js
// Sent explicitly for an unscoped author (an admin writing as themselves);
// a member-scoped session has it pinned by the server either way.
owner: currentUser.id,
```

---

## 3. Loading a conversation

The chats page is **lazy**: the sidebar draws itself without any messages at
all, and a conversation is fetched when it is opened.

```js
const res = await api(`/api/user_messages?scope=member&group=${groupId}`);
```

`?group=` is a foreign-key filter that `routes/crud.js` builds from the query
string for any `reference` field a model declares. It **narrows within the
caller's scope** rather than around it — an extra `AND` on top of the member
filter — so asking for a group you are not in returns nothing rather than
something.

Two consequences worth knowing:

- **The page holds one conversation, as `{ group, items }`** — the messages
  *and* the group they belong to, together. A `message` frame for any other
  group is ignored: the same write also sends an `unread` frame, which is what
  moves that group's badge and preview.

  The pairing is not tidiness. Selecting a group re-renders immediately while
  the fetch is scheduled behind that render, so for one render the thread on
  screen is still the *previous* group's. Held as a bare array with an assumed
  match, that render drew the old conversation under the new group's header and
  the old group's last line beside the new group's name, until the fetch landed
  and overwrote both. Everything is now derived from
  `thread.group === selectedId` (`src/lib/thread.js`), answerable in the first
  render because it is a fact rather than a scheduled update.
- **The sidebar preview cannot come from the messages any more**, because they
  are not loaded. It comes from `unread.latest` — see §8.

## 4. Sending

```js
await api('/api/user_messages', {
  method: 'POST',
  body: { owner: currentUser.id, group: selectedId,
          value: draft.trim() || ' ',
          files: attachments.map((f) => f.id),
          ...(replyTo ? { reply_to: replyTo.id } : {}) },
});
setDraft(''); setReplyTo(null); setAttachments([]);
await loadMessages(selectedId);
```

`value` falls back to a single space, because `value` is `required` and **a
message may be nothing but attachments**.

The client refetches rather than waiting for its own message to arrive over the
socket:

> The socket delivers this back to everyone including us, but a sender should
> never be left waiting on the network to see their own words.

`Enter` sends, `shift+Enter` starts a new line. Send is refused while `sending`
or `uploading` — a message cannot be sent half-attached.

---

## 5. Replying

`reply_to` is a plain reference, so a reply is an ordinary message. The composer
shows what is being replied to, and the bubble renders the quoted original above
its own text.

Deleting the original leaves the reply in place with `reply_to` null.

There is no thread view — replies are inline, in the single chronological
conversation.

---

## 6. Editing

`src/lib/messages.js`, shared by the messenger and the dashboard **because the
order matters and is easy to get wrong**:

```js
const saved = await api(`/api/user_messages/${message.id}`, {
  method: 'PUT', body: { value: value.trim() || ' ', files: after },
});
const dropped = before.filter((id) => !after.includes(id));
await Promise.all(dropped.map((id) => api(`/api/files/${id}`, { method: 'DELETE' }).catch(() => {})));
```

The message is updated **first**; only then are the files it no longer carries
deleted. The other way round, an update that failed would leave the message
pointing at bytes that no longer exist.

Attachments can be added and removed during an edit, and abandoning the edit
takes anything uploaded during it with it — see
[Files in messages §5](attachments.md#5-four-ways-an-attachment-stops-being-wanted).

### "Edited" is derived, not stored

```js
export function isEdited(message) {
  if (!message?.updated_at || !message?.created_at) return false;
  return Date.parse(message.updated_at) - Date.parse(message.created_at) > 1000;
}
```

A second's tolerance: the two timestamps are written by the same statement and
can differ by a hair without anybody having edited anything.

The server tracks no edit history and stores no original.

---

## 7. Deleting

`DELETE /api/user_messages/:id`, `delete:own`. The row goes, the link rows
cascade, and `afterDelete` deletes any attachment no other message still carries
— see [Files in messages §5d](attachments.md#5-four-ways-an-attachment-stops-being-wanted).

Deletion is hard. There is no tombstone and no "message deleted" placeholder; the
socket sends `message-deleted` and the client removes it from the list.

---

## 8. Live delivery

All three of `created`, `updated` and `deleted` travel the same path and by the
same permissions:

> A correction should reach the people who read the mistake, and a message taken
> back should stop being on their screen. What neither must do is make a
> conversation unread again.

| Event | Frame | Touches unread? |
| :--- | :--- | :---: |
| `created` | `message` | yes, **unless you wrote it** |
| `updated` | `message` (same frame) | no |
| `deleted` | `message-deleted` `{ id, group }` | yes — what was unread may have stopped existing |

Delivery follows **membership**, not the read permission: an administrator
holding `user_messages:read` unscoped is not pushed conversations they are not
in, because the socket serves the messenger rather than the dashboard. The check
is evaluated per socket with the user **read fresh from the database**, so a
group somebody was dropped from takes effect on the next message rather than
lingering for as long as the tab stays open. Full detail:
[WebSockets §4](websocket.md#4-fan-out).

---

## 9. Unread

`server/realtime/unread.js`. "New" is always relative to the reader's own
membership.

```js
const memberships = await models.user_groups.readLinks('members', { target: userId });
const summary = await models.user_messages.countNewer(
  'group',
  memberships.map((m) => ({ id: m.owner, since: m.last_read_at })),
  { notOwnedBy: userId },
);
const previews = await models.user_messages.findByIds(summary.map((s) => s.latest)…, 0);
return { groups, latest, total };
```

**Three reads, none of which grows with the size of a conversation.** The
counting is an aggregate — one row per group — rather than a tally over the
messages themselves.

That matters because this runs *per recipient, per message*. Counting by
reading cost the length of the conversation each time: posting one line into a
1,600-message group with three people listening materialised ~4,800 message
rows. It is now 7, whatever the history.

`latest` is the last thing said in each group — the preview line under its name
in the sidebar. It is here because the page holds only the conversation it has
open, so it has nothing to derive one from for the rest; and it costs nothing,
since these messages are already being read to count them. It rides the same
frame as the counts, so **a preview updates live for the same reasons a badge
does**.

The first read is the interesting one: the membership rows are the groups this
user is in **and** how far they have read in each, because both are the same
fact about the same pair. It is read by the target key — the side
`idx_user_group_users_user_id` exists for.

Three rules, each stated in the code:

- **Your own messages are never news.**
- **A group you are not in does not count** — an administrator reading every
  group is not thereby behind on every conversation. Hence `{ member: userId }`
  rather than an unscoped read.
- **Never having looked at a group means everything in it is unread:**

  ```js
  const since = readAt.get(message.group);
  if (since !== undefined && Date.parse(message.created_at) <= since) continue;
  ```

  The `!== undefined` guard is what makes a missing marker mean "all of it".

`depth: 0` throughout — relations come back as empty arrays. This runs on every
inbound message for every connected socket, and hydrating what it will not read
would be the expensive part.

### Marking read

`last_read_at` on `user_group_users` — the membership row itself carries the
moment that person last looked at that group. Keeping it on the server rather
than in the browser is what makes it survive signing out and back in, or moving
to another machine; keeping it on the *membership* is what makes it impossible
to have two of, and what makes leaving take it away. See
[Models §4](models.md#4-relations).

```js
return models.user_groups.writeLink('members', id, userId, { last_read_at: at });
```

One write, and **the membership check falls out of it**: the row being updated
*is* the membership, so there is nothing to update unless they are in the group.
`false` means exactly that. It used to be a membership check, then a `findAll`,
then a `.find()`, then an update-or-create.

The pair is the link table's primary key, so a second marker for the same person
in the same group cannot exist — the old table had no way to declare that
constraint and had to avoid it by hand.

It is written only through the messenger routes, which let a session mark **its
own** reading and nothing else.

### Two ways in

| | |
| :--- | :--- |
| socket frame `{ type: 'read', group }` | while a tab is open |
| `POST /api/messenger/read` | a page that has just loaded, or a socket that is down |

The client clears optimistically, prefers the socket, and falls back to HTTP:

```js
setUnread((prev) => /* subtract locally */);
if (socketRef.current?.send({ type: 'read', group: groupId })) return;
await api('/api/messenger/read', { method: 'POST', body: { group: groupId } });
```

The outline should go the moment the group is opened, not a round trip later.

Marking a group you are not in is reported as a **miss rather than a refusal**,
for the same reason reads of it are.

---

## 10. In the interface

**Edit and delete are drawn where the permission actually reaches.**

```jsx
{scopeReaches(editScope, reach) && …}
{scopeReaches(deleteScope, reach) && …}
```

Two things decide it, and both are needed: the **scope** somebody holds over the
action, and whether that scope **reaches this message**. `reach` is what the
message is to its reader — `{ own, member }`.

| Held | Edit appears on |
| :--- | :--- |
| `user_messages:update` | every message, anybody's |
| `user_messages:update:own` | their own words, wherever they are looking at them |
| neither | nothing |

**There is no third case.** `user_messages` withholds `:member` from `update`
and `delete` (§2), so those two are grantable at `any` or `own` and at nothing in
between — which is why `reach` is `{ own: mine }` and says nothing about
membership.

That is deliberate rather than incidental. A role edited before the narrowing may
still carry a stale `update:member` row: the client would read it as a granted
scope, and the server refuses it outright, since `scopesFor('update')` no longer
offers it. Claiming membership here would draw a button for exactly that case.

Drawn from `can()` alone it lies: `can()` answers whether a permission is held
at *any* scope, so it is true of the `:own` form every ordinary account carries.
Delete was drawn that way and appeared on everybody's messages while the server
answered `404` on anybody else's. **A control that cannot do what it says is
worse than no control.**

The server was never the problem and this does not replace it — a scoped caller
still gets `404` for a row that is not theirs, which
`test/routes/membership.test.js` asserts. This decides the *offer*. The rule
itself is `scopeReaches` in `src/lib/permissions.js`, unit-tested in
`test/ui/access.test.js`, which also reads the guard back out of the source,
since the suite cannot render a component.

The same function decides whether a group may be deleted from its header, so the
three controls on this screen agree about what a scope means.

**A system notice gets no controls at all.** It is an ordinary row, but it is not
a remark: no bubble, no face, nothing to reply to, edit or delete — so somebody
re-invited to a group cannot edit the "left the group" notice that names them.

**Unread is drawn twice.** The row goes bolder and brighter, and a red circle at
the end of it carries the count:

| | |
| :--- | :--- |
| circle, then pill | `min-width` equal to the height keeps 1–9 round; padding lets `99+` grow sideways rather than clip |
| `--unread: #dc2626` | darker than the `#f87171` used for errors, because white text at 0.7rem needs 4.5:1 and the lighter red only reaches ~4:1. This is ~5.9:1 |
| `tabular-nums` | so the circle does not twitch as a count climbs |
| capped at `99+` | in the text only — the `aria-label` announces the real number |

Two signals rather than one, because they answer different questions from
different distances: the weight is what makes an unread conversation findable
scanning down the list, the number says how much. Colour alone would carry
neither to somebody who cannot see it. The badge animates in once, and not at
all under `prefers-reduced-motion`.

**Emoji-only messages render large.** `emojiOnly(text, max = 3)` in
`src/lib/format.js` counts **graphemes** via `Intl.Segmenter`, so a flag or a
family — several code points that draw as one picture — counts once. Up to three;
a wall of emoji is a wall of text.

**The emoji picker** is `lazy()`-loaded and pinned to Emoji 12.0 (2019):

> Native rendering means an emoji is only as drawable as the reader's font, and a
> font that has never heard of a character draws the empty box instead. 12.0 is
> the last release present in every font still in service.

It inserts **at the caret**, not at the end — somebody who has gone back to fix a
word expects it to land there — using `requestAnimationFrame` so the selection is
set after React has painted the new value.

**The composer grows with its content**, capped by `max-height: 8rem` in CSS;
past that it scrolls rather than pushing the conversation off the screen.

**On mobile** the field takes a line of its own and the three buttons sit below
it, with Send filling the remainder. The reordering is done with CSS `order`
rather than by changing the markup, because the DOM order (attach → emoji → type
→ send) is the correct **tab** order on a desktop keyboard.

---

## 11. What is not implemented

- **No pagination *within* a conversation.** Opening a group fetches all of it.
  The page no longer loads every group's messages — see §4 — but one very long
  conversation is still one request.
- **No full-text search in the UI.** `searchable: ['value']` gives
  `?search=` on the model route (`ILIKE '%term%'`), which the dashboard panel
  uses. `Model#indexes` deliberately does not create a `pg_trgm` index for it —
  that needs an extension the server may not be allowed to create.
- **No typing indicators, read receipts, or reactions.**
- **No delivery guarantee.** Frames posted while the socket is down are dropped;
  recovery is a refetch.
- **No message ordering beyond `id ASC`.**

Related: [User groups](user-groups.md) · [Files in messages](attachments.md) ·
[WebSockets](websocket.md)
