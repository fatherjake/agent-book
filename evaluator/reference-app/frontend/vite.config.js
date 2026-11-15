import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // `npm run dev:frontend` proxies API calls to the backend started with `npm start`.
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
