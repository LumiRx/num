import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Stamped into the bundle at build time so a running copy can say exactly which
// version it is — the difference between "it looks like the old copy" and
// knowing whether a phone is on a stale cache.
const VERSION = process.env.VITE_NUM_VERSION ?? JSON.parse(readFileSync('package.json', 'utf8')).version;
const SHA = process.env.VITE_NUM_SHA ?? 'dev';

export default defineConfig({
  plugins: [react()],
  define: {
    __NUM_VERSION__: JSON.stringify(VERSION),
    __NUM_SHA__: JSON.stringify(SHA),
    __NUM_BUILT__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  // public/ belongs to the partner console (num-console) — the app's static
  // assets live in app-public/ so builds don't copy the console site into dist/.
  publicDir: 'app-public',
  server: {
    port: Number(process.env.PORT) || 5299,
    // NUM AI backend (server/index.mjs) — keeps the API key out of the browser.
    proxy: { '/api': 'http://localhost:8787' },
  },
});
