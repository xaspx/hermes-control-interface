import { defineConfig } from 'vite';

const backendUrl = process.env.HCI_BACKEND_URL || 'http://localhost:10272';
const backendWsUrl = backendUrl.replace(/^http/, 'ws');

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': backendUrl,
      '/ws': {
        target: backendWsUrl,
        ws: true,
      },
    },
  },
  css: {
    devSourcemap: true,
  },
});
