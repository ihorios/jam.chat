# Files and S3

Where uploaded bytes live, how they are addressed, and why they are read back
through this server rather than from the bucket.

> Attachments as a *feature* — sending them, editing them, deleting them — are in
> [Files in messages](attachments.md). This document is the storage layer.

---

## 1. The provider interface

`server/files/index.js`. Three methods, all async, addressing objects by one
opaque string:

```
put(buffer, { key, mime })   -> { providerId, size }
get(providerId, { range })   -> null | { status, body, size, mime, headers }
remove(providerId)           -> true
```

Plus `check()`, called once at boot to prove the storage is reachable.

`body` is a **Node stream** from both providers, so the route that pipes it does
not have to know where it came from. `get` returning `null` is a miss, not an
error: a row can outlive its bytes if a bucket is restored from behind the
database.

Which implementation runs is decided in this module rather than by callers — the
same arrangement as `createRealtimeStore()` and `createRateLimiter()`. Swapping
Neon for R2 is one function and four environment variables; running with no
bucket at all is none of them.

**Bytes are never in Postgres.** The `files` table holds a name, a size, a MIME
type, and where the bytes went.

---

## 2. The object reference

`files.provider_id` is the provider's own reference, and **only the provider that
wrote it knows what it means**. `files.provider_name` says which one that was.
Both are `immutable` on the model, because rewriting either would silently orphan
whatever they point at.

| Provider | `provider_id` |
| :--- | :--- |
| `local` | just the key — there is only ever one disk |
| `s3` | **`<bucket>/<key>`** |

### Why the bucket travels with the row

Storing the bucket rather than assuming the configured one is what keeps old rows
resolvable **after the configuration changes**. Move to a new bucket, and every
file uploaded before the move still has a complete address; without it, every old
row would silently resolve against the new bucket and 404.

This is what `providerFor(name)` is built on:

```js
export function providerFor(name) {
  const current = fileProvider();
  if (!name || name === current.name) return current;
  if (name === 'local') return createLocalFileProvider(config.fileDir);
  if (name === 's3' && missingS3Settings().length === 0) return createS3FileProvider(config.s3);
  return null;
}
```

A row written before storage was reconfigured can only be read — or deleted — by
the provider that wrote it. Both are cheap to construct, so the honest thing is
to go and get the right one rather than refuse and leave the bytes behind.

`null` means that provider cannot be built here at all: a row stored in a bucket
this process has no credentials for. Both callers handle it — the download logs
a warning and returns 404, and `removeObject` refuses the delete rather than
pretending it happened.

---

## 3. The object key

```js
export function objectKey(filename) {
  return `${MESSAGE_FILES_PREFIX}/${year}/${month}/${randomUUID()}${extensionOf(filename)}`;
}
```

Example: `message_files/2026/08/3f9c…-a1b2.pdf`

**Never built from the client's filename.** That string is attacker-controlled
and full of slashes, unicode and duplicates. The name a person sees lives in
`files.name`, where it is data rather than a path.

The extension is kept only so a human browsing the bucket can guess what they are
looking at, and it is sanitised hard:

```js
export function extensionOf(filename) {
  const raw = path.extname(String(filename || '')).slice(1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(raw) ? `.${raw}` : '';
}
```

Lower-cased, length-capped, word characters only, or nothing at all.

Everything lives under one prefix (`message_files`) so a bucket shared with
anything else stays legible — and so *"delete every attachment"* is one prefix
rather than a guess about which keys are ours.

---

## 4. Choosing a provider at boot

```js
function configured() {
  if (config.fileProvider) return config.fileProvider;      // FILE_PROVIDER forces it
  return config.s3.endpoint && config.s3.bucket && config.s3.accessKeyId ? 's3' : 'local';
}
```

`connectFileStorage()` then tries the real thing and proves it with one cheap
round trip — deliberately shaped like `db/index.js` `connect()`.

### What happens when S3 is unreachable depends on where you are

```js
if (config.isProduction) {
  throw new Error(`S3 bucket "${bucket}" is unreachable, and falling back to local disk
                   in production would lose every upload: ${err.message}`);
}
console.warn('⚠️ S3 storage unavailable, falling back to local files:', err.message);
```

**In development, fall back to the disk.** A checkout with stale credentials
should still be able to send an attachment to itself, and the files are on a
machine somebody can look at.

**In production, refuse.** The fallback there is a container's disk: every upload
between now and the next deploy would be written somewhere that does not survive
it, no second instance could read any of it, and each one would report success.
An upload that quietly loses the file is worse than an upload that is refused —
the same judgement `db/index.js` makes about a configured, unreachable database.

### Half a bucket is worse than none

```js
export function missingS3Settings() { /* returns the missing variable *names* */ }
```

Named as the environment variables rather than as the config fields, because the
person reading the message is looking at a `.env` file. If some but not all four
are set, the boot warns by name. Silence there is how you find out a week later.

Local storage in production is an **error-level** line, not a warning:

```
❌ Attachments are being written to /app/.files in production.
   They will be lost on the next deploy — set the S3 variables.
```

### The subsystem

`plugins/files.js` records the outcome against the `files` subsystem, which is
**not** in `REQUIRED`. A conversation without attachments is most of the
application, so the boot carries on and only the file routes refuse:

```js
fastify.addHook('onRequest', async (_request, reply) => {
  if (fastify.subsystems.ok('files')) return;
  reply.header('Retry-After', '30');
  return reply.status(503).send({ ok: false, error: 'Attachment storage is unavailable…' });
});
```

Listing and reading file *rows* is unaffected — that is the generic CRUD surface,
which only touches the database.

---

## 5. The two providers

### `local`

Objects as files on this machine's disk, rooted at `FILE_DIR` (default
`<root>/.files`). Never inside `dist/` or the project root proper: nothing there
is served as a static file, and the only way to read one is through the download
route and its membership check.

`pathFor` refuses any key that climbs out of the root:

```js
if (resolved !== root && !resolved.startsWith(root + path.sep)) {
  throw new Error(`Object key escapes the storage directory: ${key}`);
}
```

Keys are generated by this server and never by a client, so this is
belt-and-braces rather than the only thing standing in the way.

Supports single-byte ranges, including the suffix form — `bytes=-500` means *the
last 500 bytes*, not "everything up to 500". `remove` treats `ENOENT` as success,
because already gone is the outcome asked for.

This is what the **tests** run against, which is the point: nothing in the suite
needs a credential, a network, or a bucket somebody has to remember to empty.

**Not for production behind more than one instance**: two servers would each hold
half the attachments, and a container's disk does not survive a redeploy.

### `s3`

Any S3-compatible bucket — Neon Object Storage, Cloudflare R2, Backblaze B2,
MinIO, or AWS itself. Three requests, signed with SigV4.

**There is no SDK here on purpose.** `@aws-sdk/client-s3` is several megabytes
and a large dependency tree for three verbs; `aws4fetch` is the signature and
nothing else, and Node's own `fetch` does the rest.

Two things about talking to a non-AWS service fail confusingly if got wrong, so
both are explicit rather than inferred:

| | |
| :--- | :--- |
| **addressing** | `<endpoint>/<bucket>/<key>` (path style, the default here) or `<bucket>.<endpoint>/<key>`. Most non-AWS services want the former; AWS itself prefers the latter. `S3_FORCE_PATH_STYLE=false` switches it |
| **region** | SigV4 signs the region string even when the endpoint already implies it, so a wrong one is a *signature mismatch* rather than a redirect |

**Every request carries a timeout:**

```js
const send = (url, options = {}) =>
  client.fetch(url, { ...options, signal: AbortSignal.timeout(settings.timeoutMs) });
```

`fetch` has no timeout of its own. An endpoint that refuses the connection fails
immediately, which is fine; one that accepts it and then says nothing — a
firewall dropping packets, a load balancer with no healthy members — leaves the
request open for as long as the OS will hold it. At boot that hangs the process
past Fastify's plugin timeout; on an upload it hangs the person who sent the
photograph.

`check()` is a **HeadBucket** — the cheapest question S3 answers. Its status is
the whole story, since HEAD has no body: `403` is credentials, `404` is no such
bucket.

S3 errors are XML; the first 200 characters go in the log and **none of it
reaches the client**.

---

## 6. Reading a file — through the server, never a signed URL

This is the most important decision in this document.

```js
fastify.get('/:id/content', { preHandler: fastify.authenticate }, async (request, reply) => {
  const file = await files.findById(request.params.id);
  if (!file || !(await readable(file, request.user))) throw httpError(404, 'File not found');
  const store = providerFor(file.provider_name);
  const object = await store.get(file.provider_id, { range: request.headers.range });
  …
  return object.body;
});
```

**A pre-signed URL would be cheaper, and is deliberately not used.**

A signed URL is a bearer token with a lifetime. Once minted it **outlives the
membership that justified it** and cannot be withdrawn. Someone who leaves a
group — or is removed from one — keeps every URL they were ever handed, for as
long as those URLs are valid. Forwarding one gives a stranger the file. Every
attachment link in the interface would have to be re-minted per render, and would
still leak on a copied link.

Reading through the server means the permission is evaluated **on every single
request**, from current membership. Leaving a group ends access to what was said
in it, immediately, including the files.

The cost is bandwidth: every byte passes through the application. For 5 MB
attachments in a group messenger that is an acceptable trade; for large media it
would not be.

### Readability

```js
const readable = async (file, user) => {
  if (user.permissions.includes('files:read')) return true;    // unscoped: an administrator
  if (Number(file.owner) === Number(user.id)) return true;     // your own upload
  if (await pictureOf(file)) return true;                      // somebody's picture
  const messages = await fastify.models.user_messages.findAll({ member: user.id });
  return messages.some((m) => (m.files || []).some((f) => f.id === file.id));
};
```

Missing rather than forbidden on failure, so the response says nothing about what
exists outside the caller's reach.

A **picture** is not private: it is drawn beside its owner's name in every
conversation they are in, so anybody signed in may read it.

### Headers

| | Picture | Attachment |
| :--- | :--- | :--- |
| `Content-Disposition` | `inline` | `attachment` |
| `Cache-Control` | `private, max-age=300` | `private, no-store` |

An attachment stays `no-store` because **who may read one can change at any
time**. A picture may be held for a few minutes; it is rendered in an `<img>`
wherever the person appears.

The filename is the uploader's text, so it is quoted and stripped of anything
that could break out of the header:

```js
`${isPicture ? 'inline' : 'attachment'}; filename="${String(file.name).replace(/["\\\r\n]/g, '')}"`
```

Range requests pass straight through, so seeking in an audio or video attachment
works on both providers.

---

## 7. The sweep

Deleting a message removes the **links** to its files, not the files — the
cascade in the link table cannot know whether the row on the other side is still
wanted by anyone else.

```js
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const cutoff = Date.now() - config.fileSweepGraceSeconds * 1000;   // default 1 hour
```

Every 15 minutes, anything attached to nothing and older than the grace period is
deleted. The grace period exists so a file uploaded into a **half-written
message** is never taken out from under its author.

```js
const attached = new Set([
  ...messages.flatMap((m) => (m.files || []).map((f) => f.id)),
  ...users.map((u) => u.logo_file).filter(Boolean),
]);
```

The `users` half is easy to forget and load-bearing: a picture is attached to a
*person* rather than to a message, and is exactly as pointed-at for it. Without
it, the sweep would quietly delete everybody's picture an hour after they chose
it.

Three details:

- **Not on boot.** A fresh process has nothing to collect, and a sweep racing the
  first requests is a poor way to start.
- **Not while storage or the database is down.** A sweep that cannot read what is
  attached would be deciding what to delete from an empty answer.
- **Through the repository, not the table**, so the model's `afterDelete` runs
  and the object goes with the row.

`fastify.sweepFiles` is decorated for tests to call directly.

`user_messages.afterDelete` is the faster path for the common case: it asks the
link table which of a deleted message's files are *still* attached to something
else and deletes the rest immediately, so an attachment goes with its message
rather than up to an hour later. The sweep is the backstop for files that were
never attached to anything.

### `removeObject` throws, and the object goes first

```js
async beforeDelete(row) {
  await removeObject(row);   // and if it cannot, nothing is deleted
}
```

**The bytes are removed before the row, and the row only if they went.** A file
row is the only record that its object exists — `provider_name` and
`provider_id` are not derivable from anything else — so the other order lost
objects permanently:

1. the row is deleted,
2. the object delete fails,
3. the failure is swallowed and logged, the request reports success,
4. nothing ever retries, because the sweep only looks at rows that still exist.

The bucket kept bytes that nothing knew about and nothing could find. That is
now a `503` and a delete that did not happen: the row stays, still pointing at
its object, and whoever asked can try again.

The residual risk runs the other way and is the lesser one: if the object goes
and the row delete then fails, a row is left pointing at bytes that are not
there. That is a `404` on one download, and the sweep collects the row once
nothing references it.

**Two callers deliberately swallow it**, because they run *after* something
irreversible and a throw would report a delete that did happen as one that did
not:

| Caller | On failure |
| :--- | :--- |
| `user_messages.afterDelete` | leaves the file row attached to nothing — which is exactly what the sweep collects |
| the sweep itself | logs, counts it, and moves to the next file; it will come back in fifteen minutes |

So a bucket having a bad minute now costs an hour's delay rather than an orphan.

`error.expose = true` is what lets the message through: a 5xx normally returns
"Internal server error", and this one is advice rather than a stack trace. See
[Fastify §6](fastify.md#6-error-handling).

`setFileLog(fastify.log)` exists because the caller that most needs to warn is a
model hook, which the repositories invoke with no logger of their own to lend
it.

---

## 8. Pictures

A picture is a file, but it is not an attachment. `PUT /api/users/:id/picture`
creates a file row **and** points the user at it in one step — two writes that
are no use without each other, which is why it is not one of the generic CRUD
routes.

It is also the only way `users.logo_file` is ever set. The field is `privileged`
precisely so that naming a file id is not something an account can do to itself:
here the id is not given, it is created.

`server/files/picture.js` validates the bytes before storing them:

```js
export const PICTURE_RULES = Object.freeze({
  formats: ['png', 'jpg', 'jpeg'],
  maxBytes: 1024 * 1024,
  minPixels: 64,
  maxPixels: 1024,
  squareTolerance: 0.02,
});
```

Dimensions are read from the file's own header — the PNG `IHDR` chunk, the JPEG
`SOFn` marker — rather than trusted from the client. `squareTolerance` is 2 %
because exactly 1:1 would reject a 512×515 export for no reason a person could
see, while a fifth of a percent per side is invisible and still refuses anything
with a shape.

`users.logo` (a URL) and `users.logo_file` (an upload) are the two ways to have a
picture. `Users.pictureUrl()` prefers the upload, and `transform` exposes the
result as `user.picture` so no client has to know there are two.

---

## 9. Environment variables

Deliberately the **AWS-standard names**, so the AWS CLI, the SDKs and this server
can all be pointed at the same bucket from the same `.env` — which is what makes
the smoke test below prove anything about the app.

| Variable | Default | |
| :--- | :--- | :--- |
| `AWS_ENDPOINT_URL_S3` | — | required for S3 |
| `S3_BUCKET` (or `AWS_S3_BUCKET`) | — | required for S3 |
| `AWS_ACCESS_KEY_ID` | — | required for S3 |
| `AWS_SECRET_ACCESS_KEY` | — | required for S3 |
| `AWS_REGION` | `us-east-1` | signed, so it must be right |
| `S3_FORCE_PATH_STYLE` | `true` | `false` for virtual-host addressing |
| `S3_TIMEOUT_MS` | `20000` | per request |
| `FILE_PROVIDER` | unset | `s3` or `local`, forcing the choice |
| `FILE_DIR` | `<root>/.files` | local provider |
| `FILE_MAX_BYTES` | `5242880` | 5 MB |
| `FILE_MAX_PER_MESSAGE` | `3` | |
| `FILE_SWEEP_GRACE_SECONDS` | `3600` | |
| `FILE_ALLOWED_EXTENSIONS` | empty | empty means anything |

---

## 10. A bucket smoke test

If uploads are failing and you want to know whether it is the app or the bucket,
take the app out of it. With the same `.env` loaded:

```bash
export $(grep -v '^#' .env | xargs)

# 1. Can these credentials see the bucket at all?  (what check() does)
aws s3api head-bucket --bucket "$S3_BUCKET" --endpoint-url "$AWS_ENDPOINT_URL_S3"

# 2. Write, read back, and delete — the three verbs the provider uses.
echo 'jam.chat smoke test' > /tmp/smoke.txt
aws s3 cp /tmp/smoke.txt "s3://$S3_BUCKET/message_files/smoke.txt" --endpoint-url "$AWS_ENDPOINT_URL_S3"
aws s3 cp "s3://$S3_BUCKET/message_files/smoke.txt" - --endpoint-url "$AWS_ENDPOINT_URL_S3"
aws s3 rm "s3://$S3_BUCKET/message_files/smoke.txt" --endpoint-url "$AWS_ENDPOINT_URL_S3"

# 3. What the app has actually written.
aws s3 ls "s3://$S3_BUCKET/message_files/" --recursive --endpoint-url "$AWS_ENDPOINT_URL_S3"
```

Reading the results:

| Symptom | Meaning |
| :--- | :--- |
| step 1 gives `403` | credentials — `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| step 1 gives `404` | no bucket under that name at that endpoint |
| step 1 works, the app says `SignatureDoesNotMatch` | `AWS_REGION` is wrong — SigV4 signs it |
| step 2 works, the app times out | network path from the *server*, not from your machine. Raise `S3_TIMEOUT_MS` to confirm |
| everything works, the app still writes locally | the app chose `local`. Check the boot log and `missingS3Settings()` — one of the four is unset |

The app's own boot log answers most of this in one line:

```
✅ Attachments stored in S3 bucket "my-bucket".
ℹ️ Attachments stored on disk at /app/.files.
⚠️ Object storage is half-configured. Missing: AWS_SECRET_ACCESS_KEY.
```

Related: [Files in messages](attachments.md) · [Models](models.md) ·
[Fastify](fastify.md)
