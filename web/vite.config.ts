import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // `npm run dev` talks to the lab server (`npm run lab -- serve`, port 5181).
  server: { port: 5180, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:5181' } },
  preview: { port: 5180, host: '127.0.0.1' },
});
