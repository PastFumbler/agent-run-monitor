// Adding a custom folder that holds no sessions explains which folder to pick (Settings > Sources and
// the wizard), and the wizard's Done step counts what detection found. Fixture backend: its folder
// picker always answers /home/demo/code/another-project, which holds no sessions of any agent.
import { expect, test } from '@playwright/test';

const NOW = '2026-10-27T15:30:00';

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

test('settings: a folder with no sessions says which folder to pick', async ({ page }) => {
  await page.goto(`/?now=${NOW}&live=0&fresh=1`);
  await expect(page.getByTestId('run-list').getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Control+,');
  await expect(page.getByTestId('settings-screen')).toBeVisible();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Sources' }).click();
  const card = page.locator('.source[data-agent="claude-code"]');
  await card.getByRole('button', { name: 'Add folder for Claude Code' }).click();
  await expect(card.getByRole('list', { name: 'Extra folders for Claude Code' })).toContainText('/home/demo/code/another-project');
  await expect(card.getByTestId('folder-check')).toHaveText(
    'No Claude Code sessions found in this folder. Pick the folder that contains the .claude folder or its projects folder.',
  );
  // Removing the folder clears the hint.
  await card.getByRole('button', { name: 'Remove /home/demo/code/another-project' }).click();
  await expect(card.getByTestId('folder-check')).toHaveText('');
});

test('wizard: the hint in step 2, and the Done step counts what detection found', async ({ page }) => {
  await page.goto(`/?scenario=firstrun&now=${NOW}&live=0&fresh=1`);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByTestId('wizard-summary')).toContainText(/We found [\d,]+ runs?/);
  const found = Number((await page.getByTestId('wizard-summary').textContent())!.match(/We found ([\d,]+) run/)![1].replace(/,/g, ''));
  const row = page.locator('.wiz-source[data-agent="codex"]');
  await row.getByRole('button', { name: 'Add a folder for Codex' }).click();
  await expect(row.getByTestId('folder-check')).toHaveText(
    'No Codex sessions found in this folder. Pick the folder that contains the .codex folder or its sessions folder.',
  );
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  // Every demo source is on, and the fixture reads everything at once: the count is the list.
  await expect(page.getByTestId('wizard-done-count')).toHaveText(`Watching ${found} runs.`);
});
