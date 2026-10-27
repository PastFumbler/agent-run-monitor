// End-to-end tests of the settings screen against the fixture backend (synthetic demo data only).
// Every control is checked for its effect on the app, and settings are checked to survive a reload.
import { expect, test, type Page } from '@playwright/test';
import { RELEASES_URL } from '../src/shared/project';

const NOW = '2026-10-27T15:30:00';
const demo = (extra = '') => `/?now=${NOW}&live=0${extra}`;

// Clock times are formatted with the browser locale; pin it so 12-hour times read "3:30 PM".
test.use({ locale: 'en-US' });

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

async function ready(page: Page) {
  await expect(page.getByTestId('run-list').getByRole('option').first()).toBeVisible();
  await expect(page.getByTestId('dashboard')).toBeVisible();
}

async function openSettings(page: Page) {
  await page.keyboard.press('Control+,');
  await expect(page.getByTestId('settings-screen')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeFocused();
}

async function gotoSettings(page: Page, extra = '') {
  await page.goto(demo(extra));
  await ready(page);
  await openSettings(page);
}

const group = (page: Page, name: string) => page.getByRole('group', { name, exact: true });
const sw = (page: Page, name: string | RegExp) => page.getByRole('switch', { name });
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('arm.fixture.settings.demo') ?? '{}'));

test.describe('settings screen', () => {
  test.describe.configure({ timeout: 150_000 });

  test('Ctrl+, opens it, the section nav jumps, Esc and Back return to where you were', async ({ page }) => {
    await gotoSettings(page);
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav.getByRole('button', { name: 'Sources' })).toHaveAttribute('aria-current', 'true');
    await nav.getByRole('button', { name: 'About' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'About' })).toBeFocused();
    await expect(nav.getByRole('button', { name: 'About' })).toHaveAttribute('aria-current', 'true');
    // Run-navigation keys inside the form don't leave the screen.
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('settings-screen')).toBeVisible();
    // Opened from the dashboard (the home screen), so Esc goes back there.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByTestId('settings-screen')).toHaveCount(0);
    // Focus lands on the main area, not lost on <body>.
    await expect(page.locator('#main')).toBeFocused();
    // From a run, Back returns to that run; the sidebar's Settings button toggles back too.
    await page.getByTestId('run-list').getByRole('option').first().click();
    await expect(page.getByTestId('run-title')).toBeVisible();
    await openSettings(page);
    await page.getByRole('button', { name: 'Back to runs' }).click();
    await expect(page.getByTestId('run-title')).toBeVisible();
    await page.getByTestId('open-dashboard').click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByTestId('settings-screen')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
  });

  test('appearance: theme, text size and density apply live', async ({ page }) => {
    await gotoSettings(page);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'paper');
    const themes = group(page, 'Theme');
    await expect(themes.getByRole('radio')).toHaveCount(6);
    for (const name of ['Paper, light', 'Sage, light', 'Dawn, light', 'Dusk, dark', 'Moss, dark', 'Harbor, dark'])
      await expect(themes.getByRole('radio', { name })).toHaveCount(1);
    await themes.getByRole('radio', { name: 'Harbor, dark' }).check();
    await expect(html).toHaveAttribute('data-theme', 'harbor');
    await expect(html).toHaveAttribute('data-scheme', 'dark');
    // Keyboard: arrow keys move through the theme radios and apply each one.
    await page.keyboard.press('ArrowLeft');
    await expect(html).toHaveAttribute('data-theme', 'moss');

    await group(page, 'Text size').getByRole('radio', { name: 'Large' }).check();
    await expect(html).toHaveAttribute('data-text-size', 'large');
    expect(await html.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    await group(page, 'Text size').getByRole('radio', { name: 'Small' }).check();
    await expect(html).toHaveAttribute('data-text-size', 'small');

    await group(page, 'Density').getByRole('radio', { name: 'Compact' }).check();
    await expect(html).toHaveAttribute('data-density', 'compact');
    await group(page, 'Density').getByRole('radio', { name: 'Comfortable' }).check();
    await expect(html).toHaveAttribute('data-density', 'comfortable');
  });

  test('time format changes the times in the run list', async ({ page }) => {
    await gotoSettings(page);
    const times = page.getByTestId('run-list').locator('.runrow__time');
    const clock = /\b\d{1,2}:\d{2}\b/;
    const fmt = group(page, 'Time format');

    await fmt.getByRole('radio', { name: '12-hour' }).check();
    await expect(times.filter({ hasText: /\b(AM|PM)\b/ }).first()).toBeVisible();

    await fmt.getByRole('radio', { name: '24-hour' }).check();
    await expect(times.filter({ hasText: /\b(AM|PM)\b/ })).toHaveCount(0);
    await expect(times.filter({ hasText: clock }).first()).toBeVisible();

    await fmt.getByRole('radio', { name: 'Relative' }).check();
    await expect(times.filter({ hasText: clock })).toHaveCount(0);
    await expect(times.filter({ hasText: /ago|yesterday/ }).first()).toBeVisible();
  });

  test('fun: synonyms and the fake progress bar switch off', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    await page.getByTestId('run-list').locator('[role="option"][data-status="running"]').first().click();
    await expect(page.getByTestId('status-synonym')).toBeVisible();
    await expect(page.getByTestId('fake-progress')).toBeVisible();

    await openSettings(page);
    const synonyms = sw(page, /^Synonyms instead of/);
    await expect(synonyms).toHaveAttribute('aria-checked', 'true');
    await synonyms.click();
    await expect(synonyms).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('status-synonym')).toHaveCount(0);
    await expect(page.getByTestId('status-word')).toHaveText('Running');
    await expect(page.getByTestId('fake-progress')).toBeVisible();

    await openSettings(page);
    const fake = sw(page, 'Totally fake progress bar');
    await expect(fake).toHaveAttribute('aria-checked', 'true');
    // Keyboard: Space toggles a focused switch.
    await fake.focus();
    await page.keyboard.press('Space');
    await expect(fake).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('fake-progress')).toHaveCount(0);
  });

  test('motion & performance: low GPU and reduce motion are separate and set their attributes', async ({ page }) => {
    await gotoSettings(page);
    const html = page.locator('html');
    const low = group(page, 'Low GPU usage mode');
    const reduce = group(page, 'Reduce motion');
    await expect(low.getByRole('radio', { name: 'Auto' })).toBeChecked();
    await expect(reduce.getByRole('radio', { name: 'Auto' })).toBeChecked();
    await expect(low).toContainText('turns on when running on battery');
    await expect(reduce).toContainText('follows your system');
    await expect(page.getByTestId('low-gpu-state')).toHaveText("Low GPU mode is currently OFF because you're plugged in.");
    await expect(html).not.toHaveAttribute('data-low-gpu');

    await low.getByRole('radio', { name: 'On' }).check();
    await expect(html).toHaveAttribute('data-low-gpu', '');
    await expect(page.getByTestId('low-gpu-state')).toHaveText('Low GPU mode is currently ON because you turned it on.');
    // Low GPU: only opacity/transform transitions here (the switch colour change becomes instant).
    expect(await page.locator('.switch__track').first().evaluate((el) => getComputedStyle(el).transitionProperty)).toBe('opacity, transform');
    // Low GPU does not reduce motion: they are separate.
    await expect(html).not.toHaveAttribute('data-reduce-motion');
    await low.getByRole('radio', { name: 'Off' }).check();
    await expect(html).not.toHaveAttribute('data-low-gpu');

    await reduce.getByRole('radio', { name: 'On' }).check();
    await expect(html).toHaveAttribute('data-reduce-motion', '');
    await expect(page.getByTestId('reduce-motion-state')).toContainText('reduced because you turned this on');
    await expect(html).not.toHaveAttribute('data-low-gpu');
    await reduce.getByRole('radio', { name: 'Off' }).check();
    await expect(html).not.toHaveAttribute('data-reduce-motion');
    await expect(page.getByTestId('reduce-motion-state')).toContainText('currently on');
  });

  test('low GPU Auto explains that it is on because of battery power', async ({ page }) => {
    await gotoSettings(page, '&battery=1');
    await expect(page.locator('html')).toHaveAttribute('data-low-gpu', '');
    await expect(page.getByTestId('low-gpu-state')).toHaveText("Low GPU mode is currently ON because you're on battery.");
    await expect(page.getByTestId('low-gpu-state').locator('..')).toContainText("energy-saver mode detection isn't available");
  });

  test('sources: switching an agent off removes its runs', async ({ page }) => {
    await gotoSettings(page);
    const statusbar = page.getByRole('contentinfo', { name: 'Status bar' });
    await expect(statusbar).toContainText('40 runs');
    const codexRuns = await page.evaluate(() => window.__armFixture!.runs().filter((r) => r.agent === 'codex').length);
    expect(codexRuns).toBeGreaterThan(0);

    const codex = page.locator('.source[data-agent="codex"]');
    await expect(codex).toContainText(`${codexRuns} run`);
    await expect(codex.locator('.confidence')).toBeVisible();
    await expect(codex).toContainText(/Verified on a real install|Checked against the tool's source code|Best effort — experimental/);
    await expect(codex.getByRole('list', { name: 'Default places for Codex' })).toContainText(/Found|Not there/);

    const watch = sw(page, 'Watch Codex');
    await expect(watch).toHaveAttribute('aria-checked', 'true');
    await watch.click();
    await expect(watch).toHaveAttribute('aria-checked', 'false');
    await expect(statusbar).toContainText(`${40 - codexRuns} runs`);
    await expect(page.getByRole('button', { name: /^Codex, \d+ runs?$/ })).toHaveCount(0);
    const metas = await page.getByTestId('run-list').locator('.runrow__meta').allTextContents();
    expect(metas.length).toBeGreaterThan(0);
    expect(metas.some((t) => t.includes('Codex'))).toBe(false);
    await watch.click();
    await expect(statusbar).toContainText('40 runs');
  });

  test('sources: extra folders and project folders can be added and removed; Rescan', async ({ page }) => {
    await gotoSettings(page);
    await page.getByRole('button', { name: 'Add folder for Codex' }).click();
    const extra = page.getByRole('list', { name: 'Extra folders for Codex' });
    await expect(extra).toContainText('/home/demo/code/another-project');
    await extra.getByRole('button', { name: 'Remove /home/demo/code/another-project' }).click();
    await expect(extra).toHaveCount(0);

    await page.getByRole('button', { name: 'Add project folder' }).click();
    const projects = page.getByRole('list', { name: 'Project folders' });
    await expect(projects).toContainText('/home/demo/code/another-project');
    expect((await saved(page)).projectRoots).toEqual(['/home/demo/code/another-project']);
    await projects.getByRole('button', { name: /^Remove / }).click();
    await expect(projects).toHaveCount(0);

    await page.getByRole('button', { name: 'Rescan' }).click();
    await expect(page.getByText('Rescan finished: the list below is up to date.')).toBeVisible();
  });

  test('folders: create, rename and delete; deleting unfiles runs and keeps them', async ({ page }) => {
    await gotoSettings(page);
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Folders' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Folders' })).toBeFocused();
    const list = page.getByRole('list', { name: 'Run folders' });
    const message = page.getByTestId('folders-message');
    // The demo's made-up folders, with how many runs each holds.
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list.getByRole('listitem').filter({ hasText: 'Someday' })).toContainText('0 runs');
    const runsBefore = await page.getByTestId('run-list').getByRole('option').count();

    // Create (Enter submits); a duplicate name is refused in plain words.
    const input = page.getByRole('textbox', { name: 'New folder name' });
    await input.fill('  Research  ');
    await input.press('Enter');
    await expect(message).toHaveText('Created "Research".');
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await expect(input).toHaveValue('');
    await input.fill('research');
    await page.getByRole('button', { name: 'Create folder' }).click();
    await expect(message).toHaveText('There is already a folder called "Research".');
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await input.fill('');

    // Rename: Esc cancels without leaving settings; Enter saves.
    await page.getByRole('button', { name: 'Rename Research' }).click();
    const rename = page.getByRole('textbox', { name: 'New name for Research' });
    await expect(rename).toBeFocused();
    await rename.press('Escape');
    await expect(page.getByTestId('settings-screen')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rename Research' })).toBeFocused();
    await page.getByRole('button', { name: 'Rename Research' }).click();
    await rename.fill('Papers');
    await rename.press('Enter');
    await expect(message).toHaveText('Renamed to "Papers".');
    await expect(list).toContainText('Papers');

    // Delete a folder that holds runs: confirm inline; its runs go back to Unfiled, none disappear.
    const work = list.getByRole('listitem').filter({ hasText: 'Client work' });
    const workCount = Number((await work.textContent())?.match(/(\d+) runs?/)?.[1]);
    expect(workCount).toBeGreaterThan(0);
    const filedBefore = Object.keys((await saved(page)).runFolders ?? {}).length;
    await page.getByRole('button', { name: 'Delete Client work' }).click();
    const confirm = page.getByRole('group', { name: 'Delete Client work?' });
    await expect(confirm).toContainText(`Its ${workCount} runs go back to Unfiled.`);
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete Client work' })).toBeFocused();
    await page.getByRole('button', { name: 'Delete Client work' }).click();
    await confirm.getByRole('button', { name: 'Delete folder' }).click();
    await expect(message).toHaveText('Deleted "Client work". Its runs are unfiled.');
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(page.getByTestId('run-list').getByRole('option')).toHaveCount(runsBefore);

    // Saved in the app's settings and still there after a reload.
    const s = await saved(page);
    expect(s.folders.map((f: { name: string }) => f.name)).toEqual(['Side projects', 'Someday', 'Papers']);
    expect(Object.keys(s.runFolders).length).toBe(filedBefore - workCount);
    await page.reload();
    await ready(page);
    await openSettings(page);
    await expect(page.getByRole('list', { name: 'Run folders' }).getByRole('listitem')).toHaveCount(3);
    await expect(page.getByRole('list', { name: 'Run folders' })).toContainText('Papers');
  });

  test('runs, notifications, system and privacy settings save and apply', async ({ page }) => {
    await gotoSettings(page);
    await group(page, 'Refresh rate').getByRole('radio', { name: 'Every 5 s' }).check();
    await group(page, 'How far back to show runs').getByRole('radio', { name: '30 days' }).check();
    await group(page, 'Default run view').getByRole('radio', { name: 'Files' }).check();
    await page.getByLabel('Tiles per page in the multiviewer').selectOption('4');
    await sw(page, 'When a run finishes').click();
    await sw(page, 'When a run fails').click();
    await sw(page, 'Start with the operating system').click();
    await sw(page, 'Mask likely secrets').click();
    await expect.poll(() => saved(page)).toMatchObject({
      refreshMs: 5000,
      historyDays: 30,
      defaultView: 'files',
      gridTileLimit: 4,
      notifyOnFinish: false,
      notifyOnFailure: false,
      startWithOs: true,
      maskSecrets: false,
    });
    // The default view applies at once (Back returns to the dashboard; open a run)...
    await page.getByRole('button', { name: 'Back to runs' }).click();
    await page.getByTestId('run-list').getByRole('option').first().click();
    await expect(page.getByTestId('view-files')).toBeVisible();
    // ...and after a restart.
    await page.reload();
    await ready(page);
    await page.getByTestId('run-list').getByRole('option').first().click();
    await expect(page.getByTestId('view-files')).toBeVisible();
    await openSettings(page);
    await expect(group(page, 'Refresh rate').getByRole('radio', { name: 'Every 5 s' })).toBeChecked();
    await expect(group(page, 'How far back to show runs').getByRole('radio', { name: '30 days' })).toBeChecked();
    await expect(page.getByLabel('Tiles per page in the multiviewer')).toHaveValue('4');
    await expect(sw(page, 'When a run finishes')).toHaveAttribute('aria-checked', 'false');
    await expect(sw(page, 'Start with the operating system')).toHaveAttribute('aria-checked', 'true');
    await expect(sw(page, 'Mask likely secrets')).toHaveAttribute('aria-checked', 'false');
  });

  test('privacy: update checks are off by default and Check now works only when on', async ({ page }) => {
    await gotoSettings(page);
    await expect(page.getByTestId('privacy-statement')).toContainText('Read-only');
    await expect(page.getByTestId('privacy-statement')).toContainText('Local-only');
    await expect(page.getByTestId('privacy-statement')).toContainText('No telemetry');
    const updates = sw(page, 'Check for updates');
    await expect(updates).toHaveAttribute('aria-checked', 'false');
    await expect(sw(page, 'Mask likely secrets')).toHaveAttribute('aria-checked', 'true');
    const check = page.getByRole('button', { name: 'Check now' });
    await expect(check).toBeDisabled();
    await updates.click();
    await expect(check).toBeEnabled();
    await check.click();
    await expect(page.getByTestId('update-result')).toContainText('Update checks are off in the demo');
  });

  test('about: version, settings file, project link, licences and the first-run guide', async ({ page }) => {
    await gotoSettings(page);
    await expect(page.getByTestId('about-version')).toHaveText('0.1.0-demo');
    await expect(page.getByTestId('about-settings-path')).toContainText('browser demo');
    await expect(page.getByTestId('about-releases')).toHaveAttribute('href', RELEASES_URL);
    await expect(page.locator('#settings-about')).toContainText('React Bits (MIT + Commons Clause)');
    await expect(page.locator('#settings-about')).toContainText('THIRD_PARTY_NOTICES.md');
    await page.getByRole('button', { name: 'Show first-run guide again' }).click();
    await expect(page.getByTestId('wizard')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Agent Run Monitor' })).toBeVisible();
  });

  test('settings persist across a reload', async ({ page }) => {
    await gotoSettings(page);
    await group(page, 'Theme').getByRole('radio', { name: 'Moss, dark' }).check();
    await group(page, 'Text size').getByRole('radio', { name: 'Small' }).check();
    await group(page, 'Density').getByRole('radio', { name: 'Compact' }).check();
    await group(page, 'Time format').getByRole('radio', { name: '12-hour' }).check();
    await group(page, 'Reduce motion').getByRole('radio', { name: 'On' }).check();
    await sw(page, /^Synonyms instead of/).click();
    await sw(page, 'Watch Codex').click();
    await expect.poll(async () => (await saved(page)).sources?.codex?.enabled).toBe(false);

    await page.reload();
    await ready(page);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'moss');
    await expect(html).toHaveAttribute('data-text-size', 'small');
    await expect(html).toHaveAttribute('data-density', 'compact');
    await expect(html).toHaveAttribute('data-reduce-motion', '');
    await expect(page.getByTestId('run-list').locator('.runrow__time').filter({ hasText: /\b(AM|PM)\b/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Codex, \d+ runs?$/ })).toHaveCount(0);
    await openSettings(page);
    await expect(sw(page, /^Synonyms instead of/)).toHaveAttribute('aria-checked', 'false');
    await expect(sw(page, 'Watch Codex')).toHaveAttribute('aria-checked', 'false');
    await expect(group(page, 'Theme').getByRole('radio', { name: 'Moss, dark' })).toBeChecked();
  });
});
