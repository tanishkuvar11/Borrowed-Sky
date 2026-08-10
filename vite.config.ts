import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Runs the files in /api as a dev-time API, so `npm run dev` behaves like the
 * deployed serverless environment. Each handler is loaded through Vite's SSR
 * pipeline, meaning edits hot-reload the same way the client does.
 */
function devApiRoutes(): Plugin {
  return {
    name: 'borrowed-sky:dev-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        if (!url.startsWith('/api/')) return next();

        const route = url.split('?')[0].slice('/api/'.length).replace(/\/+$/, '');
        if (!/^[a-z0-9-]+$/i.test(route)) return next();

        void (async () => {
          try {
            const mod = await server.ssrLoadModule(`/api/${route}.ts`);
            const handler = (mod as { default?: unknown }).default;
            if (typeof handler !== 'function') return next();
            await handler(req, res);
          } catch (err) {
            server.config.logger.error(`[dev-api] /api/${route} failed: ${String(err)}`);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                error: 'dev_handler_failed',
                message: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        })();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Surface .env values to the dev API handlers, which read process.env just as
  // they do on the deployed host. Nothing here is exposed to the client bundle.
  const env = loadEnv(mode, process.cwd(), '');
  for (const key of ['WATSONX_API_KEY', 'WATSONX_PROJECT_ID', 'WATSONX_URL', 'WATSONX_MODEL_ID']) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }

  return {
    plugins: [react(), devApiRoutes()],
    server: {
      host: true, // so a phone on the same network can open it — the whole point
      port: 5173,
    },
    build: {
      target: 'es2022',
      rollupOptions: {
        output: {
          manualChunks: {
            astronomy: ['astronomy-engine'],
            satellites: ['satellite.js'],
          },
        },
      },
    },
  };
});
