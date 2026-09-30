import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

// Single-tenant: one process, one SQLite file, the same image wherever an instance is
// hosted. Standalone mode so the container needs nothing but node.
export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone',
    // The CSV upload routes refuse anything over 32 MB, but only once the body has been
    // buffered. This is the ceiling that stops it being buffered at all.
    bodySizeLimit: 48 * 1024 * 1024,
  }),
  security: {
    /**
     * The cross-origin check moves to src/middleware.ts. Not because the built-in one is
     * wrong — it is strict in exactly the right way, and ours copies its rules — but because
     * it compares against the framework's own idea of the request URL, which is
     * `http://localhost:4321` behind a TLS-terminating reverse proxy. It can be taught the
     * real hostname, but only through build-time configuration, and this project ships one
     * image to many hosts. Doing the check ourselves makes the public origin a runtime
     * setting (`APP_URL`), which is where a fact about the deployment belongs.
     *
     * Turning this off without reading src/middleware.ts would leave the application with no
     * CSRF protection at all.
     */
    checkOrigin: false,
  },
  server: { port: Number(process.env.PORT ?? 4321), host: true },
  vite: { plugins: [tailwindcss()] },
});
