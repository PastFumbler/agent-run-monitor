// End-to-end tests against the REAL Electron app (the build in out/). Run with
// `npm run test:electron`, which builds first. Each test launches its own app with a fresh
// settings folder and a fake home of synthetic sessions (see e2e-electron/helpers.ts).
//
// e2e-electron/live-claude.spec.ts reads the REAL home and runs only with ARM_REAL_CLAUDE=1, never
// in CI. It has its own project: no traces, screenshots or videos, and any output goes to the OS
// temp folder, so nothing from real sessions lands in the repository folder.
import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const LIVE = /live-claude\.spec\.ts$/;

export default defineConfig({
  testDir: './e2e-electron',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // One app at a time: each test drives a whole desktop app and some measure timing.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  projects: [
    {
      name: 'electron',
      testIgnore: LIVE,
      outputDir: 'test-results/electron',
      use: { trace: 'retain-on-failure' },
    },
    {
      name: 'live-local',
      testMatch: LIVE,
      outputDir: path.join(os.tmpdir(), 'arm-e2e-live-results'),
      use: { trace: 'off', screenshot: 'off', video: 'off' },
    },
  ],
});
