// Settings > Customisation against the fixture backend (synthetic demo data only): the Simple display
// tier, the recent-ordering toggle's new home, and the custom theme editor with its live contrast check.
import { expect, test, type Page } from '@playwright/test';

const NOW = '2026-10-27T15:30:00';
const demo = (extra = '') => `/?now=${NOW}&live=0${extra}`;

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

const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('arm.fixture.settings.demo') ?? '{}'));
const cssVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

async function gotoCustomisation(page: Page) {
  await page.goto(demo());
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await page.keyboard.press('Control+,');
  await expect(page.getByTestId('settings-screen')).toBeVisible();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Customisation' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Customisation' })).toBeFocused();
}

test.describe('customisation', () => {
  test.describe.configure({ timeout: 120_000 });

  test('Simple display shows only running runs in one large line each; Esc reaches Settings', async ({ page }) => {
    await page.goto(demo());
    await expect(page.getByTestId('dashboard')).toBeVisible();
    const running = Number(await page.locator('.dashboard__section[data-status="running"]').getByTestId('dashboard-count').textContent());
    expect(running).toBeGreaterThan(0);

    await page.keyboard.press('Control+,');
    const section = page.locator('#settings-customisation');
    await section.getByRole('radio', { name: 'Simple' }).check();
    await expect.poll(() => saved(page).then((s) => s.displayTier)).toBe('simple');
    // The recent-ordering toggle moved here from Runs & refresh.
    await expect(section.getByTestId('move-updated-to-top')).toBeVisible();
    await expect(page.locator('#settings-runs').getByTestId('move-updated-to-top')).toHaveCount(0);

    // Leaving Settings shows the board: no sidebar, no status bar, running runs only.
    await page.keyboard.press('Escape');
    const board = page.getByTestId('simple-board');
    await expect(board).toBeVisible();
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await expect(page.locator('.statusbar')).toHaveCount(0);
    await expect(board.getByTestId('simple-count')).toHaveText(String(running));
    const lines = board.getByTestId('simple-line');
    await expect(lines).toHaveCount(running);
    await expect(lines.first()).toHaveText(/^Working on “.+”(, now .+)?\.$/);
    // Large text: much bigger than the body text.
    const size = await lines.first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(22);

    // Run keys do nothing on the board; Esc opens Settings, and Esc there comes back.
    await page.keyboard.press('ArrowRight');
    await expect(board).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-screen')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(board).toBeVisible();

    // The board survives a reload, and its own button goes back to the full app.
    await page.reload();
    await expect(page.getByTestId('simple-board')).toBeVisible();
    await page.getByRole('button', { name: 'Show the full app' }).click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect.poll(() => saved(page).then((s) => s.displayTier)).toBe('default');
  });

  test('Simple display says so calmly when nothing is running', async ({ page }) => {
    await page.goto(demo('&scenario=empty'));
    await page.evaluate(() => {
      const key = 'arm.fixture.settings.empty';
      const s = JSON.parse(localStorage.getItem(key) ?? '{}');
      localStorage.setItem(key, JSON.stringify({ ...s, firstRunComplete: true, displayTier: 'simple' }));
    });
    await page.reload();
    await expect(page.getByTestId('simple-empty')).toHaveText('Nothing is running right now.');
  });

  test('custom theme: live contrast check names failing pairs, saves with a warning, never as a preset', async ({ page }) => {
    await gotoCustomisation(page);
    const card = page.getByTestId('custom-theme');
    await expect(card.getByTestId('custom-theme-state')).toHaveText('No custom theme yet.');

    // "Customise…" next to the presets opens the editor here, starting from the theme in use (Paper).
    await page.locator('#settings-appearance').getByTestId('theme-customise').click();
    const editor = page.getByTestId('custom-theme-editor');
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel('Background', { exact: true })).toHaveValue('#f4f2ec');
    await expect(editor.getByLabel('Text', { exact: true })).toHaveValue('#26241f');
    const checks = page.getByTestId('custom-theme-checks');
    await expect(checks).toHaveAttribute('data-problems', '0');
    await expect(checks).toContainText('Contrast check passes.');

    // Pale text fails against every surface; two alike status colours are named too.
    await editor.getByLabel('Text', { exact: true }).fill('#c8c4ba');
    await editor.getByLabel('Stuck', { exact: true }).fill('#3788c7');
    const problems = page.getByTestId('custom-theme-problems');
    await expect(problems).toContainText('Text on background:');
    await expect(problems).toContainText('needs 4.5:1');
    await expect(problems).toContainText('Running and Stuck look too alike');
    await expect(checks).toContainText('You can still save it');

    // Saving a failing theme is allowed, with a visible warning; it's applied to the whole app.
    await page.getByTestId('custom-theme-save').click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByTestId('custom-theme-warning')).toContainText('Contrast warning');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom');
    await expect.poll(() => cssVar(page, '--text')).toBe('#c8c4ba');
    const s = await saved(page);
    expect(s.useCustomTheme).toBe(true);
    expect(s.customTheme.text).toBe('#c8c4ba');
    expect(s.theme).toBe('paper');

    // In Appearance it's one more card next to the presets, selected, with its warning.
    const picker = page.locator('#settings-appearance').getByTestId('theme-picker');
    await expect(picker.getByRole('radio', { name: 'Custom, light' })).toBeChecked();
    await expect(picker.locator('[data-theme-id="custom"]')).toContainText('contrast warning');

    // Picking a preset switches back (the custom theme stays saved), and the palette lists it apart from the presets.
    await picker.getByRole('radio', { name: 'Dusk, dark' }).check({ force: true });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk');
    await expect.poll(() => cssVar(page, '--text')).not.toBe('#c8c4ba');
    await expect(card.getByTestId('custom-theme-state')).toHaveText('Your custom theme is saved but not in use.');
    await card.getByRole('button', { name: 'Use it' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom');

    // Survives a reload.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom');
    await expect.poll(() => cssVar(page, '--text')).toBe('#c8c4ba');

    // Removing it goes back to the preset.
    await page.keyboard.press('Control+,');
    const card2 = page.getByTestId('custom-theme');
    await card2.getByRole('button', { name: 'Remove' }).click();
    await card2.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByTestId('custom-theme-message')).toHaveText('Removed. Back to Dusk.');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk');
    expect((await saved(page)).customTheme).toBeNull();

    // Esc inside the editor cancels it (Settings stays open) and focus returns to "Customise…".
    await card2.getByTestId('custom-theme-open').click();
    await page.getByTestId('custom-theme-editor').getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('custom-theme-editor')).toHaveCount(0);
    await expect(page.getByTestId('settings-screen')).toBeVisible();
    await expect(card2.getByTestId('custom-theme-open')).toBeFocused();
  });
});
