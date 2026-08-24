import { config } from '../config/env.js';
import { getModel } from '../db/models/index.js';
import { objectKey, extensionOf, providerFor } from '../files/index.js';

const filesModel = getModel('files');

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Uploading and downloading. Mounted at /api/files, alongside the generic CRUD
 * routes for the same model — which deliberately do not include a create, so
 * a file can only come into existence by having bytes arrive with it.
 *
 * Reading is the interesting half. A recipient does not own the file they were
 * sent, so "may I read this?" is not the model's own permission but a question
 * about the message it is attached to. That is why the download lives here
 * rather than falling out of crud.js like everything else.
 */
export default async function fileRoutes(fastify) {
  const files = fastify.models.files;

  /*
   * Nothing in here works without somewhere to keep the bytes.
   *
   * Scoped to this plugin rather than folded into the guard in app.js, because
   * attachments are not in REQUIRED: a conversation without them is most of the
   * application, and the rest of the API has no reason to stop. Reading and
   * listing file *rows* is unaffected too — that is the generic CRUD surface,
   * which only touches the database.
   *
   * 503 for the same reason the data-layer guard uses it: the request was fine,
   * the server is not, and Retry-After says the difference is expected to pass.
   */
  fastify.addHook('onRequest', async (_request, reply) => {
    if (fastify.subsystems.ok('files')) return;
    reply.header('Retry-After', '30');
    return reply.status(503).send({
      ok: false,
      error: 'Attachment storage is unavailable, so this request cannot be served.',
    });
  });

  /**
   * Whether this file is somebody's picture — the id of that person, or null.
   *
   * A picture is not private: it is drawn beside its owner's name in every
   * conversation they are in, so anybody signed in may read it. The check sits
   * here so both the readability rule and the headers below share it.
   */
  const pictureOf = async (file) => {
    const owner = await fastify.models.users.findRawBy('logo_file', file.id);
    return owner ? owner.id : null;
  };

  /** Everything the caller may see, by any of the three routes in. */
  const readable = async (file, user) => {
    // An administrator holding the unscoped permission sees every row, exactly
    // as they do in the dashboard.
    if (user.permissions.includes('files:read')) return true;
    if (Number(file.owner) === Number(user.id)) return true;

    // Somebody's picture, which every signed-in caller draws.
    if (await pictureOf(file)) return true;

    // Otherwise: is it attached to something they are entitled to read? Their
    // own messages are the smallest set that could contain it, and it is the
    // same question unreadFor() asks about the same rows.
    const messages = await fastify.models.user_messages.findAll({ member: user.id });
    return messages.some((message) => (message.files || []).some((f) => f.id === file.id));
  };

  /**
   * Uploads, one part at a time.
   *
   * The owner is the session and never the body — the same rule crud.js
   * applies to a scoped create, for the same reason. An upload that stores
   * bytes but fails to write its row deletes them again on the way out; the
   * alternative is paying to keep something nothing points at.
   */
  fastify.post(
    '/',
    {
      // Authorised first, so the count is against a session rather than an
      // address — several people behind one router upload independently.
      preHandler: [fastify.authorize(filesModel, 'create'), fastify.rateLimit('upload')],
    },
    async (request, reply) => {
      const allowed = config.fileAllowedExtensions;
      const stored = [];
      let count = 0;

      // The parser enforces the same two ceilings and throws its own errors on
      // the way past them; caught below and reworded, because "please check
      // multipart config" is advice for whoever wrote this, not whoever is
      // trying to send a photograph.
      const tooMany = `At most ${config.fileMaxPerMessage} files per message`;
      const tooBig = `Each file must be under ${
        Math.round(config.fileMaxBytes / 1024 / 1024)}MB`;

      try {
        for await (const part of request.files()) {
          count += 1;
          if (count > config.fileMaxPerMessage) throw httpError(400, tooMany);

          const extension = extensionOf(part.filename);
          if (allowed.length > 0 && !allowed.includes(extension.slice(1))) {
            throw httpError(415, `Files of type "${extension || '?'}" are not accepted`);
          }

          // toBuffer() throws once the part exceeds the parser's fileSize
          // limit, so an oversized upload is refused rather than read to the
          // end and then measured.
          const buffer = await part.toBuffer();

          const mime = part.mimetype || 'application/octet-stream';
          const { providerId, size } = await fastify.files.put(buffer, {
            key: objectKey(part.filename),
            mime,
          });

          try {
            stored.push(await files.create({
              owner: request.user.id,
              name: String(part.filename || 'file').slice(0, 255),
              mime_type: mime,
              extension: extension.slice(1) || null,
              provider_name: fastify.files.name,
              provider_id: providerId,
              size,
            }));
          } catch (err) {
            await fastify.files.remove(providerId).catch(() => {});
            throw err;
          }
        }
      } catch (err) {
        // The parser's own errors carry a status but a message written for
        // whoever configured it, so they are matched on code first — otherwise
        // a person sending a photograph is told to check the multipart config.
        if (err.code === 'FST_FILES_LIMIT') throw httpError(400, tooMany);
        if (err.code === 'FST_REQ_FILE_TOO_LARGE') throw httpError(413, tooBig);
        throw err;
      }

      if (stored.length === 0) throw httpError(400, 'No files were sent');

      return reply.status(201).send({ ok: true, count: stored.length, files: stored });
    }
  );

  /**
   * The bytes, through this server rather than from the bucket.
   *
   * A signed URL would be cheaper, and is deliberately not used: it outlives
   * the membership that justified it, and cannot be withdrawn when somebody
   * leaves a group. See docs/file.md §6.
   */
  fastify.get(
    '/:id/content',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const file = await files.findById(request.params.id);
      // Reported as missing rather than forbidden, so the response says
      // nothing about what exists outside the caller's reach.
      if (!file || !(await readable(file, request.user))) throw httpError(404, 'File not found');

      // Served by whichever provider wrote it. A file uploaded before storage
      // was reconfigured is still that person's file, and reading it back
      // should not depend on where the *next* upload would go.
      const store = providerFor(file.provider_name);
      if (!store) {
        request.log.warn(
          { file: file.id, storedIn: file.provider_name },
          'Attachment is in storage this process cannot reach'
        );
        throw httpError(404, 'File not found');
      }

      const object = await store.get(file.provider_id, { range: request.headers.range });
      if (!object) throw httpError(404, 'File not found');

      // A picture is rendered in an <img> wherever the person appears, so it is
      // shown rather than downloaded, and may be held for a few minutes. An
      // attachment stays no-store: who may read one can change at any time.
      const isPicture = Boolean(await pictureOf(file));

      reply
        .status(object.status || 200)
        .headers(object.headers || {})
        .header('Content-Type', file.mime_type || object.mime || 'application/octet-stream')
        // Quoted and stripped of anything that could break out of the header;
        // the name is the uploader's text, not ours.
        .header(
          'Content-Disposition',
          `${isPicture ? 'inline' : 'attachment'}; filename="${String(file.name).replace(/["\\\r\n]/g, '')}"`
        )
        .header('Cache-Control', isPicture ? 'private, max-age=300' : 'private, no-store');

      if (object.size !== null && object.size !== undefined) {
        reply.header('Content-Length', String(object.size));
      }

      return object.body;
    }
  );
}
