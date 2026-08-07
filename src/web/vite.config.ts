import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  // `root` defaults to process.cwd(), not this config file's directory — pin it explicitly so
  // `npm run dev:web` works regardless of which directory it's invoked from.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    // Sits beside dist/server/ (tsc's output) so a compiled `dist/server/app.js` can find it via
    // a relative '../web' — see src/server/app.ts's DEFAULT_WEB_DIST_DIR.
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
