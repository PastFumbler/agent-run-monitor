// Feature 7: the Reasoning view, offered only for runs whose source stored readable reasoning
// (fixture backend, synthetic demo data only).
import { expect, test, type Page } from '@playwright/test';

const NOW = '2026-10-27T15:30:00';
const demo = `/?now=${NOW}&live=0`;
const SETTINGS_KEY = 'arm.fixture.settings.demo';

async function openRun(page: Page, title: RegExp) {
  await page.getByTestId('run-list').getByRole('option', { name: title }).first().click();
  await expect(page.getByTestId('run-title')).toHaveText(title);
}

async function start(page: Page) {
  await page.goto(demo);
  await expect(page.getByTestId('dashboard')).toBeVisible();
}

const reasoningTab = (page: Page) => page.getByRole('radiogroup', { name: 'Run view' }).getByRole('radio', { name: 'Reasoning', exact: true });

test('shows readable reasoning in full for a run that has it, via the tab and key 7', async ({ page }) => {
  await start(page);
  await openRun(page, /Cache forecast responses for ten minutes/);
  await expect(reasoningTab(page)).toBeVisible();
  await reasoningTab(page).click();
  const view = page.getByTestId('view-reasoning');
  await expect(view).toBeVisible();
  const items = view.getByRole('list', { name: 'Reasoning, oldest first' }).getByRole('listitem');
  await expect(items).toHaveCount(5);
  await expect(items.first().locator('.ev__text')).not.toHaveText('');
  await expect(page.getByTestId('reasoning-hidden')).toHaveCount(0);

  // Key 7 opens it from another view.
  await page.getByRole('radio', { name: 'Overview' }).click();
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('7');
  await expect(view).toBeVisible();
});

test('hides the tab for a run whose thinking was stored without text, and falls back to Activity', async ({ page }) => {
  await start(page);
  await openRun(page, /Cache forecast responses for ten minutes/);
  await reasoningTab(page).click();
  await expect(page.getByTestId('view-reasoning')).toBeVisible();

  // This Claude Code run only has thinking stored without its text: no Reasoning tab, Activity instead.
  await openRun(page, /Add a --due flag to the add command/);
  await expect(reasoningTab(page)).toHaveCount(0);
  await expect(page.getByTestId('view-reasoning')).toHaveCount(0);
  await expect(page.getByTestId('view-activity')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Activity' })).toHaveAttribute('aria-checked', 'true');
  // Its placeholder thinking is a plain line in Activity, not an expandable "Reasoning" trace.
  const log = page.getByRole('log', { name: 'Run activity' });
  await expect(log.getByText(/^Thinking \([\d.]+ s, text not stored\)$/).first()).toBeVisible();
  await expect(log.getByRole('button', { name: /^Reasoning step/ })).toHaveCount(0);

  // Key 7 means nothing here.
  await page.getByRole('radio', { name: 'Files' }).click();
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('7');
  await expect(page.getByTestId('view-files')).toBeVisible();

  // The choice comes back on a run that has reasoning.
  await page.getByRole('radio', { name: 'Activity' }).click();
  await page.keyboard.press('7');
  await expect(page.getByTestId('view-activity')).toBeVisible();
  await openRun(page, /Cache forecast responses for ten minutes/);
  await page.keyboard.press('7');
  await expect(page.getByTestId('view-reasoning')).toBeVisible();
});

test('leaves out thinking stored without text and says how much', async ({ page }) => {
  await start(page);
  const id = await page.evaluate(() => window.__armFixture!.runs().find((r) => r.title === 'Sub-agent: check for unused exports')!.id);
  // A sub-run: open it the way a finish notification would.
  await page.evaluate((runId) => window.__armFixture!.openRun(runId), id);
  await expect(page.getByTestId('run-title')).toHaveText(/Sub-agent: check for unused exports/);
  await reasoningTab(page).click();
  const view = page.getByTestId('view-reasoning');
  await expect(view.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByTestId('reasoning-hidden')).toHaveText('1 thinking step was stored without its text and is left out.');
});

test('multiviewer tiles offer Reasoning only for runs that have it', async ({ page }) => {
  await start(page);
  const [withIt, without] = await page.evaluate(() => {
    const runs = window.__armFixture!.runs();
    return [runs.find((r) => r.hasReasoning)!.id, runs.find((r) => !r.hasReasoning && r.status !== 'unreadable')!.id];
  });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [SETTINGS_KEY, JSON.stringify({ layouts: [{ name: 'pair', runIds: [withIt, without] }] })] as const);
  await page.reload();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    await expect(page.getByTestId('multiview')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  const open = page.getByRole('button', { name: 'Open layout pair', exact: true });
  if (!(await open.isVisible())) await page.getByRole('button', { name: /^Layouts/ }).click();
  await open.click();

  const tile = (id: string) => page.getByTestId('mv-grid').locator(`[data-tile-id="${id}"]`);
  await expect(tile(without).getByRole('radio', { name: 'Activity', exact: true })).toBeVisible();
  await expect(tile(without).getByRole('radio', { name: 'Reasoning', exact: true })).toHaveCount(0);
  const radio = tile(withIt).getByRole('radio', { name: 'Reasoning', exact: true });
  await radio.click();
  await expect(radio).toHaveAttribute('aria-checked', 'true');
  await expect(tile(withIt).getByTestId('view-reasoning')).toBeVisible();

  // Key 7 does nothing on the tile without reasoning.
  await tile(without).getByRole('radio', { name: 'Files', exact: true }).click();
  await page.keyboard.press('7');
  await expect(tile(without).getByTestId('view-files')).toBeVisible();
});
