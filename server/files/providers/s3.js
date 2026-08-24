import { Readable } from 'node:stream';

import { AwsClient } from 'aws4fetch';

/**
 * Any S3-compatible bucket: Neon Object Storage, Cloudflare R2, Backblaze B2,
 * MinIO, or AWS itself. Three requests — PUT, GET, DELETE — signed with SigV4.
 *
 * There is no SDK here on purpose. `@aws-sdk/client-s3` is several megabytes
 * and a large dependency tree for three verbs; `aws4fetch` is the signature
 * and nothing else, and Node's own `fetch` does the rest.
 *
 * Two things about talking to a non-AWS service that fail confusingly if got
 * wrong, so both are explicit rather than inferred:
 *
 *   addressing  <endpoint>/<bucket>/<key> (path style, the default here) or
 *               <bucket>.<endpoint>/<key>. Most non-AWS services want the
 *               former; AWS itself prefers the latter.
 *   region      SigV4 signs the region string even when the endpoint already
 *               implies it, so a wrong one is a signature mismatch rather
 *               than a redirect.
 */
export function createS3FileProvider(settings) {
  const { endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle } = settings;

  // Named as the environment variables rather than as the fields, because the
  // person reading this message is looking at a .env file.
  const required = {
    AWS_ENDPOINT_URL_S3: endpoint,
    S3_BUCKET: bucket,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
  };
  const missing = Object.keys(required).filter((name) => !required[name]);
  if (missing.length > 0) {
    throw new Error(`S3 file storage needs ${missing.join(', ')}.`);
  }

  const client = new AwsClient({ accessKeyId, secretAccessKey, region, service: 's3' });
  const base = endpoint.replace(/\/+$/, '');

  /**
   * The same fetch, with a deadline.
   *
   * `fetch` has no timeout of its own. An endpoint that refuses the connection
   * fails immediately, which is fine; one that accepts it and then says nothing
   * — a firewall dropping packets, a bucket behind a load balancer with no
   * healthy members — leaves the request open for as long as the operating
   * system will hold it. At boot that hangs the process past Fastify's plugin
   * timeout, and on an upload it hangs the person who sent the photograph.
   *
   * A signal turns both into an ordinary error, which is a 500 the client can
   * read and a line in the log rather than a socket nobody closes.
   */
  const send = (url, options = {}) => client.fetch(url, {
    ...options,
    signal: AbortSignal.timeout(settings.timeoutMs),
  });

  /** Every path segment encoded, the separators left alone. */
  const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');

  // An empty key addresses the bucket itself, which is what check() needs.
  const urlFor = (objectBucket, key) => {
    if (forcePathStyle) return `${base}/${objectBucket}/${encodeKey(key)}`;
    const { protocol, host } = new URL(base);
    return `${protocol}//${objectBucket}.${host}/${encodeKey(key)}`;
  };

  /** `<bucket>/<key>` — the bucket travels with the row, see docs/file.md §2. */
  const parse = (providerId) => {
    const separator = String(providerId).indexOf('/');
    if (separator < 1) throw new Error(`Malformed object reference: ${providerId}`);
    return {
      bucket: providerId.slice(0, separator),
      key: providerId.slice(separator + 1),
    };
  };

  const failed = async (response, what) => {
    // S3 errors are XML; the first line of it is far more use in a log than
    // the status alone, and none of it reaches the client.
    const detail = await response.text().catch(() => '');
    return new Error(`S3 ${what} failed (${response.status}): ${detail.slice(0, 200)}`);
  };

  return {
    name: 's3',

    /**
     * Is the bucket there, and are these credentials allowed into it?
     *
     * HeadBucket, which is the cheapest question S3 answers: no body, no
     * listing, one round trip. Called once at startup so a misconfigured
     * bucket is found then rather than by the first person to send a
     * photograph.
     */
    async check() {
      const response = await send(urlFor(bucket, ''), { method: 'HEAD' });

      if (!response.ok) {
        // HEAD has no body to quote, so the status is the whole story: 403 is
        // credentials, 404 is a bucket that is not there under that name.
        throw new Error(
          `bucket "${bucket}" answered ${response.status}`
          + `${response.status === 403 ? ' (credentials rejected)' : ''}`
          + `${response.status === 404 ? ' (no such bucket)' : ''}`
        );
      }
      return true;
    },

    async put(buffer, { key, mime = 'application/octet-stream' } = {}) {
      const response = await send(urlFor(bucket, key), {
        method: 'PUT',
        body: buffer,
        headers: { 'content-type': mime, 'content-length': String(buffer.length) },
      });

      if (!response.ok) throw await failed(response, 'upload');
      return { providerId: `${bucket}/${key}`, size: buffer.length };
    },

    async get(providerId, { range } = {}) {
      const { bucket: objectBucket, key } = parse(providerId);

      const response = await send(urlFor(objectBucket, key), {
        method: 'GET',
        headers: range ? { range } : {},
      });

      // A missing object is a miss, not a crash: rows can outlive their bytes
      // if a bucket is restored from behind the database.
      if (response.status === 404) return null;
      if (!response.ok && response.status !== 206) throw await failed(response, 'download');

      const headers = {};
      for (const header of ['accept-ranges', 'content-range', 'etag', 'last-modified']) {
        const value = response.headers.get(header);
        if (value) headers[header] = value;
      }

      return {
        status: response.status,
        // A Node stream, as the local provider hands back, so the route that
        // pipes it does not have to know where it came from.
        body: Readable.fromWeb(response.body),
        size: Number(response.headers.get('content-length')) || null,
        mime: response.headers.get('content-type') || 'application/octet-stream',
        headers,
      };
    },

    async remove(providerId) {
      const { bucket: objectBucket, key } = parse(providerId);

      const response = await send(urlFor(objectBucket, key), { method: 'DELETE' });
      // 204 is the success; 404 means somebody got there first, which is the
      // outcome asked for either way.
      if (!response.ok && response.status !== 404) throw await failed(response, 'delete');
      return true;
    },
  };
}
