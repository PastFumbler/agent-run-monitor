// End-to-end tests against the renderer in a browser, backed by the fixture backend
// (vite.web.config.ts serves it on :5317). Uses the installed Google Chrome (channel 'chrome'),
// so no browser download is needed.
import { defineConfig, devices } from '@playwright/test';

const PORT = 5317;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1360, height: 860 },
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1360, height: 860 } },
    },
  ],
  webServer: {
    command: 'npx vite --config vite.web.config.ts',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
