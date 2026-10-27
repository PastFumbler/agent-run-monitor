// The run list keeps the GPU quiet: only the open run's row animates its status mark and lattice
// loader; every other running row is drawn still (same distinct shapes). The single run view then
// runs a handful of infinite animations instead of one or two per running row.
import { expect, test, type Page } from '@playwright/test';

const NOW = '2026-10-27T15:30:00';

interface Census {
  total: number;
  inList: number;
  inSelectedRow: number;
  names: string[];
}

/** Running infinite animations, split by where they are. */
function census(page: Page): Promise<Census> {
  return page.evaluate(() => {
    const list = document.querySelector('[data-testid="run-list"]');
    const anims = document
      .getAnimations()
      .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity);
    const targetOf = (a: Animation) => (a.effect as KeyframeEffect | null)?.target as Element | null | undefined;
    const inList = anims.filter((a) => {
      const t = targetOf(a);
      return !!t && !!list && list.contains(t);
    });
    const inSelected = inList.filter((a) => targetOf(a)?.closest('[role="option"]')?.getAttribute('aria-selected') === 'true');
    return {
      total: anims.length,
      inList: inList.length,
      inSelectedRow: inSelected.length,
      names: anims.map((a) => (a as CSSAnimation).animationName ?? 'anonymous'),
    };
  });
}

async function openFirstRunning(page: Page) {
  const list = page.getByTestId('run-list');
  await expect(list.getByRole('option').first()).toBeVisible();
  const row = list.locator('[role="option"][data-status="running"]').first();
  await row.click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('run-title')).toBeVisible();
}

for (const scenario of ['demo', 'many'] as const) {
  test(`single run view (${scenario}): only the open run's row animates in the list`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`/?now=${NOW}&scenario=${scenario}&live=0`);
    await openFirstRunning(page);
    await expect(page.locator('html')).not.toHaveAttribute('data-low-gpu', '');
    const runningRows = await page.getByTestId('run-list').locator('[role="option"][data-status="running"]').count();
    expect(runningRows, 'the demo shows several running rows').toBeGreaterThan(1);
    await page.waitForTimeout(400);
    const c = await census(page);
    test.info().annotations.push({ type: 'infinite animations', description: `${scenario}: ${c.total} (${c.names.join(', ')}); running rows ${runningRows}` });
    // Every animation in the list belongs to the open run's row (its spinner and lattice cells), and
    // only one copy of it animates (the open run may also be listed under Recent).
    expect(c.inList - c.inSelectedRow).toBe(0);
    expect(c.inSelectedRow).toBeGreaterThan(0);
    expect(c.inSelectedRow).toBeLessThanOrEqual(10);
    // The whole window: the open row (1 spin + 8 lattice cells), the run header's spinner and the open
    // run's own views (thought line). Before, every running row added a spin and 8 lattice cells.
    console.log(`${scenario}: ${c.total} infinite animations (${c.inList} in the list); ${runningRows} running rows`);
    expect(c.total).toBeLessThanOrEqual(14);
  });
}

test('the running rows that are not open keep their distinct still shapes', async ({ page }) => {
  await page.goto(`/?now=${NOW}&live=0`);
  await openFirstRunning(page);
  const others = page.getByTestId('run-list').locator('[role="option"][data-status="running"][aria-selected="false"]');
  await expect(others.first()).toBeVisible();
  const mark = others.first().locator('.status-mark');
  await expect(mark).toHaveAttribute('data-shape', 'arc');
  await expect(mark).not.toHaveAttribute('data-spin', '');
  // Opening another run moves the motion with it.
  const id = await others.first().getAttribute('data-run-id');
  const next = page.getByTestId('run-list').locator(`[role="option"][data-run-id="${id}"]`).last();
  await next.click();
  await expect(next).toHaveAttribute('aria-selected', 'true');
  await expect(next.locator('.status-mark')).toHaveAttribute('data-spin', '');
});
