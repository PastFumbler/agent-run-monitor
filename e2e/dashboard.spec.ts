// End-to-end tests of the dashboard (the home screen) against the fixture backend (synthetic demo data).
import { expect, test, type Page } from '@playwright/test';

const NOW = '2026-10-27T15:30:00';
const demo = (extra = '') => `/?now=${NOW}&live=0${extra}`;
const STATUSES = ['running', 'waiting', 'idle', 'done', 'failed', 'stuck', 'unreadable'];

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

async function home(page: Page, extra = '') {
  await page.goto(demo(extra));
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('run-list').getByRole('option').first()).toBeVisible();
}

const section = (page: Page, status: string) => page.locator(`.dashboard__section[data-status="${status}"]`);
const shownIds = (page: Page, status: string) =>
  section(page, status)
    .locator('.dashboard__run')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.runId));

/** What each section should show: the fixture's runs of that status (optionally of some agents), newest first. */
function expected(page: Page, agents: string[] = []) {
  return page.evaluate(
    ({ statuses, agents }) => {
      const runs = window.__armFixture!.runs();
      return Object.fromEntries(
        statuses.map((s) => {
          const all = runs.filter((r) => r.status === s);
          const mine = all
            .filter((r) => !agents.length || agents.includes(r.agent))
            .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
          return [s, { ids: mine.slice(0, 3).map((r) => r.id), matching: mine.length, total: all.length }];
        }),
      );
    },
    { statuses: STATUSES, agents },
  );
}

test.describe('dashboard', () => {
  test('is the home screen: one section per status, the 3 most recent each, calm when empty', async ({ page }) => {
    await home(page);
    await expect(page.getByRole('heading', { level: 1, name: /Dashboard/ })).toBeVisible();
    await expect(page.getByTestId('dashboard-total')).toHaveText('40 runs');
    // The sidebar stays, and its Dashboard button shows where you are.
    await expect(page.getByRole('complementary', { name: 'Runs' })).toBeVisible();
    await expect(page.getByTestId('open-dashboard')).toHaveAttribute('aria-pressed', 'true');
    // Nothing is opened (or counted as recent) on start.
    await expect(page.getByTestId('run-title')).toHaveCount(0);

    expect(await page.locator('.dashboard__section').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.status))).toEqual(STATUSES);
    const want = await expected(page);
    let empty = 0;
    for (const s of STATUSES) {
      const sec = section(page, s);
      expect(await shownIds(page, s), s).toEqual(want[s].ids);
      await expect(sec.getByTestId('dashboard-count')).toHaveText(String(want[s].matching));
      if (want[s].total) {
        await expect(sec.getByTestId('dashboard-see-all')).toHaveText(`See all (${want[s].total})`);
      } else {
        empty++;
        await expect(sec.locator('.dashboard__calm')).not.toBeEmpty();
        await expect(sec.getByTestId('dashboard-see-all')).toHaveCount(0);
      }
    }
    // The demo has several runs in the main states.
    for (const s of ['running', 'done', 'failed']) expect(want[s].ids.length, s).toBeGreaterThan(0);
    expect(empty).toBeLessThan(STATUSES.length);
  });

  test('the agent filter applies to every section; "See all" still counts every agent', async ({ page }) => {
    await home(page);
    const chips = page.getByRole('group', { name: 'Filter the dashboard by agent' });
    const codex = chips.getByRole('button', { name: /^Codex, \d+ runs?$/ });
    await codex.click();
    await expect(codex).toHaveAttribute('aria-pressed', 'true');
    const want = await expected(page, ['codex']);
    let calm = 0;
    for (const s of STATUSES) {
      expect(await shownIds(page, s), s).toEqual(want[s].ids);
      await expect(section(page, s).getByTestId('dashboard-count')).toHaveText(String(want[s].matching));
      if (!want[s].matching) {
        calm++;
        // Empty for this agent: a short calm line, while "See all" still leads to that status's runs.
        await expect(section(page, s).locator('.dashboard__calm')).toBeVisible();
      }
    }
    expect(calm, 'some sections have no Codex runs').toBeGreaterThan(0);
    const rows = page.locator('.dashboard__run');
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await expect(rows.nth(i).locator('.runrow__meta')).toContainText('Codex');
    const total = Object.values(want).reduce((k, w) => k + w.matching, 0);
    await expect(page.getByTestId('dashboard-total')).toHaveText(`${total} of 40 runs`);
    const done = section(page, 'done').getByTestId('dashboard-see-all');
    await expect(done).toContainText('every agent');
    await expect(done).toHaveAccessibleName(/from every agent/);
    // The dashboard's filter is its own: the sidebar's chips are untouched.
    await expect(page.getByTestId('run-list').getByRole('option').first()).toBeVisible();
    // It survives a trip to a run and back.
    await page.locator('.dashboard__run').first().click();
    await expect(page.getByTestId('run-title')).toBeVisible();
    await page.getByTestId('open-dashboard').click();
    await expect(codex).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Show every agent' }).click();
    await expect(codex).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('dashboard-total')).toHaveText('40 runs');
  });

  test('clicking a run opens it; g d, the palette and the sidebar button come back', async ({ page }) => {
    await home(page);
    const first = section(page, 'failed').locator('.dashboard__run').first();
    const title = (await first.locator('.runrow__title').textContent())!;
    await first.click();
    await expect(page.getByTestId('run-title')).toHaveText(title);
    await expect(page.getByTestId('dashboard')).toHaveCount(0);

    await page.locator('body').press('g');
    await page.locator('body').press('d');
    await expect(page.getByTestId('dashboard')).toBeVisible();

    // Keyboard: rows are buttons in the tab order.
    const row = section(page, 'running').locator('.dashboard__run').first();
    const runTitle = (await row.locator('.runrow__title').textContent())!;
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('run-title')).toHaveText(runTitle);

    await page.keyboard.press('Control+K');
    await page.keyboard.type('show the dashboard');
    await page.getByRole('option', { name: /Show the dashboard/ }).click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
  });

  test('"See all (n)" opens All runs filtered to that status, and Esc comes back', async ({ page }) => {
    await home(page);
    const want = await expected(page);
    await section(page, 'done').getByTestId('dashboard-see-all').click();
    await expect(page.getByTestId('all-runs')).toBeVisible();
    await expect(page.getByTestId('allruns-count')).toHaveText(`${want.done.total} of 40 runs`);
    await expect(page.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: /^Done, / })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('all-runs').locator('.allruns__row')).toHaveCount(want.done.total);
    await expect(page.getByRole('button', { name: 'Back to dashboard' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dashboard')).toBeVisible();
  });

  test('updates live: a new running run goes to the top of Running', async ({ page }) => {
    await home(page);
    const id = await page.evaluate(() =>
      window.__armFixture!.addRun({ agent: 'aider', status: 'running', projectName: 'todo-cli', title: 'Brand new demo run' }),
    );
    await expect.poll(() => shownIds(page, 'running').then((ids) => ids[0])).toBe(id);
    await expect(section(page, 'running').locator('.dashboard__run').first()).toContainText('Brand new demo run');
  });

  test('empty scenario: a calm explanation instead of sections', async ({ page }) => {
    await page.goto(`/?scenario=empty&now=${NOW}`);
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible();
    await expect(page.locator('.dashboard__section')).toHaveCount(0);
  });
});
