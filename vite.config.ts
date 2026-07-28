import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 5299,
    // NUM AI backend (server/index.mjs) — keeps the API key out of the browser.
    proxy: { '/api': 'http://localhost:8787' },
  },
});
