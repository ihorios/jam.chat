import { getModel } from '../db/models/index.js';
import { objectKey, extensionOf } from '../files/index.js';
import { pictureProblem, PICTURE_RULES } from '../files/picture.js';

const usersModel = getModel('users');

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Somebody's picture: uploading one, and taking it away again.
 *
 * Mounted under /api/users because that is whose picture it is, and kept off
 * the generic CRUD routes because setting it is not writing a field. Two things
 * happen at once — a file row comes into existence holding the bytes, and the
 * user row is pointed at it — and neither is any use without the other.
 *
 * The upload is also the only way `logo_file` is ever set: the field is
 * privileged precisely so that naming a file id is not something an account can
 * do to itself. Here the id is not given, it is created.
 */
export default async function userPictureRoutes(fastify) {
  const users = fastify.models.users;
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
   * Whose picture the caller may change: their own with `users:update:own`,
   * anybody's with the unscoped permission. The same rule crud.js applies to
   * the row itself, since this is a write to that row.
   */
  const target = async (request) => {
    const id = Number.parseInt(request.params.id, 10);
    if (Number.isNaN(id)) throw httpError(404, 'User not found');

    if (request.scope !== 'any' && id !== Number(request.user.id)) {
      // Missing rather than forbidden, exactly as a scoped read of somebody
      // else's row reports it.
      throw httpError(404, 'User not found');
    }

    const user = await users.findById(id);
    if (!user) throw httpError(404, 'User not found');
    return user;
  };

  /** Whatever the picture used to be, once it is no longer wanted. */
  const discard = async (previousFileId) => {
    if (!previousFileId) return;
    // Through the repository, so the file model's afterDelete takes the bytes
    // with the row. A failure here is worth a line in the log and nothing more:
    // the new picture is already in place, and the sweep collects the old file.
    await files.remove(previousFileId).catch(() => {});
  };

  fastify.put(
    '/:id/picture',
    {
      preHandler: [
        fastify.authorize(usersModel, 'update'),
        // Counted per session rather than per address, like every other upload.
        fastify.rateLimit('upload'),
      ],
    },
    async (request, reply) => {
      const user = await target(request);

      const part = await request.file();
      if (!part) throw httpError(400, 'No picture was sent');

      let buffer;
      try {
        buffer = await part.toBuffer();
      } catch (err) {
        // The parser's own ceiling, which is larger than a picture's.
        if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
          throw httpError(413, `A picture has to be under ${
            Math.round(PICTURE_RULES.maxBytes / 1024)}KB.`);
        }
        throw err;
      }

      const problem = pictureProblem(buffer, part.filename);
      if (problem) throw httpError(415, problem);

      const mime = part.mimetype || 'image/png';
      const { providerId, size } = await fastify.files.put(buffer, {
        key: objectKey(part.filename),
        mime,
      });

      let file;
      try {
        file = await files.create({
          // The picture belongs to the person in it, not to whoever uploaded
          // it: an administrator setting somebody's picture should not end up
          // owning a file that is theirs.
          owner: user.id,
          name: String(part.filename || 'picture').slice(0, 255),
          mime_type: mime,
          extension: extensionOf(part.filename).slice(1) || null,
          provider_name: fastify.files.name,
          provider_id: providerId,
          size,
        });
      } catch (err) {
        // Bytes with no row pointing at them are bytes nobody will ever read.
        await fastify.files.remove(providerId).catch(() => {});
        throw err;
      }

      const previous = user.logo_file;
      // `logo` goes with it: a picture that was taken from a Google account is
      // no longer this person's picture once they have chosen one.
      const updated = await users.update(user.id, { logo_file: file.id, logo: null });
      await discard(previous);

      return reply.status(200).send({ ok: true, user: updated });
    }
  );

  /**
   * No picture at all — which clears both an upload and a provider's URL, since
   * "remove my picture" cannot sensibly mean "and leave the other one".
   */
  fastify.delete(
    '/:id/picture',
    { preHandler: fastify.authorize(usersModel, 'update') },
    async (request) => {
      const user = await target(request);

      const updated = await users.update(user.id, { logo_file: null, logo: null });
      await discard(user.logo_file);

      return { ok: true, user: updated };
    }
  );
}
