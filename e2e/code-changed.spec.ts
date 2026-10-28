// Feature 6: the run view's Code changed tab (fixture backend, synthetic demo data only).
import { expect, test, type Page } from '@playwright/test';

const NOW = '2026-10-27T15:30:00';
const demo = `/?now=${NOW}&live=0`;

async function openRun(page: Page, title: RegExp) {
  await page.goto(demo);
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await page.getByTestId('run-list').getByRole('option', { name: title }).first().click();
  await expect(page.getByTestId('run-title')).toHaveText(title);
}

test('lists edits in time order with a total, and expands a diff', async ({ page }) => {
  await openRun(page, /Add a --due flag to the add command/);
  await page.getByRole('radio', { name: 'Code changed' }).click();
  const view = page.getByTestId('view-changes');
  await expect(view).toBeVisible();
  await expect(page.getByTestId('changes-total')).toContainText(/\d+ files? \+\d+ lines added −\d+ lines removed in 3 edits/);
  const items = view.getByRole('list', { name: 'Code changes, oldest first' }).getByRole('listitem');
  await expect(items).toHaveCount(3);

  const toggle = items.nth(1).getByRole('button');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const diff = items.nth(1).getByRole('region', { name: /^Diff of / });
  await expect(diff).toBeVisible();
  await expect(diff.locator('.diff__line[data-kind="hunk"]').first()).toHaveText(/^@@/);
  // Added and removed lines keep their +/- marker, so colour is never the only cue.
  for (const l of await diff.locator('.diff__line[data-kind="add"]').allTextContents()) expect(l.startsWith('+')).toBe(true);
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(diff).toHaveCount(0);
});

test('says "unknown" (never 0) when the agent does not record edit content', async ({ page }) => {
  await openRun(page, /Add castling rights to the move generator/);
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('6');
  const view = page.getByTestId('view-changes');
  await expect(page.getByTestId('changes-total')).toContainText('Line counts not recorded');
  await expect(page.getByTestId('changes-total')).not.toContainText('+0');
  await expect(view.getByText('Lines unknown')).toHaveCount(3);
  await expect(view.getByText('No diff recorded')).toHaveCount(3);
  await expect(view.getByRole('button', { expanded: false })).toHaveCount(0);
});

test('a run without edits says so', async ({ page }) => {
  await openRun(page, /Implement flood fill with a tolerance slider/);
  await page.getByRole('radio', { name: 'Code changed' }).click();
  await expect(page.getByTestId('view-changes')).toContainText("This run hasn't changed any code.");
});
