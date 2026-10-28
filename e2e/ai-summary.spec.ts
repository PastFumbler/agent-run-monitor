// Feature 9: the summary at the top of Overview. Local by default (no network); the optional AI
// summary is off until the user confirms a plain warning and saves a key. The fixture backend never
// calls a provider: it answers with a made-up summary (synthetic demo data only).
import { expect, test, type Page } from '@playwright/test';

const NOW = '2026-10-27T15:30:00';
const demo = (extra = '') => `/?now=${NOW}&live=0${extra}`;
const RUN = /Add a --due flag to the add command/;
// Assembled at runtime so no realistic-looking key is ever committed.
const KEY = ['sk', 'ant', 'demo', 'x'.repeat(24)].join('-');

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

async function ready(page: Page) {
  await expect(page.getByTestId('run-list').getByRole('option').first()).toBeVisible();
  await expect(page.getByTestId('dashboard')).toBeVisible();
}

async function openOverview(page: Page) {
  await page.getByTestId('run-list').getByRole('option', { name: RUN }).first().click();
  await expect(page.getByTestId('run-title')).toHaveText(RUN);
  await page.getByRole('radio', { name: 'Overview' }).click();
  await expect(page.getByTestId('view-overview')).toBeVisible();
}

async function openAiSettings(page: Page) {
  await page.keyboard.press('Control+,');
  await expect(page.getByTestId('settings-screen')).toBeVisible();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI summary' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'AI summary' })).toBeFocused();
}

const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('arm.fixture.settings.demo') ?? '{}'));
const aiSwitch = (page: Page) => page.getByRole('switch', { name: 'Use AI summaries' });

test.describe('Overview summary', () => {
  test('starts with a summary built locally, and asks no one while AI summaries are off', async ({ page }) => {
    await page.goto(demo('&fresh=1'));
    await ready(page);
    await openOverview(page);
    const box = page.getByTestId('overview-summary');
    await expect(box).toHaveAttribute('data-source', 'local');
    await expect(box.getByRole('heading', { level: 2, name: 'Summary' })).toBeVisible();
    await expect(page.getByTestId('overview-summary-source')).toHaveText('Built on this computer');
    await expect(page.getByTestId('overview-summary-text')).toHaveText(/^Working on “Add a --due flag to the add command”.*\. .+\.$/);
    await expect(page.getByTestId('overview-summary-note')).toHaveCount(0);
    // It sits at the top of Overview, above the status card.
    const first = page.getByTestId('view-overview').locator(':scope > *').first();
    await expect(first).toHaveAttribute('data-testid', 'overview-summary');
  });

  test('AI summaries: a warning before turning on, a key, then the provider summary; the key never reaches the page', async ({ page }) => {
    await page.goto(demo('&fresh=1'));
    await ready(page);
    await openAiSettings(page);
    await expect(aiSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('privacy-statement')).toContainText('Nothing is uploaded.');

    // Turning it on asks first; Esc cancels without leaving settings.
    await aiSwitch(page).click();
    const confirm = page.getByTestId('ai-confirm');
    await expect(confirm).toContainText('Run content will be sent to Anthropic.');
    await expect(confirm).toContainText('masked first');
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId('settings-screen')).toBeVisible();
    await expect(aiSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(aiSwitch(page)).toBeFocused();

    await aiSwitch(page).click();
    await expect(page.getByRole('button', { name: 'Send run content to Anthropic' })).toBeFocused();
    await page.getByRole('button', { name: 'Send run content to Anthropic' }).click();
    await expect(aiSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect(aiSwitch(page)).toBeFocused();
    await expect(page.getByTestId('ai-on')).toContainText('Save a key for Anthropic above first.');
    await expect(page.getByTestId('privacy-statement')).toContainText('Local-only, except AI summaries');
    expect((await saved(page)).aiSummaries).toBe(true);

    // Without a key, Overview keeps the local summary and says why.
    await page.keyboard.press('Escape');
    await ready(page);
    await openOverview(page);
    await expect(page.getByTestId('overview-summary-note')).toContainText('No AI summary: No Anthropic API key is saved.');
    await expect(page.getByTestId('overview-summary')).toHaveAttribute('data-source', 'local');

    // Save a key; the field clears and only "saved" comes back.
    await openAiSettings(page);
    await expect(page.getByTestId('ai-key-state')).toContainText('No key for Anthropic is saved.');
    await page.getByLabel('Anthropic API key').fill(KEY);
    await page.getByRole('button', { name: 'Save key' }).click();
    await expect(page.getByTestId('ai-message')).toHaveText('Anthropic key saved.');
    await expect(page.getByLabel('Anthropic API key')).toHaveValue('');
    await expect(page.getByTestId('ai-key-state')).toContainText('A key for Anthropic is saved');

    await page.keyboard.press('Escape');
    await page.getByRole('radio', { name: 'Overview' }).click();
    const box = page.getByTestId('overview-summary');
    await expect(box).toHaveAttribute('data-source', 'ai');
    await expect(page.getByTestId('overview-summary-source')).toHaveText(/^AI summary from Anthropic \(claude-haiku-5-5\)/);
    await expect(page.getByTestId('overview-summary-text')).toContainText('In todo-cli, the agent took on “Add a --due flag to the add command”');
    await expect(page.getByTestId('overview-summary-note')).toBeEmpty();

    expect(await page.content()).not.toContain(KEY);
    expect(JSON.stringify(await saved(page))).not.toContain(KEY);
  });

  test('changing the provider turns AI summaries off until confirmed again, and resets the model', async ({ page }) => {
    await page.goto(demo('&fresh=1'));
    await ready(page);
    await openAiSettings(page);
    await page.getByLabel('Model').fill('claude-custom-1');
    await page.getByRole('button', { name: 'Save model' }).click();
    await expect(page.getByTestId('ai-message')).toHaveText('Model set to claude-custom-1.');
    await aiSwitch(page).click();
    await page.getByRole('button', { name: 'Send run content to Anthropic' }).click();
    await expect(aiSwitch(page)).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('group', { name: 'Provider' }).getByRole('radio', { name: 'OpenAI' }).check();
    await expect(aiSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByLabel('Model')).toHaveValue('');
    await expect(page.getByLabel('Model')).toHaveAttribute('placeholder', 'gpt-4o-mini');
    await expect(page.getByLabel('OpenAI API key')).toBeVisible();
    expect(await saved(page)).toMatchObject({ aiSummaries: false, aiProvider: 'openai', aiModel: '' });

    await aiSwitch(page).click();
    await expect(page.getByTestId('ai-confirm')).toContainText('Run content will be sent to OpenAI.');
  });
});
