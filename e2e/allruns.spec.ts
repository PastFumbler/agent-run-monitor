// End-to-end tests of the run list viewer ("All runs") against the fixture backend (synthetic demo data).
import { expect, test, type Page } from '@playwright/test';

const NOW = '2026-10-27T15:30:00'; // a Tuesday
const demo = (extra = '') => `/?now=${NOW}&live=0${extra}`;

test.use({ locale: 'en-US' });

let pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
});
test.afterEach(() => {
  expect(pageErrors, 'console errors in the page').toEqual([]);
});

async function openAllRuns(page: Page) {
  await page.goto(demo());
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await page.getByTestId('open-all-runs').click();
  await expect(page.getByTestId('all-runs')).toBeVisible();
}

const groupNames = (page: Page) => page.locator('.allruns__group-title').evaluateAll((els) => els.map((e) => e.firstChild?.textContent));
const rows = (page: Page) => page.getByTestId('all-runs').locator('.allruns__row');
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('arm.fixture.settings.demo') ?? '{}'));

test.describe('run list viewer', () => {
  test('lists every run grouped by start time, full width, with each run’s folder', async ({ page }) => {
    await openAllRuns(page);
    await expect(page.getByRole('heading', { level: 1, name: /All runs/ })).toBeVisible();
    await expect(page.getByTestId('allruns-count')).toHaveText('40 runs');
    await expect(rows(page)).toHaveCount(40);
    // The sidebar is hidden on this screen.
    await expect(page.getByRole('complementary', { name: 'Runs' })).toHaveCount(0);
    // Tuesday: no "This week" beyond today and yesterday; older demo runs fall in their month.
    expect(await groupNames(page)).toEqual(['Today', 'Yesterday', 'Earlier this month', 'September 2026', 'August 2026']);
    // Folder names from the demo folders; everything else is Unfiled.
    const weather = rows(page).filter({ hasText: 'weather-api' }).first();
    await expect(weather.getByTestId('run-folder')).toHaveText('Client work');
    const todo = rows(page).filter({ hasText: 'todo-cli' }).first();
    await expect(todo.getByTestId('run-folder')).toHaveText('Unfiled');
    // Esc goes back to the dashboard it was opened from.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByTestId('all-runs')).toHaveCount(0);
  });

  test('click toggles, Shift-click selects a range, a group box selects the group, then Move to folder', async ({ page }) => {
    await openAllRuns(page);
    const today = page.locator('[data-group="today"] .allruns__row');
    const n = await today.count();
    expect(n).toBeGreaterThan(4);
    const selected = page.getByTestId('allruns-selected');
    await expect(selected).toHaveText('No runs selected');
    await expect(page.getByTestId('allruns-move')).toBeDisabled();

    // A click on the row (not only the box) toggles it.
    await today.nth(0).locator('.allruns__main').click();
    await expect(today.nth(0).getByRole('checkbox')).toBeChecked();
    await expect(selected).toHaveText('1 selected');
    await today.nth(0).getByRole('checkbox').click();
    await expect(today.nth(0).getByRole('checkbox')).not.toBeChecked();
    await expect(selected).toHaveText('No runs selected');

    // Click one, Shift-click another: everything between is selected.
    await today.nth(1).getByRole('checkbox').click();
    await today.nth(4).locator('.allruns__main').click({ modifiers: ['Shift'] });
    await expect(selected).toHaveText('4 selected');
    for (const i of [1, 2, 3, 4]) await expect(today.nth(i).getByRole('checkbox')).toBeChecked();
    await expect(today.nth(0).getByRole('checkbox')).not.toBeChecked();

    // The group's box is mixed now; ticking it selects the whole group.
    const groupBox = page.getByRole('checkbox', { name: 'Select all runs in Today' });
    await expect(groupBox).toHaveAttribute('aria-checked', 'mixed');
    await groupBox.click();
    await expect(selected).toHaveText(`${n} selected`);
    await groupBox.click();
    await expect(selected).toHaveText('No runs selected');

    // Move three runs to "Someday".
    await today.nth(0).getByRole('checkbox').click();
    await today.nth(2).getByRole('checkbox').click({ modifiers: ['Shift'] });
    const ids = await today.evaluateAll((els) => els.slice(0, 3).map((e) => e.getAttribute('data-run-id')));
    await page.getByTestId('allruns-move').click();
    const dialog = page.getByRole('dialog', { name: 'Move 3 runs to a folder' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Move to Unfiled' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Move to Someday' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('allruns-message')).toHaveText('Moved 3 runs to Someday.');
    await expect(selected).toHaveText('No runs selected');
    for (const i of [0, 1, 2]) await expect(today.nth(i).getByTestId('run-folder')).toHaveText('Someday');
    const s = await saved(page);
    for (const id of ids) expect(s.runFolders[id!]).toBe('f_demo_later');

    // The folder filter shows just those runs.
    await page.getByLabel('Folder', { exact: true }).selectOption({ label: 'Someday (3)' });
    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByTestId('allruns-count')).toHaveText('3 of 40 runs');

    // Back to Unfiled.
    await page.getByRole('button', { name: 'Select all' }).click();
    await page.getByTestId('allruns-move').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Move to Unfiled' }).click();
    await expect(page.getByTestId('allruns-message')).toHaveText('Moved 3 runs to Unfiled.');
    await expect(page.getByText('No runs match these filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(rows(page)).toHaveCount(40);
  });

  test('creates a folder and moves runs into it from the dialog; the status filter narrows the list', async ({ page }) => {
    await openAllRuns(page);
    // Status filter (what the dashboard's "See all" links use).
    await page.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: /^Failed/ }).click();
    const failed = await rows(page).count();
    expect(failed).toBeGreaterThan(0);
    await expect(rows(page).locator('.status-text')).toHaveText(Array(failed).fill('Failed'));

    await rows(page).first().getByRole('checkbox').click();
    await page.getByTestId('allruns-move').click();
    const dialog = page.getByRole('dialog', { name: 'Move 1 run to a folder' });
    await dialog.getByLabel('New folder').fill('  Papers  ');
    await dialog.getByRole('button', { name: 'Create and move' }).click();
    await expect(page.getByTestId('allruns-message')).toHaveText('Moved 1 run to Papers.');
    await expect(rows(page).first().getByTestId('run-folder')).toHaveText('Papers');
    const s = await saved(page);
    expect(s.folders.map((f: { name: string }) => f.name)).toContain('Papers');

    // A clashing name is refused with the reason; nothing moves.
    await rows(page).nth(1).getByRole('checkbox').click();
    await page.getByTestId('allruns-move').click();
    const again = page.getByRole('dialog', { name: 'Move 1 run to a folder' });
    await again.getByLabel('New folder').fill('papers');
    await again.getByRole('button', { name: 'Create and move' }).click();
    await expect(again.getByRole('alert')).toHaveText('There is already a folder called "Papers".');
    await page.keyboard.press('Escape');
    await expect(again).toHaveCount(0);
    // Esc closed only the dialog.
    await expect(page.getByTestId('all-runs')).toBeVisible();
  });

  test('Open shows the run; the palette and "g a" lead here; run keys do nothing here', async ({ page }) => {
    await openAllRuns(page);
    const first = rows(page).first();
    const title = (await first.locator('.runrow__title').textContent())!;
    // ← / → would step through the hidden sidebar list: not on this screen.
    await page.locator('body').press('ArrowRight');
    await expect(page.getByTestId('all-runs')).toBeVisible();
    await first.getByRole('button', { name: `Open ${title}` }).click();
    await expect(page.getByTestId('run-title')).toHaveText(title);

    await page.keyboard.press('Control+K');
    await page.keyboard.type('show all runs');
    await page.getByRole('option', { name: /Show all runs/ }).click();
    await expect(page.getByTestId('all-runs')).toBeVisible();
    await page.getByRole('button', { name: 'Back to run' }).click();
    await expect(page.getByTestId('run-title')).toBeVisible();

    await page.locator('body').press('g');
    await page.locator('body').press('a');
    await expect(page.getByTestId('all-runs')).toBeVisible();
    // Settings from here returns here.
    await page.keyboard.press('Control+,');
    await expect(page.getByTestId('settings-screen')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('all-runs')).toBeVisible();
  });

  test('the sidebar search keeps its focus behaviour around All runs', async ({ page }) => {
    await page.goto(demo());
    const search = page.getByRole('searchbox', { name: 'Search runs' });
    // "/" focuses the search; after leaving it, coming back from All runs must not steal focus again.
    await page.locator('body').press('/');
    await expect(search).toBeFocused();
    await search.press('Escape');
    await page.getByTestId('open-all-runs').click();
    await page.locator('body').press('/'); // does nothing here (the sidebar is hidden)
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(search).not.toBeFocused();
    // The palette's "Search runs in the sidebar" from All runs goes back and focuses it.
    await page.getByTestId('open-all-runs').click();
    await page.keyboard.press('Control+K');
    await page.keyboard.type('search runs in the sidebar');
    await page.getByRole('option', { name: /Search runs in the sidebar/ }).click();
    await expect(search).toBeFocused();
  });
});
