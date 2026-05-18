import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendPort = Number(env.PORT) || 3011;
  const dashboardPort = Number(env.DASHBOARD_PORT) || 3010;

  return {
    plugins: [tailwindcss(), svelte()],
    root: '.',
    appType: 'spa',
    build: {
      outDir: '../../dist/dashboard',
      emptyOutDir: true,
    },
    server: {
      port: dashboardPort,
      proxy: {
        // Use 127.0.0.1 explicitly — orch binds IPv4 only, and on Node 18+
        // 'localhost' resolves to ::1 first which then fails to connect.
        '/api': {
          target: `http://127.0.0.1:${backendPort}`,
          changeOrigin: true,
        },
        '/ws': {
          target: `ws://127.0.0.1:${backendPort}`,
          ws: true,
        },
      },
    },
  };
});
