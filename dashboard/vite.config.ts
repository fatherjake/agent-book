import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` proxies API/artifact calls to a running `npm run dashboard` server.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4173',
      '/artifacts': 'http://127.0.0.1:4173',
    },
  },
});
