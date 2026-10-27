// Low-GPU multiviewer in the real app: main sends run detail for the focused tile with every flush
// (about once a second) and for the other tiles at most every 3 s (backend.setWatchPriority), all of
// one flush in a single arm:ev:runDetails message. Four synthetic sessions grow every 300 ms; the
// details are counted in the main process by wrapping webContents.send.

import { expect, test } from '@playwright/test';
import path from 'node:path';
import { baseSettings, launchApp, removeDir, SessionWriter, tempDir, waitForRuns, type Launched } from './helpers';

const SLOW_MS = 3000;
const WINDOW_MS = 9000;

let home = '';
let launched: Launched | undefined;
let timer: NodeJS.Timeout | undefined;

test.afterEach(async () => {
  clearInterval(timer);
  await launched?.close();
  launched = undefined;
  removeDir(home);
});

test('low GPU On: unfocused tiles get detail pushes at most every 3 s, the focused tile every flush', async () => {
  test.setTimeout(120_000);
  home = tempDir('home');
  const claude = path.join(home, '.claude');
  const live = [0, 1, 2, 3].map((i) => {
    const s = new SessionWriter(`C:\\Users\\demo\\code\\tile-demo-${i}`, Date.now() - 5_000).user(`Tile demo ${i}: keep searching the code`);
    s.write(claude);
    return s;
  });
  let n = 0;
  timer = setInterval(() => {
    for (const s of live) s.clockNow().toolUse('Grep', { pattern: `needle${n}`, path: 'src' }).toolResult(`Found ${n % 7} files`).appendNew();
    n++;
  }, 300);

  launched = await launchApp({ home, settings: baseSettings({ reduceMotion: 'off', lowGpu: 'on' }) });
  const { app, page } = launched;
  await waitForRuns(page, 4);
  const ids = await page.evaluate(async () => {
    const b = (window as unknown as { armBackend: { listRuns(): Promise<{ id: string; title?: string }[]> } }).armBackend;
    return (await b.listRuns()).filter((r) => /Tile demo/.test(r.title ?? '')).map((r) => r.id);
  });
  expect(ids.length).toBe(4);
  await page.evaluate(async (runIds) => {
    const b = (window as unknown as { armBackend: { setSettings(p: unknown): Promise<unknown> } }).armBackend;
    await b.setSettings({ layouts: [{ name: 'four', runIds }] });
  }, ids);
  await page.reload();
  await waitForRuns(page, 4);
  const mv = page.getByTestId('multiview');
  await expect(async () => {
    if ((await mv.count()) === 0) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('g');
      await page.keyboard.press('m');
    }
    await expect(mv).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  const open = page.getByRole('button', { name: 'Open layout four', exact: true });
  if (!(await open.isVisible())) await page.getByRole('button', { name: /^Layouts/ }).click();
  await open.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('mv-tile')).toHaveCount(4);
  const focused = await page.locator('[data-testid="mv-tile"][aria-current="true"]').getAttribute('data-tile-id');
  expect(focused && ids.includes(focused)).toBe(true);

  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as { __armDetails: [number, string[]][]; __armSingle: number };
    g.__armDetails = [];
    g.__armSingle = 0;
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const orig = wc.send.bind(wc);
    wc.send = (channel: string, ...args: unknown[]) => {
      if (channel === 'arm:ev:runDetails') g.__armDetails.push([Date.now(), (args[0] as { summary: { id: string } }[]).map((d) => d.summary.id)]);
      if (channel === 'arm:ev:runDetail') g.__armSingle++;
      return orig(channel, ...args);
    };
  });
  // Let the priority settle (a held-back change from before the counter may still be due).
  await page.waitForTimeout(SLOW_MS);
  const from = await app.evaluate(() => Date.now());
  await page.waitForTimeout(WINDOW_MS);
  const { messages, single } = await app.evaluate((_e, f) => {
    const g = globalThis as unknown as { __armDetails: [number, string[]][]; __armSingle: number };
    return { messages: g.__armDetails.filter(([t]) => t >= f), single: g.__armSingle };
  }, from);

  const per = (id: string) => messages.filter(([, list]) => list.includes(id)).map(([t]) => t);
  const counts = Object.fromEntries(ids.map((id) => [id === focused ? 'focused' : id.slice(-6), per(id).length]));
  test.info().annotations.push({ type: 'detail pushes in 9 s', description: JSON.stringify(counts) });

  expect(single, 'no per-detail messages on the old channel').toBe(0);
  expect(per(focused!).length, 'focused tile: about one push a second').toBeGreaterThanOrEqual(6);
  for (const id of ids.filter((x) => x !== focused)) {
    const times = per(id);
    expect(times.length, `unfocused tile ${id.slice(-6)}: at most one push per 3 s`).toBeLessThanOrEqual(Math.ceil(WINDOW_MS / SLOW_MS) + 1);
    expect(times.length, `unfocused tile ${id.slice(-6)}: still updated`).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1], 'gap between pushes').toBeGreaterThanOrEqual(SLOW_MS - 150);
  }
  expect(launched.errors).toEqual([]);
});
