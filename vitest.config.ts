import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'node', environment: 'node', include: ['src/core/**/*.test.ts', 'src/shared/**/*.test.ts', 'src/main/**/*.test.ts', 'test/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'renderer', environment: 'jsdom', include: ['src/renderer/**/*.test.{ts,tsx}'] },
      },
    ],
  },
});
