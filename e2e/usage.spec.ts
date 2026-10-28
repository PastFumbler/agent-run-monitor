// End-to-end tests of the Usage screen against the fixture backend (synthetic demo data).
import { expect, test, type Page } from '@playwright/test';

const NOW = '2026-10-27T15:30:00';
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

async function openUsage(page: Page) {
  await page.goto(demo());
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await page.getByTestId('open-usage').click();
  await expect(page.getByTestId('usage')).toBeVisible();
}

const range = (page: Page, label: string) => page.getByRole('radiogroup', { name: 'Time range' }).getByRole('radio', { name: label });

/** All-time totals per agent from the fixture's runs ("-" when no run of that agent reported usage). */
function expectedAllTime(page: Page) {
  return page.evaluate(() => {
    const out: Record<string, { runs: number; total: string }> = {};
    for (const r of window.__armFixture!.runs()) {
      const a = (out[r.agent] ??= { runs: 0, total: '-' });
      a.runs++;
      const u = r.usage;
      if (!u) continue;
      const n = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      a.total = String((a.total === '-' ? 0 : Number(a.total.replace(/,/g, ''))) + n);
    }
    for (const a of Object.values(out)) if (a.total !== '-') a.total = Number(a.total).toLocaleString('en-US');
    return out;
  });
}

test('opens from the sidebar, g then u, and the palette; Esc goes back, and Settings returns to it', async ({ page }) => {
  await openUsage(page);
  await expect(page.getByTestId('open-usage')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('dashboard')).toBeVisible();

  await page.keyboard.press('g');
  await page.keyboard.press('u');
  await expect(page.getByTestId('usage')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('dashboard')).toBeVisible();

  await page.keyboard.press('Control+k');
  await page.keyboard.type('token usage');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('usage')).toBeVisible();

  // Settings opened from Usage goes back there.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByTestId('usage')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('usage')).toBeVisible();

  // All runs opened from Usage goes back there, and the next Esc goes home rather than back to All runs.
  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page.getByTestId('all-runs')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to usage' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('usage')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('dashboard')).toBeVisible();
});

test('shows each agent’s totals for all time, says "Not reported" for agents that record none, and no costs', async ({ page }) => {
  await openUsage(page);
  await range(page, 'All time').click();
  await expect(range(page, 'All time')).toHaveAttribute('aria-checked', 'true');
  const expected = await expectedAllTime(page);
  const table = page.getByTestId('usage-agents');
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(Object.keys(expected).length);
  for (const [agent, e] of Object.entries(expected)) {
    const row = table.locator(`tbody tr[data-agent="${agent}"]`);
    await expect(row.locator('td').first()).toHaveText(new RegExp(`^${e.runs}`));
    if (e.total === '-') await expect(row).toContainText('Not reported');
    else await expect(row.locator('td').nth(1)).toHaveText(e.total);
  }
  // The demo's Cursor runs record no tokens; Codex records no cache writes.
  await expect(table.locator('tbody tr[data-agent="cursor"]')).toContainText('Not reported');
  await expect(table.locator('tbody tr[data-agent="codex"] td').last()).toHaveText('Not reported');
  await expect(page.getByTestId('usage')).not.toContainText(/\$|cost|price/i);
  await expect(page.getByTestId('usage-history-note')).toBeVisible();
});

test('the range selector narrows the runs to those active in it', async ({ page }) => {
  await openUsage(page);
  const counts = await page.evaluate((now) => {
    const t = new Date(now);
    t.setHours(0, 0, 0, 0);
    const today = t.getTime();
    const runs = window.__armFixture!.runs();
    return { today: runs.filter((r) => r.updatedAt >= today).length, all: runs.length };
  }, NOW);
  await range(page, 'Today').click();
  await expect(page.getByTestId('usage-count')).toHaveText(`${counts.today} runs today`);
  await expect(page.getByTestId('usage-runs').locator('tbody tr')).toHaveCount(counts.today);
  await range(page, 'All time').click();
  await expect(page.getByTestId('usage-count')).toHaveText(`${counts.all} runs`);
  await expect(page.getByTestId('usage-runs').locator('tbody tr')).toHaveCount(counts.all);
});

test('the run list sorts by a column with unreported runs last, and opens a run on click', async ({ page }) => {
  await openUsage(page);
  await range(page, 'All time').click();
  const table = page.getByTestId('usage-runs');
  const values = () =>
    table.locator('tbody tr').evaluateAll((trs) =>
      trs.map((tr) => {
        const cells = [...tr.querySelectorAll('td')].slice(2).map((td) => td.textContent ?? '');
        // Columns: Total, Input, Output, Cache read, Cache write (one "Not reported" cell when nothing was).
        const out = cells.length === 1 ? cells[0] : cells[2];
        return out === 'Not reported' ? null : Number(out.replace(/,/g, ''));
      }),
    );

  const output = table.getByRole('button', { name: /^Output/ });
  await output.click();
  await expect(table.locator('th[aria-sort="descending"]')).toContainText('Output');
  let v = await values();
  let known = v.filter((x): x is number => x !== null);
  expect(known.length).toBeGreaterThan(0);
  expect(v.slice(known.length).every((x) => x === null)).toBe(true);
  expect(known).toEqual([...known].sort((a, b) => b - a));

  await output.click();
  await expect(table.locator('th[aria-sort="ascending"]')).toContainText('Output');
  v = await values();
  known = v.filter((x): x is number => x !== null);
  expect(v.slice(known.length).every((x) => x === null)).toBe(true);
  expect(known).toEqual([...known].sort((a, b) => a - b));

  const first = table.locator('tbody tr').first();
  const id = await first.getAttribute('data-run-id');
  await first.locator('.usage__run').click();
  await expect(page.locator(`.runview[data-run-id="${id}"]`)).toBeVisible();
});
