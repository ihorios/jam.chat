import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { config } from '../config/env.js';
import { createLocalFileProvider } from './providers/local.js';
import { createS3FileProvider } from './providers/s3.js';

/**
 * Where attachment bytes live.
 *
 * The provider interface is three methods, all async, addressing objects by
 * one opaque string:
 *
 *   put(buffer, { key, mime })     -> { providerId, size }
 *   get(providerId, { range })     -> null | { status, body, size, mime, headers }
 *   remove(providerId)             -> true
 *
 * `providerId` is what goes in files.provider_id, and only the provider that
 * wrote it knows what it means. For S3 it is `<bucket>/<key>` — storing the
 * bucket rather than assuming the configured one is what keeps old rows
 * resolvable after the configuration changes; for local storage it is just the
 * key, because there is only ever one disk.
 *
 * Which implementation runs is decided here rather than by the callers, the
 * same arrangement as createRealtimeStore(): swapping Neon for R2 is this
 * function and four environment variables, and running with no bucket at all
 * is none of them.
 */

/** One provider per process; the S3 client and its keys are worth reusing. */
let provider = null;
let usingObjectStorage = false;

/**
 * Where this module's warnings go. Replaced with the Fastify logger at boot —
 * until then, and in scripts, console is better than nothing.
 *
 * It is held here rather than passed in because the caller that most needs to
 * warn is a model's afterDelete, which the repositories invoke with no logger
 * of their own to lend it.
 */
let log = console;

export function setFileLog(logger) {
  log = logger || console;
}

/** Which storage the configuration asks for, before anyone has checked it. */
function configured() {
  if (config.fileProvider) return config.fileProvider;
  // A bucket with credentials means S3; anything less means the disk.
  return config.s3.endpoint && config.s3.bucket && config.s3.accessKeyId ? 's3' : 'local';
}

/**
 * Settles which storage this process will use, and says so.
 *
 * Deliberately shaped like db/index.js connect(): try the real thing and prove
 * it with one cheap round trip. What happens when that fails depends on where
 * this is running, and the difference matters — see the catch below.
 *
 * Either way it does not stop the boot. plugins/files.js records the outcome
 * against the `files` subsystem, which is not in REQUIRED: attachments are a
 * part of the application, not the whole of it.
 */
export async function connectFileStorage() {
  const wanted = configured();

  if (wanted === 's3') {
    try {
      const s3 = createS3FileProvider(config.s3);
      await s3.check();

      provider = s3;
      usingObjectStorage = true;
      console.log(`✅ Attachments stored in S3 bucket "${config.s3.bucket}".`);
      return provider;
    } catch (err) {
      /*
       * Configured for a bucket, and the bucket is not answering.
       *
       * In development, fall back to the disk. A checkout with stale
       * credentials should still be able to send an attachment to itself, and
       * the files are on a machine somebody can look at.
       *
       * In production, refuse. The fallback there is a container's disk: every
       * upload between now and the next deploy would be written somewhere that
       * does not survive it, no second instance could read any of it, and each
       * one would report success. An upload that quietly loses the file is
       * worse than an upload that is refused — the same judgement db/index.js
       * makes about a database that is configured and unreachable.
       */
      if (config.isProduction) {
        throw new Error(
          `S3 bucket "${config.s3.bucket}" is unreachable, and falling back to `
          + `local disk in production would lose every upload: ${err.message}`
        );
      }

      console.warn(
        '⚠️ S3 storage unavailable, falling back to local files:',
        err.message
      );
    }
  } else {
    const missing = missingS3Settings();
    // Half a bucket is worse than none: uploads succeed and the files land on
    // a disk nobody is looking at. Say which setting is missing, by its name.
    if (missing.length > 0 && missing.length < 4) {
      console.warn(`⚠️ Object storage is half-configured. Missing: ${missing.join(', ')}.`);
    }
  }

  provider = createLocalFileProvider(config.fileDir);
  usingObjectStorage = false;

  try {
    await provider.check();

    // Local storage is a development convenience. In production it is a
    // container's disk: every attachment uploaded between now and the next
    // deploy is lost at that deploy, and a second instance would not see any
    // of them. Loud, because the likely cause is a variable missing from the
    // dashboard rather than a decision anybody made.
    if (config.isProduction) {
      console.error(
        `❌ Attachments are being written to ${config.fileDir} in production. `
        + 'They will be lost on the next deploy — set the S3 variables.'
      );
    } else {
      console.log(`ℹ️ Attachments stored on disk at ${config.fileDir}.`);
    }
  } catch (err) {
    // Nothing left to fall back to. Reported as a broken subsystem rather than
    // left to fail one upload at a time: a 503 that names the fault once is
    // easier to act on than a stream of 500s from a directory nobody can write.
    throw new Error(`${config.fileDir} is not writable: ${err.message}`);
  }

  return provider;
}

/**
 * The storage in use. Resolves from configuration if connectFileStorage() has
 * not run — a model tidying up after a delete should not have to care whether
 * the boot sequence reached it yet.
 */
export function fileProvider() {
  if (provider) return provider;

  provider = configured() === 's3'
    ? createS3FileProvider(config.s3)
    : createLocalFileProvider(config.fileDir);

  return provider;
}

/** True when attachments are going to a bucket rather than this machine. */
export function isObjectStorage() {
  return usingObjectStorage;
}

/**
 * The provider that wrote a given row, which is not always the one in use.
 *
 * A `provider_id` means something different to each implementation, so a row
 * written before storage was reconfigured can only be read — or deleted — by
 * the provider that wrote it. Both are cheap to construct, so the honest thing
 * is to go and get the right one rather than refuse and leave the bytes behind.
 *
 * Null when that provider cannot be built here at all: a row stored in a bucket
 * this process has no credentials for.
 */
export function providerFor(name) {
  const current = fileProvider();
  if (!name || name === current.name) return current;

  if (name === 'local') return createLocalFileProvider(config.fileDir);
  if (name === 's3' && missingS3Settings().length === 0) return createS3FileProvider(config.s3);

  return null;
}

/** For tests, which build a fresh app per file and must not share objects. */
export function resetFileProvider() {
  provider = null;
  usingObjectStorage = false;
}

/**
 * The S3 settings that are missing, by the name you would set them under.
 *
 * A half-configured bucket is the one failure worth shouting about: the app
 * starts, uploads succeed, and the files land on a disk nobody is looking at.
 * Silence there is how you find out a week later.
 */
export function missingS3Settings() {
  const required = {
    AWS_ENDPOINT_URL_S3: config.s3.endpoint,
    S3_BUCKET: config.s3.bucket,
    AWS_ACCESS_KEY_ID: config.s3.accessKeyId,
    AWS_SECRET_ACCESS_KEY: config.s3.secretAccessKey,
  };
  return Object.keys(required).filter((name) => !required[name]);
}

/**
 * Everything attached to a message lives under one folder, so a bucket shared
 * with anything else stays legible — and so "delete every attachment" is one
 * prefix rather than a guess about which keys are ours.
 */
export const MESSAGE_FILES_PREFIX = 'message_files';

/**
 * The object key for a new upload: the prefix, a dated folder, a random name.
 *
 * Never built from the client's filename. That string is attacker-controlled
 * and full of slashes, unicode and duplicates; the name a person sees lives in
 * files.name, where it is data rather than a path. The extension is kept only
 * so a human browsing the bucket can guess what they are looking at.
 */
export function objectKey(filename) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');

  return `${MESSAGE_FILES_PREFIX}/${year}/${month}/${randomUUID()}${extensionOf(filename)}`;
}

/** '.pdf', or '' — lower-cased, length-capped, and never anything but word characters. */
export function extensionOf(filename) {
  const raw = path.extname(String(filename || '')).slice(1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(raw) ? `.${raw}` : '';
}

/**
 * Deletes the bytes behind a file row, and **throws if it cannot**.
 *
 * The order matters and this is the half that enforces it. A file row is the
 * only record that its object exists — `provider_name` and `provider_id` are
 * not derivable from anything else — so deleting the row first and the object
 * afterwards means a failed delete orphans the bytes permanently: nothing is
 * left to retry from, and the sweep only ever looks at rows that still exist.
 *
 * So the object goes first, from beforeDelete, and a failure here refuses the
 * delete rather than reporting one that half happened. The row stays, still
 * pointing at its object, and whoever asked can try again.
 *
 * It used to swallow everything and log, back when it ran after the row was
 * gone and there was nothing useful left to do about a failure. That was the
 * bug: uploads went on existing in the bucket, billed and unreferenced, and the
 * only sign was a line in a log.
 */
export async function removeObject(row) {
  if (!row?.provider_id) return false;

  const store = providerFor(row.provider_name);
  if (!store) {
    const error = new Error(
      `This server cannot reach the storage "${row.provider_name}" that holds `
      + `"${row.name || row.provider_id}", so it cannot be deleted.`
    );
    error.statusCode = 503;
    // Written for whoever pressed the button; see plugins/error-handler.js.
    error.expose = true;
    throw error;
  }

  try {
    await store.remove(row.provider_id);
    return true;
  } catch (err) {
    log?.error?.(
      { err, file: row.id, object: row.provider_id },
      'Refusing to delete a file row whose object could not be removed'
    );
    const error = new Error(
      `The stored copy of "${row.name || row.provider_id}" could not be deleted, `
      + 'so the file has been left alone. Try again.'
    );
    error.statusCode = 503;
    error.expose = true;
    throw error;
  }
}
