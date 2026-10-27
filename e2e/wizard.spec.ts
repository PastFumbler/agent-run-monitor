// End-to-end test of the first-run wizard against the fixture backend (?scenario=firstrun). The main
// walk-through uses the keyboard only: Tab to move, Enter/Space to press, arrow keys in radio groups.
import { expect, test, type Locator, type Page } from '@playwright/test';

const NOW = '2026-10-27T15:30:00';
const FIRST = `/?scenario=firstrun&now=${NOW}&live=0`;

// Any console error or uncaught exception in the page fails the test.
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

/** Presses Tab until `target` has focus (keyboard only, no clicks). */
async function tabTo(page: Page, target: Locator, max = 120) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Could not reach ${String(target)} with Tab`);
}

async function next(page: Page) {
  const btn = page.getByRole('button', { name: 'Next', exact: true });
  await tabTo(page, btn);
  await page.keyboard.press('Enter');
}

test.describe('first-run wizard', () => {
  // Long keyboard walks; generous time so a busy machine does not fail them.
  test.describe.configure({ timeout: 150_000 });

  test('keyboard-only walk-through: switch a source off, add a folder, pick a theme, land on a run', async ({ page }) => {
    await page.goto(FIRST);
    const wizard = page.getByTestId('wizard');
    await expect(wizard).toBeVisible();
    // No sidebar while setting up.
    await expect(page.getByRole('complementary', { name: 'Runs' })).toHaveCount(0);

    // 1. Welcome, with the privacy promise.
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Agent Run Monitor' })).toBeFocused();
    await expect(page.getByTestId('wizard-step')).toHaveText('Step 1 of 4');
    const promise = page.getByRole('list', { name: 'Our privacy promise' });
    await expect(promise.getByRole('listitem')).toHaveCount(3);
    await expect(promise).toContainText('Read-only');
    await expect(promise).toContainText('Nothing leaves your computer');
    await expect(promise).toContainText('Secrets are masked on screen');
    await expect(page.getByRole('list', { name: 'Setup steps' }).locator('[aria-current="step"]')).toContainText('Welcome');
    await next(page);

    // 2. Detection.
    await expect(page.getByRole('heading', { level: 1, name: 'Find your agents' })).toBeFocused();
    await expect(page.getByTestId('wizard-step')).toHaveText('Step 2 of 4');
    await expect(page.getByTestId('wizard-summary')).toHaveText(/^We found 40 runs from \d+ agents\.$/);
    await expect(page.locator('.wiz-source[data-found="yes"]').first()).toContainText(/\d+ runs?/);
    // The demo has runs for every agent, so "not found" rows are covered by Wizard.test.tsx; check any shown here too.
    const missing = page.locator('.wiz-source[data-found="no"]');
    for (let i = 0; i < (await missing.count()); i++) {
      await expect(missing.nth(i)).toContainText('It would be at');
      await expect(missing.nth(i)).toContainText('Nothing there yet');
    }
    await expect(page.getByRole('heading', { name: /Aider keeps its history inside each project/ })).toBeVisible();

    const codexRuns = await page.evaluate(() => window.__armFixture!.runs().filter((r) => r.agent === 'codex').length);
    const watchCodex = page.getByRole('switch', { name: 'Watch Codex' });
    await expect(watchCodex).toHaveAttribute('aria-checked', 'true');
    await tabTo(page, watchCodex);
    await page.keyboard.press('Space');
    await expect(watchCodex).toHaveAttribute('aria-checked', 'false');

    const addFolder = page.getByRole('button', { name: 'Add a folder for Gemini CLI' });
    await tabTo(page, addFolder);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('list', { name: 'Extra folders for Gemini CLI' })).toContainText('/home/demo/code/another-project');

    // Back and forth keeps what was chosen.
    const back = page.getByRole('button', { name: 'Back', exact: true });
    await tabTo(page, back);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('wizard-step')).toHaveText('Step 1 of 4');
    await next(page);
    await expect(page.getByRole('switch', { name: 'Watch Codex' })).toHaveAttribute('aria-checked', 'false');
    await next(page);

    // 3. Look & feel: arrow keys through the theme radios apply each theme live.
    await expect(page.getByRole('heading', { level: 1, name: 'Look & feel' })).toBeFocused();
    await expect(page.getByRole('switch', { name: /^Synonyms instead of/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Totally fake progress bar' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('group', { name: 'Reduce motion' })).toBeVisible();
    await tabTo(page, page.getByRole('radio', { name: 'Paper, light' }));
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sage');
    await next(page);

    // 4. Done.
    await expect(page.getByTestId('wizard-step')).toHaveText('Step 4 of 4');
    await expect(page.getByRole('heading', { level: 1, name: "You're all set" })).toBeFocused();
    const open = page.getByRole('button', { name: 'Open my latest run' });
    await tabTo(page, open);
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('wizard')).toHaveCount(0);
    await expect(page.getByTestId('run-title')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Runs' })).toBeVisible();
    const statusbar = page.getByRole('contentinfo', { name: 'Status bar' });
    await expect(statusbar).toContainText(`${40 - codexRuns} runs`);
    // It opened the newest run from a source that is still on.
    const expected = await page.evaluate(() => {
      const runs = window.__armFixture!.runs().filter((r) => r.agent !== 'codex');
      runs.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
      return runs[0].title;
    });
    await expect(page.getByTestId('run-title')).toHaveText(expected);

    // The wizard does not come back after a reload, and the choices stuck.
    await page.reload();
    await expect(page.getByTestId('run-title')).toBeVisible();
    await expect(page.getByTestId('wizard')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sage');
    await expect(statusbar).toContainText(`${40 - codexRuns} runs`);
  });

  test('Skip setup jumps to the end; leaving the guide half-way shows it again next time', async ({ page }) => {
    await page.goto(FIRST);
    await expect(page.getByTestId('wizard')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('wizard')).toBeVisible();
    await page.getByRole('button', { name: 'Skip setup' }).click();
    await expect(page.getByTestId('wizard-step')).toHaveText('Step 4 of 4');
    await page.getByRole('button', { name: 'Open my latest run' }).click();
    await expect(page.getByTestId('run-title')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('run-title')).toBeVisible();
    await expect(page.getByTestId('wizard')).toHaveCount(0);
  });

  test('with no runs, the last step explains where runs come from', async ({ page }) => {
    await page.goto(FIRST);
    await expect(page.getByTestId('wizard')).toBeVisible();
    // Switch every source off: nothing is left to show.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByTestId('wizard-summary')).toContainText('We found');
    const switches = page.getByRole('switch', { name: /^Watch / });
    const n = await switches.count();
    for (let i = 0; i < n; i++) await switches.nth(i).click();
    await expect(page.getByRole('contentinfo', { name: 'Status bar' })).toContainText(/(?<!\d)0 runs/);
    await page.getByRole('button', { name: 'Skip setup' }).click();
    await expect(page.getByTestId('wizard-done-empty')).toContainText(
      'Start a session in any supported agent and it appears here within seconds',
    );
    await page.getByRole('button', { name: 'Start watching' }).click();
    await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible();
  });

  test('reduced motion: steps change with no movement', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(FIRST);
    await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', '');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    const step = page.locator('.wizard__step');
    await expect(step).toHaveAttribute('data-step', 'detect');
    // No transform or fading in flight right after the change.
    const style = await step.evaluate((el) => ({ t: getComputedStyle(el).transform, o: getComputedStyle(el).opacity }));
    expect(style.t === 'none' || style.t === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
    expect(style.o).toBe('1');
  });

  test('low GPU (on battery): steps change with a plain fade, no sliding', async ({ page }) => {
    await page.goto(`${FIRST}&battery=1`);
    await expect(page.locator('html')).toHaveAttribute('data-low-gpu', '');
    await expect(page.locator('html')).not.toHaveAttribute('data-reduce-motion');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    const step = page.locator('.wizard__step');
    await expect(step).toHaveAttribute('data-step', 'detect');
    const t = await step.evaluate((el) => getComputedStyle(el).transform);
    expect(t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
    await expect(step).toHaveCSS('opacity', '1');
  });
});
