// Reduce motion in the real app: the OS preference (forced with Chromium's
// --force-prefers-reduced-motion switch) with the setting on Auto, and the setting On without it.
// Either way <html data-reduce-motion> is set and no infinite animation is running. A control run
// without either shows the running spinners do animate, so the check can fail.
//
// Playwright's Electron context emulates prefers-reduced-motion: no-preference by default, which
// hides the switch from the page. emulateMedia({ reducedMotion: null }) removes that emulation, so
// the page sees what Chromium itself reports (the switch), as it would outside the test.

import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { baseSettings, launchApp, removeDir, SessionWriter, tempDir, waitForRuns, type Launched } from './helpers';

let home = '';
let launched: Launched | undefined;

test.beforeEach(() => {
  home = tempDir('home');
  // A run that is busy right now: its last record is a shell call with no result yet.
  const cwd = 'C:\\Users\\demo\\code\\spinner-demo';
  new SessionWriter(cwd, Date.now() - 20_000)
    .user('Run the slow integration tests')
    .assistantText('Starting the test run.')
    .toolUse('Bash', { command: 'npm run test:integration', description: 'Run integration tests' })
    .write(path.join(home, '.claude'));
  // And a finished one, so the list has more than one row.
  new SessionWriter('C:\\Users\\demo\\code\\notes-app', Date.now() - 30 * 60_000)
    .user('Fix the typo in the README')
    .assistantText('Fixed.', 'end_turn')
    .write(path.join(home, '.claude'));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  removeDir(home);
});

async function infiniteAnimations(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity)
      .map((a) => (a as CSSAnimation).animationName ?? 'anonymous'),
  );
}

async function openRunningRun(page: Page) {
  await waitForRuns(page, 2);
  await page.getByTestId('run-list').getByRole('option', { name: /slow integration tests/ }).first().click();
  await expect(page.getByTestId('run-title')).toContainText('slow integration tests');
  await expect(page.getByTestId('run-status-live')).toHaveText('Status: Running');
}

test('OS reduced motion (--force-prefers-reduced-motion) with the setting on Auto', async () => {
  launched = await launchApp({ home, settings: baseSettings({ reduceMotion: 'auto' }), args: ['--force-prefers-reduced-motion'] });
  const { page } = launched;
  await page.emulateMedia({ reducedMotion: null });
  await openRunningRun(page);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', '');
  await page.waitForTimeout(800);
  expect(await infiniteAnimations(page)).toEqual([]);
  expect(launched.errors).toEqual([]);
});

test('reduce motion On in settings, without the OS preference', async () => {
  launched = await launchApp({ home, settings: baseSettings({ reduceMotion: 'on' }) });
  const { page } = launched;
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openRunningRun(page);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', '');
  await page.waitForTimeout(800);
  expect(await infiniteAnimations(page)).toEqual([]);
  expect(launched.errors).toEqual([]);
});

test('control: Auto without the OS preference animates the running run', async () => {
  launched = await launchApp({ home, settings: baseSettings({ reduceMotion: 'auto', lowGpu: 'off' }) });
  const { page } = launched;
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openRunningRun(page);
  await expect(page.locator('html')).not.toHaveAttribute('data-reduce-motion', '');
  await expect.poll(async () => (await infiniteAnimations(page)).length).toBeGreaterThan(0);
  expect(launched.errors).toEqual([]);
});
