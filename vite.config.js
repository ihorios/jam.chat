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
  build: {
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
