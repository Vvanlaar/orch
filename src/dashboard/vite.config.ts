import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  root: '.',
  build: {
    outDir: '../../dist/dashboard',
    emptyOutDir: true,
  },
  server: {
    port: 3003,
    proxy: {
      '/api': {
        target: 'http://localhost:3004',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3004',
        ws: true,
      },
    },
  },
});
