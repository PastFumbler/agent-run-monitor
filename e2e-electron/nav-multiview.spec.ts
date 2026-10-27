// Navigation and the multiviewer in the real app, over 14 synthetic Claude Code sessions written by
// scripts/simulate-live-runs.mjs into a fake home: ← / →, Ctrl+K, the ? cheat sheet, grids for
// 1-12 tiles, pagination at 13, the five views inside a tile, maximise / Esc, and the low-GPU badge.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { baseSettings, launchApp, REPO, removeDir, statusBarRunCount, tempDir, waitForRuns, type Launched } from './helpers';

const RUNS = 14;

/** Grid shape per tile count (docs/PLAN.md 5.3). */
const EXPECTED: Record<number, string> = {
  1: '1x1',
  2: '2x1',
  3: '2x2',
  4: '2x2',
  5: '3x2',
  6: '3x2',
  7: '3x3',
  8: '3x3',
  9: '3x3',
  10: '4x3',
  11: '4x3',
  12: '4x3',
};

let home = '';
let launched: Launched | undefined;

test.beforeAll(() => {
  home = tempDir('home');
  // Writes RUNS sessions and appends to them for a few seconds, then exits (synthetic data only).
  execFileSync(process.execPath, ['scripts/simulate-live-runs.mjs', '--count', String(RUNS), '--duration', '6', '--seed', '7', '--dir', path.join(home, '.claude')], {
    cwd: REPO,
    stdio: 'ignore',
    timeout: 60_000,
  });
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test.afterAll(() => removeDir(home));

async function start(settings: Record<string, unknown> = {}): Promise<Page> {
  launched = await launchApp({ home, settings: baseSettings({ historyDays: 0, ...settings }) });
  const page = launched.page;
  await waitForRuns(page, 1);
  await expect.poll(() => statusBarRunCount(page), { timeout: 30_000 }).toBe(RUNS);
  // The app opens on the dashboard; open the newest run from the list.
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await page.getByTestId('run-list').getByRole('option').first().click();
  await expect(page.getByTestId('run-title')).toBeVisible();
  return page;
}

/** Run ids, newest first (the order the app lists them). */
async function runIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const b = (window as unknown as { armBackend: { listRuns(): Promise<{ id: string; updatedAt: number }[]> } }).armBackend;
    const runs = await b.listRuns();
    return runs.sort((a, c) => c.updatedAt - a.updatedAt || (a.id < c.id ? -1 : 1)).map((r) => r.id);
  });
}

/** Saves layouts n1..n13 through the real settings IPC, then reloads the window to pick them up. */
async function withLayouts(page: Page, counts: number[]): Promise<string[]> {
  const ids = await runIds(page);
  expect(ids.length).toBe(RUNS);
  const layouts = counts.map((n) => ({ name: `n${n}`, runIds: ids.slice(0, n) }));
  await page.evaluate(async (l) => {
    const b = (window as unknown as { armBackend: { setSettings(p: unknown): Promise<unknown> } }).armBackend;
    await b.setSettings({ layouts: l });
  }, layouts);
  await page.reload();
  await waitForRuns(page, 1);
  return ids;
}

async function gotoMultiview(page: Page) {
  const mv = page.getByTestId('multiview');
  await expect(async () => {
    if ((await mv.count()) === 0) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('g');
      await page.keyboard.press('m');
    }
    await expect(mv).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

async function openLayout(page: Page, name: string) {
  await gotoMultiview(page);
  const open = page.getByRole('button', { name: `Open layout ${name}`, exact: true });
  if (!(await open.isVisible())) await page.getByRole('button', { name: /^Layouts/ }).click();
  await open.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

const grid = (page: Page) => page.getByTestId('mv-grid');
const tiles = (page: Page) => grid(page).getByTestId('mv-tile');
const tileIds = (page: Page) => tiles(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tileId as string));
const tile = (page: Page, id: string): Locator => grid(page).locator(`[data-tile-id="${id}"]`);

test('← / → move between runs, Ctrl+K finds a run, ? opens the cheat sheet', async () => {
  const page = await start();
  const title = page.getByTestId('run-title');
  const first = (await title.textContent()) ?? '';
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowRight');
  await expect(title).not.toHaveText(first);
  const second = (await title.textContent()) ?? '';
  await page.keyboard.press('ArrowRight');
  await expect(title).not.toHaveText(second);
  await page.keyboard.press('ArrowLeft');
  await expect(title).toHaveText(second);
  await page.keyboard.press('ArrowLeft');
  await expect(title).toHaveText(first);

  // Ctrl+K: search a project name from the simulator and open the hit.
  await page.keyboard.press('Control+K');
  const input = page.getByRole('combobox', { name: 'Search runs and commands' });
  await expect(input).toBeFocused();
  await input.fill('pixel-garden');
  const item = page.locator('[cmdk-item]').first();
  await expect(item).toContainText('pixel-garden');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('2');
  await expect(page.getByTestId('view-overview')).toContainText('pixel-garden');

  // ? cheat sheet.
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Command palette');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(launched!.errors).toEqual([]);
});

test('multiviewer: grid for 1-12 tiles, 13 paginates, views per tile, maximise and Esc', async () => {
  const page = await start();
  const counts = [...Object.keys(EXPECTED).map(Number), 13];
  const ids = await withLayouts(page, counts);
  const seen: Record<string, string> = {};

  for (const n of Object.keys(EXPECTED).map(Number)) {
    await openLayout(page, `n${n}`);
    await expect(grid(page)).toHaveAttribute('data-grid', EXPECTED[n]);
    await expect(grid(page)).toHaveAttribute('data-tile-count', String(n));
    await expect(tiles(page)).toHaveCount(n);
    expect(await tileIds(page)).toEqual(ids.slice(0, n));
    await expect(page.getByTestId('mv-page-label')).toHaveCount(0);
    // Every tile renders its default view (Activity) with content.
    for (const id of ids.slice(0, n)) await expect(tile(page, id).getByTestId('view-activity')).toBeAttached();
    seen[n] = (await grid(page).getAttribute('data-grid')) ?? '';
  }
  test.info().annotations.push({ type: 'grids', description: JSON.stringify(seen) });

  // 13 runs: two pages.
  await openLayout(page, 'n13');
  const label = page.getByTestId('mv-page-label');
  await expect(label).toHaveText('Page 1 of 2');
  await expect(grid(page)).toHaveAttribute('data-grid', '4x3');
  await expect(tiles(page)).toHaveCount(12);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(label).toHaveText('Page 2 of 2');
  await expect(grid(page)).toHaveAttribute('data-grid', '1x1');
  expect(await tileIds(page)).toEqual([ids[12]]);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('PageUp');
  await expect(label).toHaveText('Page 1 of 2');

  // Each of the five views inside one tile.
  await openLayout(page, 'n4');
  const t = tile(page, ids[1]);
  for (const [name, testId] of [
    ['Overview', 'view-overview'],
    ['Files', 'view-files'],
    ['Tools', 'view-tools'],
    ['Timeline', 'view-timeline'],
    ['Activity', 'view-activity'],
  ] as const) {
    await t.getByRole('radio', { name, exact: true }).click();
    await expect(t.getByRole('radio', { name, exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(t.getByTestId(testId)).toBeVisible();
  }
  await expect(tile(page, ids[0]).getByTestId('view-activity')).toBeVisible();

  // Maximise and Esc.
  await t.getByTestId('mv-tile-maximize').click();
  await expect(grid(page)).toHaveAttribute('data-maximized', '');
  await expect(t).toHaveAttribute('data-maximized', '');
  for (const id of [ids[0], ids[2], ids[3]]) await expect(tile(page, id)).toBeHidden();
  const box = await t.boundingBox();
  const gridBox = await grid(page).boundingBox();
  expect(box!.width).toBeGreaterThan(gridBox!.width * 0.9);
  await page.keyboard.press('Escape');
  await expect(grid(page)).not.toHaveAttribute('data-maximized', '');
  for (const id of ids.slice(0, 4)) await expect(tile(page, id)).toBeVisible();
  expect(launched!.errors).toEqual([]);
});

test('low GPU On: badge in the status bar, unfocused tiles show the slow-update badge', async () => {
  const page = await start({ lowGpu: 'on' });
  await expect(page.locator('html')).toHaveAttribute('data-low-gpu', '');
  await expect(page.getByTestId('power-indicator')).toContainText('Low-GPU mode');
  const ids = await withLayouts(page, [4]);
  await expect(page.locator('html')).toHaveAttribute('data-low-gpu', '');
  await openLayout(page, 'n4');
  await expect(tile(page, ids[0])).toHaveAttribute('aria-current', 'true');
  await expect(tile(page, ids[0]).getByTestId('mv-slow-badge')).toHaveCount(0);
  for (const id of ids.slice(1, 4)) await expect(tile(page, id).getByTestId('mv-slow-badge')).toBeVisible();
  const badge = (await tile(page, ids[1]).getByTestId('mv-slow-badge').textContent()) ?? '';
  test.info().annotations.push({ type: 'slow-badge', description: badge });
  await tile(page, ids[2]).getByTestId('mv-tile-title').click();
  await expect(tile(page, ids[2]).getByTestId('mv-slow-badge')).toHaveCount(0);
  await expect(tile(page, ids[0]).getByTestId('mv-slow-badge')).toBeVisible();
  expect(launched!.errors).toEqual([]);
});
