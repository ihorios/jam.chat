import fp from 'fastify-plugin';
import multipart from '@fastify/multipart';

import { config } from '../config/env.js';
import { connectFileStorage, setFileLog } from '../files/index.js';
import { withDeadline } from '../subsystems.js';

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Attachment plumbing: the multipart parser, the storage provider, and the
 * sweep that keeps the two ends from drifting apart.
 *
 * The sweep exists because deleting a message removes the *links* to its
 * files, not the files — the cascade in the link table cannot know whether the
 * row on the other side is still wanted by anyone else. Rather than guess at
 * delete time, anything left attached to nothing is collected here, after a
 * grace period long enough that a file uploaded into a half-written message is
 * never taken out from under its author.
 */
async function filesPlugin(fastify) {
  await fastify.register(multipart, {
    limits: {
      fileSize: config.fileMaxBytes,
      files: config.fileMaxPerMessage,
      // The parts we read are files; anything else is a client sending things
      // this route has no use for.
      fields: 4,
    },
  });

  // So that a model tidying up after a delete — which the repositories call
  // with no logger of their own — still has somewhere to complain.
  setFileLog(fastify.log);

  /*
   * Settled once, at boot, with a round trip to prove it — so a bucket that
   * cannot be reached is found now rather than by the first upload.
   *
   * Deadlined and caught, for the same reason the database is: this is a
   * network call, and the failure worth guarding against is not an error but a
   * wait. connectFileStorage falls back to the disk on its own and so rarely
   * throws; what it cannot do is return quickly from an endpoint that has
   * accepted the connection and gone quiet.
   *
   * Unlike the database, attachments are not in REQUIRED: a conversation
   * without them is most of the application, so this is recorded and the boot
   * carries on. The file routes are what refuse — see routes/files.js.
   */
  let provider = null;
  try {
    provider = await withDeadline(
      config.fileBootTimeoutMs,
      'Attachment storage start-up',
      () => connectFileStorage()
    );
    fastify.subsystems.up('files');
  } catch (err) {
    fastify.subsystems.down('files', err);
  }

  fastify.decorate('files', provider);

  /**
   * Deletes every file row nothing points at any more. Goes through the
   * repository rather than the database so the model's afterDelete runs and
   * the object goes with the row.
   */
  const sweep = async () => {
    const cutoff = Date.now() - config.fileSweepGraceSeconds * 1000;

    const [files, messages, users] = await Promise.all([
      fastify.models.files.findAll({}, 0),
      fastify.models.user_messages.findAll({}),
      // A picture is attached to a person rather than to a message, and is
      // exactly as pointed-at for it. Without this, the sweep would quietly
      // delete everybody's picture an hour after they chose it.
      fastify.models.users.findAll({}, 0),
    ]);

    const attached = new Set([
      ...messages.flatMap((message) => (message.files || []).map((file) => file.id)),
      ...users.map((user) => user.logo_file).filter(Boolean),
    ]);

    let collected = 0;
    let left = 0;
    for (const file of files) {
      if (attached.has(file.id)) continue;
      if (Date.parse(file.created_at) > cutoff) continue;

      /*
       * One at a time, because deleting a file now refuses when its object
       * cannot be removed. A bucket that is refusing one key — or refusing
       * everything — must not stop the sweep at the first of them: the rest are
       * still collectable, and the ones that are not are still here to be tried
       * again in fifteen minutes. That retry is the whole reason the row is
       * kept rather than deleted regardless.
       */
      try {
        if (await fastify.models.files.remove(file.id)) collected += 1;
      } catch (err) {
        left += 1;
        fastify.log.warn(
          { err, file: file.id },
          'Left an unattached file in place; its object could not be removed'
        );
      }
    }

    if (collected > 0) fastify.log.info({ collected }, 'Swept unattached files');
    if (left > 0) fastify.log.warn({ left }, 'Unattached files the sweep could not remove');
    return collected;
  };

  fastify.decorate('sweepFiles', sweep);

  // Not on boot: a fresh process has nothing to collect, and a sweep racing
  // the first requests is a poor way to start. Nor at all while the storage or
  // the database is down: a sweep that cannot read what is attached would be
  // deciding what to delete from an empty answer.
  const timer = setInterval(
    () => {
      if (!fastify.subsystems.ok('files') || !fastify.subsystems.ok('database')) return;
      sweep().catch((err) => fastify.log.warn({ err }, 'File sweep failed'));
    },
    SWEEP_INTERVAL_MS
  );
  timer.unref?.();

  fastify.addHook('onClose', async () => clearInterval(timer));

  // Only when there is something to be ready. The failure has already been
  // said once, by subsystems.down(), and saying "ready" underneath it would be
  // the boot log contradicting itself.
  if (provider) {
    console.log(
      `✅ Attachments ready (${provider.name} storage), `
      + `${Math.round(config.fileMaxBytes / 1024 / 1024)}MB x ${config.fileMaxPerMessage} per message.`
    );
  }
}

export default fp(filesPlugin, { name: 'files', dependencies: ['db', 'subsystems'] });
