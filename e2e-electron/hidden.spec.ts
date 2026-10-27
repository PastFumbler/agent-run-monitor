// A minimised window in the real app: <html data-hidden> is set and run updates reach the window
// at most once every 5 s, while two synthetic sessions keep growing every 300 ms. Pushes are counted
// in the main process by wrapping webContents.send (runsUpdate and runDetails channels). A visible
// phase first shows that the same counter sees frequent pushes, so the hidden check can fail.

import { expect, test, type ElectronApplication } from '@playwright/test';
import path from 'node:path';
import { baseSettings, launchApp, removeDir, SessionWriter, tempDir, waitForRuns, type Launched } from './helpers';

const PUSH_CHANNELS = ['arm:ev:runsUpdate', 'arm:ev:runDetails'];
const HIDDEN_MS = 5000;

let home = '';
let launched: Launched | undefined;
let timer: NodeJS.Timeout | undefined;

test.afterEach(async () => {
  clearInterval(timer);
  await launched?.close();
  launched = undefined;
  removeDir(home);
});

async function installCounter(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }, channels) => {
    const g = globalThis as unknown as { __armPushes: [number, string][] };
    g.__armPushes = [];
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const orig = wc.send.bind(wc);
    wc.send = (channel: string, ...args: unknown[]) => {
      if (channels.includes(channel)) g.__armPushes.push([Date.now(), channel]);
      return orig(channel, ...args);
    };
  }, PUSH_CHANNELS);
}

/** Push times since `from` (main-process clock). */
async function pushesSince(app: ElectronApplication, from: number): Promise<number[]> {
  return app.evaluate((_e, f) => (globalThis as unknown as { __armPushes: [number, string][] }).__armPushes.filter(([t]) => t >= f).map(([t]) => t), from);
}

/** Pushes within 100 ms of each other come from one flush (a list update plus its run details). */
function flushes(times: number[]): number[] {
  const out: number[] = [];
  for (const t of [...times].sort((a, b) => a - b)) if (!out.length || t - out[out.length - 1] > 100) out.push(t);
  return out;
}

test('minimised: data-hidden, and run updates arrive at most once per 5 s; restore resumes', async () => {
  home = tempDir('home');
  const claude = path.join(home, '.claude');
  const live = [0, 1].map((i) => {
    const s = new SessionWriter(`C:\\Users\\demo\\code\\live-demo-${i}`, Date.now() - 5_000).user(`Live demo ${i}: keep searching the code`);
    s.write(claude);
    return s;
  });
  let n = 0;
  timer = setInterval(() => {
    for (const s of live) {
      s.clockNow().toolUse('Grep', { pattern: `needle${n}`, path: 'src' }).toolResult(`Found ${n % 7} files`).appendNew();
    }
    n++;
  }, 300);

  launched = await launchApp({ home, settings: baseSettings({ reduceMotion: 'off', lowGpu: 'off' }) });
  const { app, page } = launched;
  await waitForRuns(page, 2);
  await page.getByTestId('run-list').getByRole('option', { name: /Live demo 0/ }).first().click();
  await expect(page.getByTestId('run-title')).toContainText('Live demo 0');
  await installCounter(app);

  // Visible: frequent pushes (250 ms batching).
  const visibleFrom = await app.evaluate(() => Date.now());
  await page.waitForTimeout(6_000);
  const visible = flushes(await pushesSince(app, visibleFrom));
  expect(visible.length, 'flushes in 6 s while visible').toBeGreaterThan(6);

  // Minimise.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-hidden', '');
  const hiddenFrom = await app.evaluate(() => Date.now());
  await page.waitForTimeout(26_000);
  const hiddenTimes = await pushesSince(app, hiddenFrom);
  const hidden = flushes(hiddenTimes);
  const gaps = hidden.slice(1).map((t, i) => t - hidden[i]);
  // Data kept arriving (the sessions grew all along), so updates were batched, not stopped.
  expect(hidden.length, 'flushes in 26 s while hidden').toBeGreaterThanOrEqual(3);
  expect(hidden.length).toBeLessThanOrEqual(Math.ceil(26_000 / HIDDEN_MS) + 1);
  // Timers may fire a few ms early on Windows; allow 50 ms.
  expect(Math.min(...gaps), 'shortest gap between hidden flushes (ms)').toBeGreaterThanOrEqual(HIDDEN_MS - 50);
  await expect(page.locator('html')).toHaveAttribute('data-hidden', '');

  // Restore.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await expect(page.locator('html')).not.toHaveAttribute('data-hidden', '');
  const restoredFrom = await app.evaluate(() => Date.now());
  await page.waitForTimeout(4_000);
  const restored = flushes(await pushesSince(app, restoredFrom));
  expect(restored.length, 'flushes in 4 s after restore').toBeGreaterThan(4);

  const result = {
    visibleFlushesIn6s: visible.length,
    hiddenFlushesIn26s: hidden.length,
    hiddenPushMessages: hiddenTimes.length,
    hiddenGapsMs: gaps,
    restoredFlushesIn4s: restored.length,
    appendedRecordsPerSession: n * 2,
  };
  test.info().annotations.push({ type: 'hidden-timing', description: JSON.stringify(result) });
  console.log(`hidden-timing ${JSON.stringify(result)}`);
  expect(launched.errors).toEqual([]);
});
