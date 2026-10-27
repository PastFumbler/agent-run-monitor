// End-to-end tests of the multiviewer (docs/PLAN.md 5.3) against the fixture backend.
// Most selections are made by seeding saved layouts (the fixture keeps settings in localStorage) and
// opening them, which also exercises layouts; one test builds the selection from the run list.
import { expect, test, type Locator, type Page } from '@playwright/test';

// Grids of up to 12 live tiles per test. The test timeout also covers closing the context, which
// writes the trace and can take most of a minute on a loaded machine: allow 2 minutes.
test.describe.configure({ timeout: 120_000 });

const NOW = '2026-10-27T15:30:00';
const demo = (extra = '') => `/?now=${NOW}&live=0${extra}`;
const SETTINGS_KEY = 'arm.fixture.settings.demo';

/** Grid shape per tile count, from the plan. */
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

// No console errors and no uncaught exceptions in any test.
let browserErrors: string[] = [];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') browserErrors.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => browserErrors.push(`uncaught: ${e.message}`));
});
test.afterEach(() => {
  expect(browserErrors, 'errors in the browser console').toEqual([]);
});

async function ready(page: Page) {
  await expect(page.getByTestId('run-list').getByRole('option').first()).toBeVisible();
}

/** Every demo run id, newest first (deterministic for a seed). */
async function runIds(page: Page, filter?: 'running'): Promise<string[]> {
  return page.evaluate(
    (f) =>
      window
        .__armFixture!.runs()
        .filter((r) => !f || r.status === f)
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
        .map((r) => r.id),
    filter,
  );
}

/** Loads the demo with these saved layouts already in settings. Returns all run ids. */
async function withLayouts(page: Page, make: (ids: string[]) => { name: string; runIds: string[] }[], extra = ''): Promise<string[]> {
  await page.goto(demo(extra));
  await ready(page);
  const ids = await runIds(page);
  const layouts = make(ids);
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [SETTINGS_KEY, JSON.stringify({ layouts })] as const);
  await page.reload();
  await ready(page);
  return ids;
}

const nLayouts = (counts: number[]) => (ids: string[]) => counts.map((n) => ({ name: `n${n}`, runIds: ids.slice(0, n) }));

async function gotoMultiview(page: Page) {
  const mv = page.getByTestId('multiview');
  // "g then m" must arrive within 1.2 s; on a busy machine the second key can miss it, so try again.
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

test.describe('multiviewer grid', () => {
  for (const n of Object.keys(EXPECTED).map(Number)) {
    test(`${n} run${n === 1 ? '' : 's'}: grid ${EXPECTED[n]}`, async ({ page }) => {
      const ids = await withLayouts(page, nLayouts([n]));
      await openLayout(page, `n${n}`);
      await expect(grid(page)).toHaveAttribute('data-grid', EXPECTED[n]);
      await expect(grid(page)).toHaveAttribute('data-tile-count', String(n));
      await expect(tiles(page)).toHaveCount(n);
      expect(await tileIds(page)).toEqual(ids.slice(0, n));
      await expect(page.getByTestId('mv-page-label')).toHaveCount(0);
      // Columns really are laid out as the label says.
      const [cols, rows] = EXPECTED[n].split('x').map(Number);
      const tops = await tiles(page).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      const lefts = await tiles(page).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
      expect(new Set(lefts).size).toBe(Math.min(cols, n));
      expect(new Set(tops).size).toBe(Math.ceil(n / cols));
      expect(Math.ceil(n / cols)).toBeLessThanOrEqual(rows);
      if (n === 1) {
        // One tile: the full width of the grid.
        const box = await tiles(page).first().boundingBox();
        const gridBox = await grid(page).boundingBox();
        expect(box!.width).toBeGreaterThan(gridBox!.width * 0.9);
      }
    });
  }

  test('13 and 25 runs paginate in pages of 12 (buttons and PageUp/PageDown)', async ({ page }) => {
    const ids = await withLayouts(page, nLayouts([13, 25]));
    await openLayout(page, 'n13');
    const label = page.getByTestId('mv-page-label');
    await expect(label).toHaveText('Page 1 of 2');
    await expect(grid(page)).toHaveAttribute('data-grid', '4x3');
    await expect(tiles(page)).toHaveCount(12);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(label).toHaveText('Page 2 of 2');
    await expect(grid(page)).toHaveAttribute('data-grid', '1x1');
    await expect(grid(page)).toHaveAttribute('data-tile-count', '1');
    expect(await tileIds(page)).toEqual([ids[12]]);
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await page.keyboard.press('PageUp');
    await expect(label).toHaveText('Page 1 of 2');

    await openLayout(page, 'n25');
    await expect(label).toHaveText('Page 1 of 3');
    expect(await tileIds(page)).toEqual(ids.slice(0, 12));
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('PageDown');
    await expect(label).toHaveText('Page 2 of 3');
    await expect(grid(page)).toHaveAttribute('data-grid', '4x3');
    expect(await tileIds(page)).toEqual(ids.slice(12, 24));
    await page.keyboard.press('PageDown');
    await expect(label).toHaveText('Page 3 of 3');
    await expect(grid(page)).toHaveAttribute('data-grid', '1x1');
    expect(await tileIds(page)).toEqual([ids[24]]);
    // Past the last page nothing happens.
    await page.keyboard.press('PageDown');
    await expect(label).toHaveText('Page 3 of 3');
    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(label).toHaveText('Page 2 of 3');
  });

  test('a smaller grid tile limit (settings) makes smaller pages', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    const ids = await runIds(page);
    const settings = { gridTileLimit: 4, layouts: [{ name: 'six', runIds: ids.slice(0, 6) }] };
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [SETTINGS_KEY, JSON.stringify(settings)] as const);
    await page.reload();
    await ready(page);
    await openLayout(page, 'six');
    await expect(page.getByTestId('mv-page-label')).toHaveText('Page 1 of 2');
    await expect(grid(page)).toHaveAttribute('data-grid', '2x2');
    expect(await tileIds(page)).toEqual(ids.slice(0, 4));
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(grid(page)).toHaveAttribute('data-grid', '2x1');
    expect(await tileIds(page)).toEqual(ids.slice(4, 6));
  });

  test('a run-list selection opens with "Open multiviewer (n)" and g m; the picker adds and removes runs', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    const list = page.getByTestId('run-list');
    const rows = list.locator('[role="option"]');
    const picked: string[] = [];
    for (const i of [2, 3, 4]) {
      const row = rows.nth(i);
      picked.push((await row.getAttribute('data-run-id')) as string);
      // ⌘ on macOS, where Ctrl-click is a right-click and never fires `click`.
      await row.click({ modifiers: ['ControlOrMeta'] });
    }
    const open = page.getByRole('button', { name: 'Open multiviewer (3)' });
    await expect(open).toBeVisible();
    await open.click();
    await expect(grid(page)).toHaveAttribute('data-grid', '2x2');
    await expect(page.getByTestId('mv-count')).toHaveText('3 runs');
    // The button hides while the grid is open; g m opens the grid again from the run view.
    await expect(open).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to run' }).click();
    await expect(page.getByRole('button', { name: 'Open multiviewer (3)' })).toBeVisible();
    await gotoMultiview(page);
    await expect(grid(page)).toHaveAttribute('data-grid', '2x2');
    expect(new Set(await tileIds(page))).toEqual(new Set(picked));

    await page.getByRole('button', { name: 'Add runs' }).click();
    const input = page.getByRole('combobox', { name: 'Find runs to add' });
    await expect(input).toBeFocused();
    await input.fill('codex');
    const first = page.getByRole('dialog').getByRole('option').first();
    await expect(first).toContainText('Codex');
    const wasPicked = (await first.textContent())?.includes('In multiviewer');
    await input.press('Enter');
    await expect(page.getByRole('dialog')).toContainText(`${wasPicked ? 2 : 4} runs picked`);
    await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
    await expect(tiles(page)).toHaveCount(wasPicked ? 2 : 4);
    await expect(grid(page)).toHaveAttribute('data-grid', wasPicked ? '2x1' : '2x2');
  });
});

test.describe('multiviewer tiles', () => {
  test('each of the five views renders inside a tile (switcher and keys 1-5)', async ({ page }) => {
    const ids = await withLayouts(page, nLayouts([2]));
    await openLayout(page, 'n2');
    const t = tile(page, ids[1]);
    const views: [string, string][] = [
      ['Overview', 'view-overview'],
      ['Files', 'view-files'],
      ['Tools', 'view-tools'],
      ['Timeline', 'view-timeline'],
      ['Activity', 'view-activity'],
    ];
    for (const [name, testId] of views) {
      await t.getByRole('radio', { name, exact: true }).click();
      await expect(t.getByRole('radio', { name, exact: true })).toHaveAttribute('aria-checked', 'true');
      await expect(t.getByTestId(testId)).toBeVisible();
    }
    // The other tile keeps its own view.
    await expect(tile(page, ids[0]).getByTestId('view-activity')).toBeVisible();
    // Keys 1-5 switch the focused tile (the one clicked last).
    await expect(t).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('3');
    await expect(t.getByTestId('view-files')).toBeVisible();
    await page.keyboard.press('5');
    await expect(t.getByTestId('view-timeline')).toBeVisible();
    await expect(tile(page, ids[0]).getByTestId('view-activity')).toBeVisible();
    // Activity in a small tile is a virtualised log with rows.
    await openLayout(page, 'n2');
    const log = tile(page, ids[0]).getByRole('log', { name: 'Run activity' });
    await expect(log).toBeVisible();
    await expect(log.locator('.ev').first()).toBeVisible();
  });

  test('clicking a tile focuses it; ← / → move between tiles without leaving', async ({ page }) => {
    const ids = await withLayouts(page, nLayouts([3]));
    await openLayout(page, 'n3');
    await expect(tile(page, ids[0])).toHaveAttribute('aria-current', 'true');
    await tile(page, ids[2]).getByTestId('mv-tile-title').click();
    await expect(tile(page, ids[2])).toHaveAttribute('aria-current', 'true');
    await expect(tile(page, ids[0])).not.toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(tile(page, ids[1])).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('multiview')).toBeVisible();
  });

  test('maximise (button, f, double-click) and Esc restores; hidden tiles stay mounted and paused', async ({ page }) => {
    const ids = await withLayouts(page, nLayouts([4]));
    await openLayout(page, 'n4');
    const second = tile(page, ids[1]);
    await second.getByTestId('mv-tile-maximize').click();
    await expect(grid(page)).toHaveAttribute('data-maximized', '');
    await expect(second).toBeVisible();
    await expect(second).toHaveAttribute('data-maximized', '');
    await expect(tiles(page)).toHaveCount(4);
    for (const id of [ids[0], ids[2], ids[3]]) {
      await expect(tile(page, id)).toBeHidden();
      await expect(tile(page, id)).toHaveAttribute('data-paused', 'behind-maximized');
    }
    const box = await second.boundingBox();
    const gridBox = await grid(page).boundingBox();
    expect(box!.width).toBeGreaterThan(gridBox!.width * 0.9);
    await page.keyboard.press('Escape');
    await expect(grid(page)).not.toHaveAttribute('data-maximized', '');
    for (const id of ids.slice(0, 4)) await expect(tile(page, id)).toBeVisible();
    await expect(tile(page, ids[0])).not.toHaveAttribute('data-paused', /.+/);

    // f maximises the focused tile and toggles back.
    await tile(page, ids[2]).getByTestId('mv-tile-title').click();
    await page.keyboard.press('f');
    await expect(tile(page, ids[2])).toHaveAttribute('data-maximized', '');
    await expect(tile(page, ids[0])).toBeHidden();
    await page.keyboard.press('f');
    await expect(tile(page, ids[0])).toBeVisible();

    // Double-click on the header.
    await tile(page, ids[3]).getByTestId('mv-tile-title').dblclick();
    await expect(tile(page, ids[3])).toHaveAttribute('data-maximized', '');
    await page.keyboard.press('Escape');
    await expect(tile(page, ids[0])).toBeVisible();
  });

  test('remove takes a tile out and the grid reflows', async ({ page }) => {
    const ids = await withLayouts(page, nLayouts([3]));
    await openLayout(page, 'n3');
    await expect(grid(page)).toHaveAttribute('data-grid', '2x2');
    await tile(page, ids[1]).getByTestId('mv-tile-remove').click();
    await expect(tiles(page)).toHaveCount(2);
    // Focus moves to the next tile instead of falling off the page.
    await expect(tile(page, ids[2])).toBeFocused();
    await expect(tile(page, ids[2])).toHaveAttribute('aria-current', 'true');
    await expect(grid(page)).toHaveAttribute('data-grid', '2x1');
    expect(await tileIds(page)).toEqual([ids[0], ids[2]]);
    await tile(page, ids[0]).getByRole('button', { name: /^Remove .* from the multiviewer$/ }).click();
    await tile(page, ids[2]).getByTestId('mv-tile-remove').click();
    await expect(page.getByTestId('mv-empty')).toBeVisible();
  });

  test('keyboard reorder: Space, arrow, Space on the drag handle moves the tile and announces it', async ({ page }) => {
    const ids = await withLayouts(page, nLayouts([4]));
    await openLayout(page, 'n4');
    expect(await tileIds(page)).toEqual(ids.slice(0, 4));
    const handle = tile(page, ids[0]).getByRole('button', { name: /^Move tile:/ });
    await handle.focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    await page.keyboard.press('Space');
    await expect.poll(() => tileIds(page)).toEqual([ids[1], ids[0], ids[2], ids[3]]);
    await expect(page.locator('[id^="DndLiveRegion"]')).toContainText(/dropped at position 2 of 4/);
    // Still in the multiviewer (arrow keys did not switch runs).
    await expect(page.getByTestId('multiview')).toBeVisible();

    // Down moves to the row below.
    const h2 = tile(page, ids[1]).getByRole('button', { name: /^Move tile:/ });
    await h2.focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    await page.keyboard.press('Space');
    await expect.poll(async () => (await tileIds(page)).indexOf(ids[1])).toBeGreaterThanOrEqual(2);
  });
});

test.describe('saved layouts', () => {
  test('save a layout, reload the page, reopen it', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    const ids = await runIds(page);
    await gotoMultiview(page);
    await expect(page.getByTestId('mv-empty')).toBeVisible();
    // Build a selection with the picker.
    await page.getByRole('button', { name: 'Add runs' }).first().click();
    const input = page.getByRole('combobox', { name: 'Find runs to add' });
    await input.fill('');
    const options = page.getByRole('dialog').getByRole('option');
    await options.nth(0).click();
    await options.nth(1).click();
    await options.nth(2).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
    await expect(tiles(page)).toHaveCount(3);
    const order = await tileIds(page);
    expect(order).toEqual(ids.slice(0, 3));

    await page.getByRole('button', { name: 'Save layout' }).click();
    const name = page.getByRole('textbox', { name: 'Layout name' });
    await expect(name).toBeFocused();
    await name.fill('Morning check');
    await page.getByRole('dialog').getByRole('button', { name: 'Save layout' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Layouts (1)' })).toBeVisible();

    await page.reload();
    await ready(page);
    await gotoMultiview(page);
    await expect(page.getByTestId('mv-empty')).toBeVisible();
    await openLayout(page, 'Morning check');
    expect(await tileIds(page)).toEqual(order);
    await expect(grid(page)).toHaveAttribute('data-grid', '2x2');

    // Delete it again.
    await page.getByRole('button', { name: 'Layouts (1)' }).click();
    await page.getByRole('button', { name: 'Delete layout Morning check' }).click();
    await expect(page.getByRole('dialog')).toContainText('No saved layouts yet');
  });

  test('a layout with a run that no longer exists shows a calm tile, not a crash', async ({ page }) => {
    const ids = await withLayouts(page, (all) => [{ name: 'old', runIds: ['claude-code:gone-for-good', all[0]] }]);
    await openLayout(page, 'old');
    await expect(tiles(page)).toHaveCount(2);
    const gone = tile(page, 'claude-code:gone-for-good');
    await expect(gone).toHaveAttribute('data-missing', '');
    await expect(gone).toContainText('Run no longer available');
    await expect(tile(page, ids[0]).getByTestId('view-activity')).toBeVisible();
    await gone.getByTestId('mv-tile-remove').click();
    await expect(tiles(page)).toHaveCount(1);
  });
});

test.describe('multiviewer performance policy', () => {
  test('low GPU (?battery=1): unfocused tiles show the slow-update badge, the focused one does not', async ({ page }) => {
    const ids = await withLayouts(page, nLayouts([4]), '&battery=1');
    await expect(page.locator('html')).toHaveAttribute('data-low-gpu', '');
    await openLayout(page, 'n4');
    await expect(tile(page, ids[0])).toHaveAttribute('aria-current', 'true');
    await expect(tile(page, ids[0]).getByTestId('mv-slow-badge')).toHaveCount(0);
    for (const id of ids.slice(1, 4)) await expect(tile(page, id).getByTestId('mv-slow-badge')).toHaveText('updates every 3 s');
    await tile(page, ids[2]).getByTestId('mv-tile-title').click();
    await expect(tile(page, ids[2]).getByTestId('mv-slow-badge')).toHaveCount(0);
    await expect(tile(page, ids[0]).getByTestId('mv-slow-badge')).toHaveText('updates every 3 s');
  });

  test('hidden window pauses every tile', async ({ page }) => {
    const ids = await withLayouts(page, nLayouts([3]));
    await openLayout(page, 'n3');
    await page.evaluate(() => window.__armFixture!.setVisible(false));
    for (const id of ids.slice(0, 3)) await expect(tile(page, id)).toHaveAttribute('data-paused', 'hidden');
    await page.evaluate(() => window.__armFixture!.setVisible(true));
    for (const id of ids.slice(0, 3)) await expect(tile(page, id)).not.toHaveAttribute('data-paused', /.+/);
  });

  test('tiles scrolled out of view are paused, and resume when scrolled back', async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 420 });
    const ids = await withLayouts(page, nLayouts([12]));
    await openLayout(page, 'n12');
    await expect(tiles(page)).toHaveCount(12);
    // Rows are at least 170 px high, so the third row starts below the fold.
    await expect(tile(page, ids[11])).toHaveAttribute('data-paused', 'offscreen');
    await expect(tile(page, ids[0])).not.toHaveAttribute('data-paused', /.+/);
    await grid(page).evaluate((g) => (g.scrollTop = g.scrollHeight));
    await expect(tile(page, ids[11])).not.toHaveAttribute('data-paused', /.+/);
    await expect(tile(page, ids[0])).toHaveAttribute('data-paused', 'offscreen');
  });

  /** Times (ms) at which the live call-chip timers in each tile changed, watched for `ms`. */
  async function timerChanges(page: Page, ms: number): Promise<Record<string, number[]>> {
    return page.evaluate(async (wait) => {
      const out: Record<string, number[]> = {};
      const observers = [...document.querySelectorAll<HTMLElement>('[data-testid="mv-tile"]')].map((t) => {
        const id = t.dataset.tileId!;
        out[id] = [];
        const mo = new MutationObserver((recs) => {
          const now = performance.now();
          const timer = recs.some((r) => {
            const el = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement;
            return !!el?.closest('.call-chip__timer');
          });
          // Changes within 300 ms of each other are one refresh (separate tasks on the same boundary).
          const last = out[id][out[id].length - 1];
          if (timer && (last === undefined || now - last > 300)) out[id].push(now);
        });
        mo.observe(t, { subtree: true, childList: true, characterData: true });
        return mo;
      });
      await new Promise((r) => setTimeout(r, wait));
      observers.forEach((o) => o.disconnect());
      return out;
    }, ms);
  }

  async function openRunningLayout(page: Page, extra: string): Promise<string[]> {
    await page.goto(demo(extra));
    await ready(page);
    const running = await runIds(page, 'running');
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [SETTINGS_KEY, JSON.stringify({ layouts: [{ name: 'live', runIds: running }] })] as const);
    await page.reload();
    await ready(page);
    await openLayout(page, 'live');
    await expect(tiles(page)).toHaveCount(running.length);
    await expect(grid(page).locator('.call-chip__timer').first()).toBeVisible();
    return running;
  }

  test('low GPU: unfocused tiles stay frozen between 3 s refreshes, live timers included', async ({ page }) => {
    const running = await openRunningLayout(page, '&battery=1');
    await expect(page.locator('html')).toHaveAttribute('data-low-gpu', '');
    await expect(tile(page, running[0])).toHaveAttribute('aria-current', 'true');
    const changes = await timerChanges(page, 7_000);
    let refreshed = 0;
    for (const id of running.slice(1)) {
      const ts = changes[id];
      if (ts.length) refreshed++;
      // At most one change per 3 s refresh (with slack for a busy machine).
      for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1], `tile ${id} changed at ${ts.map(Math.round)}`).toBeGreaterThan(2_000);
    }
    // ...but they do refresh.
    expect(refreshed).toBeGreaterThan(0);
  });

  test('normal mode: live timers in tiles tick every second (sanity check for the test above)', async ({ page }) => {
    await openRunningLayout(page, '');
    const changes = await timerChanges(page, 4_000);
    const gaps = Object.values(changes).flatMap((ts) => ts.slice(1).map((t, i) => t - ts[i]));
    expect(gaps.some((g) => g < 1_600)).toBe(true);
  });

  test('reduced motion: no running infinite animations in the grid', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/?now=${NOW}`);
    await ready(page);
    const running = await runIds(page, 'running');
    expect(running.length).toBeGreaterThan(0);
    const all = await runIds(page);
    const pick = [...running, ...all.filter((id) => !running.includes(id))].slice(0, 6);
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [SETTINGS_KEY, JSON.stringify({ layouts: [{ name: 'live', runIds: pick }] })] as const);
    await page.reload();
    await ready(page);
    await openLayout(page, 'live');
    await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', '');
    await expect(tiles(page)).toHaveCount(6);
    await expect(grid(page).locator('[data-status="running"]').first()).toBeVisible();
    await page.waitForTimeout(600);
    const infinite = await page.evaluate(() => {
      const g = document.querySelector('[data-testid="mv-grid"]')!;
      return document
        .getAnimations()
        .filter((a) => {
          const target = (a.effect as KeyframeEffect | null)?.target;
          return a.playState === 'running' && a.effect?.getTiming().iterations === Infinity && !!target && g.contains(target);
        })
        .map((a) => (a as CSSAnimation).animationName ?? 'anonymous');
    });
    expect(infinite).toEqual([]);
  });

  test('without reduced motion running tiles do spin (sanity check for the test above)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(demo());
    await ready(page);
    const running = await runIds(page, 'running');
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [SETTINGS_KEY, JSON.stringify({ layouts: [{ name: 'live', runIds: running.slice(0, 2) }] })] as const);
    await page.reload();
    await ready(page);
    await openLayout(page, 'live');
    const n = await page.evaluate(() => {
      const g = document.querySelector('[data-testid="mv-grid"]')!;
      return document
        .getAnimations()
        .filter((a) => {
          const target = (a.effect as KeyframeEffect | null)?.target;
          return a.playState === 'running' && a.effect?.getTiming().iterations === Infinity && !!target && g.contains(target);
        }).length;
    });
    expect(n).toBeGreaterThan(0);
  });
});
