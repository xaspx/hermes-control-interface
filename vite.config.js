import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:10274',
      '/ws': {
        target: 'ws://localhost:10274',
        ws: true,
      },
    },
  },
  css: {
    devSourcemap: true,
  },
});
