import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // public/ belongs to the partner console (num-console) — the app's static
  // assets live in app-public/ so builds don't copy the console site into dist/.
  publicDir: 'app-public',
  server: {
    port: Number(process.env.PORT) || 5299,
    // NUM AI backend (server/index.mjs) — keeps the API key out of the browser.
    proxy: { '/api': 'http://localhost:8787' },
  },
});
