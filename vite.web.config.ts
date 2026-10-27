// Serves the renderer alone in a browser, backed by the fixture backend.
// Used by the Playwright e2e suite, by screenshot scripts, and for UI work without Electron.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
    },
  },
  define: { 'import.meta.env.VITE_BACKEND': JSON.stringify('fixture') },
  plugins: [react()],
  server: { port: 5317, strictPort: true },
});
