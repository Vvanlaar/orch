import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendPort = Number(env.PORT) || 3011;
  const dashboardPort = Number(env.DASHBOARD_PORT) || 3010;

  return {
    plugins: [svelte()],
    root: '.',
    build: {
      outDir: '../../dist/dashboard',
      emptyOutDir: true,
    },
    server: {
      port: dashboardPort,
      proxy: {
        '/api': {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
        },
        '/ws': {
          target: `ws://localhost:${backendPort}`,
          ws: true,
        },
      },
    },
  };
});
