// The sidebar's Recent section: opening a run never reorders it (regression test for the bug where
// clicking a run in Recent moved it to the top), and the "Move updated runs to top" setting.
// Synthetic demo data only; ?live=0 keeps every run's updatedAt fixed.
import { expect, test, type Page } from '@playwright/test';

const NOW = '2026-10-27T15:30:00';
const demo = `/?now=${NOW}&live=0`;

test.describe.configure({ timeout: 90_000 });

const list = (page: Page) => page.getByTestId('run-list');
/** Recent rows have option ids containing "-recent-"; the same run's row in its day section does not. */
const recentRows = (page: Page) => list(page).locator('[role="option"][id*="-recent-"]');
const recentIds = (page: Page) => recentRows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.runId as string));

async function openFromDaySection(page: Page, id: string) {
  await list(page).locator(`[role="option"][data-run-id="${id}"]:not([id*="-recent-"])`).click();
  await expect(page.locator(`.runview[data-run-id="${id}"]`)).toBeVisible();
}

test('clicking a run in Recent never moves it; the setting switches between by-update and fixed order', async ({ page }) => {
  await page.goto(demo);
  await expect(list(page).getByRole('option').first()).toBeVisible();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(recentRows(page)).toHaveCount(0);

  // Runs of the day sections in list order (newest update first); pinned runs never show in Recent.
  const ids: string[] = await list(page)
    .locator('.runlist__vrow')
    .evaluateAll((rows) => {
      let section = '';
      const out: string[] = [];
      for (const r of rows) {
        const head = r.querySelector('.runlist__section');
        if (head) section = head.firstChild?.textContent ?? '';
        const id = (r.querySelector('[role="option"]') as HTMLElement | null)?.dataset.runId;
        if (id && section !== 'Pinned' && section !== 'Recent') out.push(id);
      }
      return out;
    });
  expect(ids.length).toBeGreaterThan(5);
  const [x, y, z] = [ids[4], ids[0], ids[2]];
  for (const id of [x, y, z]) await openFromDaySection(page, id);

  // Default (on): ordered by last update, so y (newest), z, x.
  await expect.poll(() => recentIds(page)).toEqual([y, z, x]);

  // The bug: clicking the bottom Recent row moved it to the top.
  await recentRows(page).last().click();
  await expect(page.locator(`.runview[data-run-id="${x}"]`)).toBeVisible();
  await expect.poll(() => recentIds(page)).toEqual([y, z, x]);
  await recentRows(page).nth(1).click();
  await expect(page.locator(`.runview[data-run-id="${z}"]`)).toBeVisible();
  await expect.poll(() => recentIds(page)).toEqual([y, z, x]);

  // Off: fixed order, newest opened on top; clicking still never reorders.
  await page.keyboard.press('Control+,');
  await expect(page.getByTestId('settings-screen')).toBeVisible();
  const toggle = page.getByTestId('move-updated-to-top').getByRole('switch', { name: 'Move updated runs to top' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('run-title')).toBeVisible();
  await expect.poll(() => recentIds(page)).toEqual([z, y, x]);
  await recentRows(page).last().click();
  await expect(page.locator(`.runview[data-run-id="${x}"]`)).toBeVisible();
  await expect.poll(() => recentIds(page)).toEqual([z, y, x]);

  // A newly opened run appears at the top; the others keep their places.
  const w = ids[1];
  await openFromDaySection(page, w);
  await expect.poll(() => recentIds(page)).toEqual([w, z, y, x]);

  // Both the setting and the Recent list survive a reload.
  await page.reload();
  await expect(list(page).getByRole('option').first()).toBeVisible();
  await expect.poll(() => recentIds(page)).toEqual([w, z, y, x]);
});
