import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // src/ is the Vite root: it holds index.html and everything the entry
  // imports. This keeps index.html out of the project root, and Vite requires
  // the entry and its sources to live under the same root (the dev server
  // cannot resolve modules above it).
  root: 'src',

  // Paths below are relative to `root`.
  publicDir: '../public', // copied verbatim — /icon.svg keeps a stable URL

  // envDir defaults to `root`, which would have Vite reading src/.env while the
  // server reads the one in the project root. Pointed back out so a single .env
  // configures both halves, and VITE_-prefixed keys reach the client from it.
  envDir: '..',
  // Lightning CSS, for one feature: `@custom-media`. It lets the mobile
  // breakpoint be declared once by name in index.css and referenced as
  // `@media (--mobile)` everywhere else, instead of the same literal width
  // repeated at every block that switches on it.
  //
  // Vite 8 already minifies with Lightning CSS; naming it here is what turns
  // on the draft syntax and applies it to the dev server too, so `--mobile`
  // resolves under `npm run dev` and not only in a build.
  //
  // `targets` is NOT optional, and its absence fails quietly: Lightning CSS
  // inlines `@custom-media` only when the targets say the syntax has to be
  // compiled away. Without it the at-rule is passed through verbatim, no
  // browser understands it, and every `@media (--mobile)` block silently
  // stops applying. The values are Lightning CSS's packed encoding,
  // (major << 16) | (minor << 8) | patch — so Safari 15.4 is the floor.
  //
  // Naming a transformer here replaces PostCSS rather than joining it. There
  // is no PostCSS config in this project, so nothing is lost today; a future
  // PostCSS plugin would mean giving this up.
  css: {
    transformer: 'lightningcss',
    lightningcss: {
      drafts: { customMedia: true },
      targets: { chrome: 100 << 16, firefox: 100 << 16, safari: (15 << 16) | (4 << 8) },
    },
  },

  build: {
    // Match the transformer above; the default minifier would otherwise be
    // esbuild, and the two disagree about what they can parse.
    cssMinify: 'lightningcss',
    outDir: '../dist', // the only directory the Fastify server will serve
    emptyOutDir: true,
  },

  server: {
    // `npm run dev` serves the UI with hot reload on :5173 but has no backend.
    // Forwarding the API paths to the Fastify server means the dev page behaves
    // as if it were same-origin, so the session cookie is sent and received
    // normally — and frontend edits need no rebuild and no server restart.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/liveness': { target: 'http://localhost:3000', changeOrigin: false },
      '/healthz': { target: 'http://localhost:3000', changeOrigin: false },
      '/readyz': { target: 'http://localhost:3000', changeOrigin: false },

      // The socket, and `ws: true` is the whole of it: without that flag Vite
      // proxies the HTTP request and drops the upgrade, so the connection fails
      // rather than becoming a WebSocket. The client builds its URL from
      // window.location (src/lib/socket.js), which in dev is :5173 — so nothing
      // live works here at all unless this is forwarded: no arriving messages,
      // no presence, no unread counts, no calls.
      '/ws': { target: 'ws://localhost:3000', ws: true, changeOrigin: false },
    },
  },

  preview: {
    host: '0.0.0.0',
    port: process.env.PORT ? parseInt(process.env.PORT) : 4173,
    allowedHosts: true,
  },
})
