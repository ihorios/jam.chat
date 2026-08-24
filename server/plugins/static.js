import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config/env.js';

/**
 * Serves the built frontend and falls back to index.html so client-side routes
 * (react-router) resolve on a hard refresh.
 *
 * Only config.staticDir is ever exposed. There is deliberately no fallback to
 * the project root: that would publish .env, package.json and the whole server
 * source over HTTP.
 */
async function staticPlugin(fastify) {
  const staticDir = config.staticDir;
  const indexFile = path.join(staticDir, 'index.html');
  const isBuilt = fs.existsSync(indexFile);

  if (isBuilt) {
    console.log(`✅ Serving static files from ${staticDir}.`);
    await fastify.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      wildcard: false,
      // @fastify/static v10 hands this a FastifyReply, not a raw response.
      setHeaders(reply, filePath) {
        // Asset filenames carry a content hash, so a given URL never changes
        // meaning and can be cached indefinitely.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
          return;
        }
        // index.html is the thing that names those hashes. A stale copy points
        // at files the newest build has already deleted, so it must be
        // revalidated on every load.
        if (path.basename(filePath) === 'index.html') {
          reply.header('Cache-Control', 'no-cache');
        }
      },
    });
  } else {
    console.warn(
      `⚠️ No frontend build at ${staticDir}. API routes still work; `
      + 'run `npm run build` to serve the UI.'
    );
  }

  fastify.setNotFoundHandler((request, reply) => {
    // Unknown API routes are a real 404 — only the SPA gets index.html.
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ ok: false, error: 'Route not found' });
    }

    // Neither does anything that names a file. Handing index.html to a request
    // for a missing .js returns HTML labelled text/html, which the browser
    // refuses to execute as a module — the page then renders blank with no
    // useful error. A real 404 says what actually went wrong.
    const pathname = request.url.split('?')[0];
    if (/\.[a-zA-Z0-9]+$/.test(pathname)) {
      return reply.status(404).send({ ok: false, error: `Not found: ${pathname}` });
    }

    if (!isBuilt) {
      return reply.status(503).send({
        ok: false,
        error: 'Frontend has not been built. Run `npm run build`.',
      });
    }
    return reply.sendFile('index.html');
  });
}

// fp() is required here: setNotFoundHandler and @fastify/static's `sendFile`
// decorator would otherwise apply only inside this plugin's scope.
export default fp(staticPlugin, { name: 'static' });
