# Files in messages

Up to three attachments per message, 5 MB each. A message may be nothing *but*
attachments.

> The storage layer — providers, object keys, the bucket — is
> [Files and S3](file.md). This document is the attachment lifecycle.

---

## 1. The shape

```js
files: { type: 'manyToMany', target: 'files', through: 'user_message_files' }
```

A many-to-many, not a foreign key, because a file may be carried by more than one
message — a message forwarded, or an edit that moved an attachment.

**Both sides of the link table cascade**, so deleting a message or a file removes
the *link*. Neither removes the other row. That single fact is why the rest of
this document exists.

The `files` model is owned by its uploader (`ownedBy: 'owner'`) and declares
**no `create` action** — only a `create` permission. A row that named its own
`provider_id` without uploading anything would point at somebody else's bytes, so
files come into existence by being uploaded and no other way.

---

## 2. Upload happens before send

`src/pages/MessengerPage.jsx`:

```js
const handleAttach = async (e) => {
  const chosen = [...e.target.files];
  e.target.value = '';                    // so picking the same file twice still fires
  if (attachments.length + chosen.length > MAX_ATTACHMENTS) { … }
  const uploaded = await uploadFiles(chosen);
  setAttachments((prev) => [...prev, ...uploaded]);
};
```

Files upload **as soon as they are chosen**, not when Send is pressed. The wait
belongs where the person is still typing, not after they have pressed Send — and
it means a failure is reported while there is still a draft to attach something
else to.

The consequence is that a file exists, owned and orphaned, from the moment it is
picked. Handling that is §5.

`POST /api/files` returns the created rows, and the composer holds them as
`attachments`. Sending passes only their ids:

```js
await api('/api/user_messages', {
  method: 'POST',
  body: { owner: currentUser.id, group: selectedId,
          value: draft.trim() || ' ',
          files: attachments.map((f) => f.id),
          ...(replyTo ? { reply_to: replyTo.id } : {}) },
});
```

`value` falls back to a single space because the model requires it. A message may
be nothing but attachments, but the column is `required`.

---

## 3. You may only attach your own files

`assertLinksInScope` in `routes/crud.js`:

```js
const rows = await target.findByIds(wanted, 0);
const mine = rows.filter((row) => target.model.ownedByUser(row, request.user.id));
if (mine.length !== wanted.length) throw /* 403 */;
```

Without this check, `files: [7]` is a way to **publish somebody else's upload to
a group — and to read it**, since being able to see the message is the whole
permission that governs reading its attachments.

It applies to any `manyToMany` whose target has an owner, and only to a scoped
caller: an unscoped one is trusted with the model entire, here as everywhere
else.

---

## 4. Reading one

`GET /api/files/:id/content`. Four ways to be allowed:

| | |
| :--- | :--- |
| `files:read` unscoped | an administrator, as in the dashboard |
| you uploaded it | `file.owner === user.id` |
| it is somebody's picture | drawn beside their name everywhere; not private |
| **it is on a message you may read** | the interesting one |

```js
const messages = await fastify.models.user_messages.findAll({ member: user.id });
return messages.some((message) => (message.files || []).some((f) => f.id === file.id));
```

A recipient does **not own** the file they were sent, so *"may I read this?"* is
not the model's own permission but a question about the message it is attached
to. That is why the download lives in its own route rather than falling out of
`crud.js` like everything else.

`files:read:own` — which the `user` role holds — is not what grants this. It
grants the list of your own uploads.

Failure is reported as **404, not 403**, so the response says nothing about what
exists outside the caller's reach.

**Attachments are always read through the server, never from the bucket.** The
reasoning — a signed URL outlives the membership that justified it — is
[Files and S3 §6](file.md#6-reading-a-file--through-the-server-never-a-signed-url).
It is the reason leaving a group ends access to what was said in it.

---

## 5. Four ways an attachment stops being wanted

This is where most of the design lives. Each path is handled differently, and
deliberately.

### a. Un-attached from a draft

```js
const handleUnattach = async (file) => {
  setAttachments((prev) => prev.filter((row) => row.id !== file.id));
  const wasAlreadyOnTheMessage = (editing?.files || []).some((row) => row.id === file.id);
  if (wasAlreadyOnTheMessage) return;
  await api(`/api/files/${file.id}`, { method: 'DELETE' }).catch(() => {});
};
```

On a draft the file was uploaded for this message and nothing else, so it goes
now.

**While editing it does not**, because it is still on the message until the edit
is saved. Deleting it here would destroy it even if the edit were then abandoned.

### b. An edit that abandons uploads

```js
const cancelEdit = () => {
  const original = new Set((editing?.files || []).map((f) => f.id));
  const added = attachments.filter((file) => !original.has(file.id));
  …
  discardUploads(added);
};
```

Anything uploaded *during* the edit goes with the cancellation; anything that was
already on the message stays.

### c. An edit that saves, dropping files

`src/lib/messages.js` — shared by the messenger and the dashboard **because the
order matters and is easy to get wrong**:

```js
const saved = await api(`/api/user_messages/${message.id}`, {
  method: 'PUT', body: { value: value.trim() || ' ', files: after },
});
const dropped = before.filter((id) => !after.includes(id));
await Promise.all(dropped.map((id) => api(`/api/files/${id}`, { method: 'DELETE' }).catch(() => {})));
```

**The message is updated first, and only then are the dropped files deleted.**
The other way round, an update that failed would leave the message pointing at
bytes that no longer exist.

A file that cannot be deleted is left alone rather than reported. It is attached
to nothing now, which is exactly what the sweep collects — and a reader
correcting a typo should not be shown a bucket error.

### d. The message itself is deleted

`user_messages.afterDelete`:

```js
const stillAttached = new Set(await getRepo('user_messages')
  .linkedTargets('files', attachments.map((f) => f.id)));

for (const attachment of attachments) {
  if (stillAttached.has(attachment.id)) continue;
  await files.remove(attachment.id);
}
```

Three things make this work:

**A failure here is swallowed**, unlike a direct delete: this runs after the
message row has already gone, so throwing would report a delete that happened as
one that did not. The file row is left attached to nothing, which is exactly
what the sweep collects.

**The link table has already cascaded** by the time this runs, so the deleted
message no longer points at anything. That is exactly what makes the question
answerable: a file still referenced by some *other* message is somebody else's
and stays.

**It asks the link table, not the messages.** `linkedTargets` is an indexed read
of three ids; reading every message and hydrating each would be a whole-table
scan — on the ordinary path of somebody deleting one message of their own.

**It deletes through the repository**, which is what runs the `files` model's own
`afterDelete` and so what deletes the bytes.

No database can express *"cascade the link, and the file too, if that was the
last one"* — an attachment is a many-to-many. This is that rule, written out.

---

## 6. The sweep is the backstop

Every 15 minutes, any file attached to nothing and older than
`FILE_SWEEP_GRACE_SECONDS` (default 1 hour) is collected. Details in
[Files and S3 §7](file.md#7-the-sweep).

The grace period exists for exactly the case §2 creates: a file uploaded into a
**half-written message** must never be taken out from under its author.

So there are two mechanisms, and both are needed:

| | Handles | Latency |
| :--- | :--- | :--- |
| `afterDelete` | a file whose last message was deleted | immediate |
| the sweep | a file that was never attached at all — a tab closed mid-draft, a failed send, a delete that could not reach the bucket | up to ~1 h 15 m |

---

## 7. Limits

| Limit | Default | Enforced |
| :--- | :--- | :--- |
| size | 5 MB | `@fastify/multipart` **and** the route |
| count | 3 per message | parser, route, **and** the composer |
| extensions | none | `FILE_ALLOWED_EXTENSIONS`, empty means anything |
| rate | 30 per 300 s per session | `upload` policy |

The parser's own errors carry a status but a message written for whoever
configured it, so the route matches on **code** and rewords:

```js
if (err.code === 'FST_FILES_LIMIT')        throw httpError(400, tooMany);
if (err.code === 'FST_REQ_FILE_TOO_LARGE') throw httpError(413, tooBig);
```

*"Please check multipart config"* is advice for the developer, not for somebody
trying to send a photograph.

`part.toBuffer()` throws once the part exceeds the parser's `fileSize` limit, so
an oversized upload is **refused rather than read to the end and then measured**.

### A failed row deletes its bytes

```js
try { stored.push(await files.create({ … })); }
catch (err) { await fastify.files.remove(providerId).catch(() => {}); throw err; }
```

An upload that stores bytes but fails to write its row cleans up on the way out.
The alternative is paying to keep something nothing points at.

The owner is the **session and never the body** — the same rule `crud.js` applies
to a scoped create.

---

## 8. In the interface

`src/components/Attachments.jsx` renders two things:

- **`AttachmentDrafts`** — chips above the composer, with a remove button and a
  pending state while uploading.
- **`Attachments`** — the list on a sent message. Every link points at
  `/api/files/:id/content`, **never at the bucket**, because who may read an
  attachment is decided by the group it was sent to.

**An image attachment draws itself.** Where another file gets a glyph for its
type, an image gets the picture — an `<img>` pointed at the same
`/api/files/:id/content` everything else uses. Two headers on that route look
like they would stop it and do not: `Content-Disposition: attachment` governs
what a *click* does and is ignored by an image element, and `no-store` means
refetch rather than refuse.

Which files count is read back off the icon map — the extensions mapped to the
`image` glyph — so there is no second list to drift. It keys off `extension`,
not `mime_type`: the extension is sanitised by the server (`extensionOf`),
while the MIME type is whatever the browser claimed and is
`application/octet-stream` often enough to matter.

**It falls back on error**, and that is what makes trusting a filename safe:
`notes.png` may be anything at all, and a row can outlive its object. Either
arrives as the same failure, and the glyph comes back.

Long filenames ellipsise (`text-overflow: ellipsis` on `.attachment-name`, with
`min-width: 0` so the flex child can actually shrink).

Send is disabled while `uploading` is true, so a message cannot be sent
half-attached.

---

## 9. What is not implemented

- **No server-side thumbnailing.** An image attachment draws itself (§8), but
  the browser fetches the **full file** to do it — up to 5 MB for a mark 36 px
  across. `loading="lazy"` keeps that to what is on screen; `no-store` means it
  is refetched on the next visit. Resizing on upload, or a `?size=` on the
  download route, is what would fix it properly.
- **No virus scanning**, and no MIME sniffing. `mime_type` is whatever the
  browser claimed. `FILE_ALLOWED_EXTENSIONS` is an extension allowlist, not a
  content check.
- **No resumable or chunked upload.** A 5 MB ceiling makes it unnecessary.
- **No de-duplication.** The same file sent twice is two objects.
- **No download counting or audit trail.**

Related: [Files and S3](file.md) · [Messages](messages.md) ·
[Users, roles and permissions](permissions.md)
