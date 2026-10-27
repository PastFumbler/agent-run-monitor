// End-to-end tests of the renderer against the fixture backend (synthetic demo data only).
// Most tests use ?live=0 so the list order is stable; the live tests drive window.__armFixture.
import { expect, test, type Page } from '@playwright/test';

const NOW = '2026-10-27T15:30:00';
const demo = (extra = '') => `/?now=${NOW}&live=0${extra}`;

async function ready(page: Page) {
  await expect(page.getByTestId('run-list').getByRole('option').first()).toBeVisible();
  await expect(page.getByTestId('run-title')).toBeVisible();
}

async function openRun(page: Page, title: RegExp) {
  await page.getByTestId('run-list').getByRole('option', { name: title }).first().click();
  await expect(page.getByTestId('run-title')).toHaveText(title);
}

test.describe('demo scenario', () => {
  test('loads the run list, a run and the status bar', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    await expect(page.getByRole('contentinfo', { name: 'Status bar' })).toContainText('40 runs');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    // Sections are shown.
    await expect(page.getByTestId('run-list')).toContainText('Pinned');
    await expect(page.getByTestId('run-list')).toContainText('Today');
    // Every row shows a status word next to its mark (never colour alone).
    const first = page.getByTestId('run-list').getByRole('option').first();
    await expect(first.locator('.runrow__status')).not.toBeEmpty();
  });

  test('filters by agent chip and status chip', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    const list = page.getByTestId('run-list');
    const codex = page.getByRole('button', { name: /^Codex, \d+ runs?$/ });
    await codex.click();
    await expect(codex).toHaveAttribute('aria-pressed', 'true');
    const options = list.getByRole('option');
    const n = await options.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await expect(options.nth(i).locator('.runrow__meta')).toContainText('Codex');

    const failed = page.getByRole('button', { name: /^Failed, \d+ runs?$/ });
    await failed.click();
    await expect(failed).toHaveAttribute('aria-pressed', 'true');
    const m = await options.count();
    expect(m).toBeGreaterThan(0);
    for (let i = 0; i < m; i++) {
      await expect(options.nth(i)).toHaveAttribute('data-status', 'failed');
      await expect(options.nth(i).locator('.runrow__meta')).toContainText('Codex');
    }
    await page.getByRole('button', { name: /Clear filters/ }).click();
    await expect(codex).toHaveAttribute('aria-pressed', 'false');
  });

  test('← and → move between runs in list order', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    const title = page.getByTestId('run-title');
    const start = await title.textContent();
    await page.keyboard.press('ArrowRight');
    await expect(title).not.toHaveText(start ?? '');
    const second = await title.textContent();
    await page.keyboard.press('ArrowLeft');
    await expect(title).toHaveText(start ?? '');
    await page.keyboard.press(']');
    await expect(title).toHaveText(second ?? '');
    // The arrow buttons are labelled and carry their shortcut in the tooltip.
    await expect(page.getByRole('button', { name: 'Previous run' })).toHaveAttribute('title', /←/);
    await expect(page.getByRole('button', { name: 'Next run' })).toHaveAttribute('title', /→/);
  });

  test('Ctrl+K palette finds a run by project and status', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    await page.keyboard.press('Control+K');
    const input = page.getByRole('combobox', { name: 'Search runs and commands' });
    await expect(input).toBeFocused();
    await input.fill('weather failed');
    await expect(page.getByText('Looking for: Failed · "weather"')).toBeVisible();
    const item = page.locator('[cmdk-item]').first();
    await expect(item).toContainText('Cache forecast responses for ten minutes');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('run-title')).toHaveText('Cache forecast responses for ten minutes');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('palette understands "codex failed yesterday"', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    await page.keyboard.press('Control+K');
    await page.getByRole('combobox', { name: 'Search runs and commands' }).fill('codex failed yesterday');
    const items = page.locator('[cmdk-group-heading]:has-text("Runs") ~ [cmdk-group-items] [cmdk-item], [cmdk-item]');
    await expect(page.locator('[cmdk-item]').first()).toContainText('Codex');
    await expect(page.locator('[cmdk-item]').first()).toContainText('Failed');
    expect(await items.count()).toBeGreaterThan(0);
  });

  test('palette runs commands: switch theme', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    await page.keyboard.press('Control+K');
    await page.getByRole('combobox', { name: 'Search runs and commands' }).fill('theme harbor');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'harbor');
  });

  test('cheat sheet opens with ? and from the status bar', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Command palette');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Shortcuts (?)' }).click();
    await expect(dialog).toBeVisible();
  });

  test('each of the five views renders (keys 1-5 and the switcher)', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    await openRun(page, /Add a --due flag to the add command/);
    const ids = ['view-activity', 'view-overview', 'view-files', 'view-tools', 'view-timeline'];
    for (let i = 0; i < ids.length; i++) {
      await page.locator('main').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press(String(i + 1));
      await expect(page.getByTestId(ids[i])).toBeVisible();
    }
    await page.getByRole('radio', { name: 'Overview' }).click();
    await expect(page.getByTestId('view-overview')).toBeVisible();
    await expect(page.getByTestId('view-overview')).toContainText('Reveal in folder');
    await page.getByRole('radio', { name: 'Files' }).click();
    await expect(page.getByTestId('view-files').getByRole('table')).toBeVisible();
    await page.getByRole('radio', { name: 'Tools' }).click();
    await expect(page.getByTestId('view-tools').getByRole('table')).toBeVisible();
  });

  test('unreadable run shows a calm card, not a crash', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    await page.getByRole('button', { name: /^Unreadable, \d+ runs?$/ }).click();
    await page.getByTestId('run-list').getByRole('option').first().click();
    await page.keyboard.press('2');
    await expect(page.getByRole('heading', { name: "Couldn't read this run" })).toBeVisible();
  });

  test('synonyms are aria-hidden and the live region has the real status', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    await openRun(page, /Add a --due flag to the add command/);
    const syn = page.getByTestId('status-synonym');
    await expect(syn).toBeVisible();
    await expect(syn).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByTestId('run-status-live')).toHaveText('Status: Running');
    await expect(page.getByTestId('run-status-live')).toHaveAttribute('aria-live', 'polite');
    // The status mark carries the real status as its accessible name.
    await expect(page.locator('.runview__status [role="img"]')).toHaveAttribute('aria-label', 'Running');
    // A failed run: plain words immediately, no synonyms, no fake progress.
    await openRun(page, /Cache forecast responses for ten minutes/);
    await expect(page.getByTestId('status-synonym')).toHaveCount(0);
    await expect(page.getByTestId('status-word')).toHaveText('Failed');
    await expect(page.getByTestId('run-status-live')).toHaveText('Status: Failed');
    await expect(page.getByTestId('fake-progress')).toHaveCount(0);
  });

  test('fake progress bar only while running, gone the moment the run fails', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    await openRun(page, /Add a --due flag to the add command/);
    const bar = page.getByTestId('fake-progress');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('totally fake progress bar');
    await expect(bar.locator('.fake-progress__track')).toHaveAttribute('aria-hidden', 'true');
    const id = await page.locator('.runview').getAttribute('data-run-id');
    await page.evaluate((runId) => window.__armFixture!.failRun(runId!, 'API error 529: overloaded'), id);
    await expect(page.getByTestId('run-status-live')).toHaveText('Status: Failed');
    await expect(bar).toHaveCount(0);
    await expect(page.getByTestId('status-synonym')).toHaveCount(0);
  });

  test('keyboard: j/k + Enter open, p pins, m and g m reach the multiviewer', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    const title = page.getByTestId('run-title');
    const start = await title.textContent();
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await expect(title).not.toHaveText(start ?? '');
    const pin = page.getByRole('button', { name: /^(Pin|Unpin) run$/ });
    const before = await pin.getAttribute('aria-pressed');
    await page.keyboard.press('p');
    await expect(pin).not.toHaveAttribute('aria-pressed', before ?? '');
    await page.keyboard.press('m');
    await expect(page.getByRole('button', { name: 'In multiviewer' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    await expect(page.getByTestId('multiview-placeholder')).toBeVisible();
    await page.keyboard.press('Control+,');
    await expect(page.getByTestId('settings-placeholder')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('run-title')).toBeVisible();
  });

  test('Ctrl-click and Shift-click build a multiviewer selection', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    const list = page.getByTestId('run-list');
    // Navigation order: each run once (Recent repeats runs, so keep each id's last occurrence).
    const ids: string[] = await list.getByRole('option').evaluateAll((els) => {
      const all = els.map((e) => (e as HTMLElement).dataset.runId as string);
      return all.filter((id, i) => all.lastIndexOf(id) === i);
    });
    const row = (id: string) => list.locator(`[role="option"][data-run-id="${id}"]`).last();
    const picked = () =>
      list.locator('[role="option"]:has(.runrow__multi)').evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLElement).dataset.runId))]);
    await row(ids[3]).click();
    await row(ids[5]).click({ modifiers: ['Shift'] });
    await expect.poll(picked).toEqual(expect.arrayContaining(ids.slice(3, 6)));
    expect((await picked()).length).toBe(3);
    await row(ids[7]).click({ modifiers: ['Control'] });
    await expect.poll(async () => (await picked()).length).toBe(4);
  });
});

test.describe('motion policy', () => {
  test('reduced motion: data-reduce-motion on <html> and no running infinite animations', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/?now=${NOW}`);
    await ready(page);
    await openRun(page, /Add a --due flag to the add command/);
    await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', '');
    await page.waitForTimeout(600);
    const infinite = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity)
          .map((a) => (a as CSSAnimation).animationName ?? 'anonymous'),
    );
    expect(infinite).toEqual([]);
    // Synonyms don't rotate under reduced motion; the label stays put.
    const syn = page.getByTestId('status-synonym');
    const word = await syn.textContent();
    await page.waitForTimeout(3500);
    await expect(syn).toHaveText(word ?? '');
  });

  test('without reduced motion the running spinners do animate (sanity check)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(demo());
    await ready(page);
    await expect(page.locator('html')).not.toHaveAttribute('data-reduce-motion', '');
    const n = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).length,
    );
    expect(n).toBeGreaterThan(0);
  });

  test('battery power turns on low-GPU mode (Auto): no infinite loops, slower updates', async ({ page }) => {
    await page.goto(demo('&battery=1'));
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-low-gpu', '');
    await expect(page.getByTestId('power-indicator')).toContainText('Low-GPU mode (on battery)');
    expect(await page.evaluate(() => window.__armFixture!.updateInterval())).toBe(1000);
    const n = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).length,
    );
    expect(n).toBe(0);
  });

  test('hidden window: data-hidden and 5 s update batching', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    await page.evaluate(() => window.__armFixture!.setVisible(false));
    await expect(page.locator('html')).toHaveAttribute('data-hidden', '');
    expect(await page.evaluate(() => window.__armFixture!.updateInterval())).toBe(5000);
    await page.evaluate(() => window.__armFixture!.setVisible(true));
    await expect(page.locator('html')).not.toHaveAttribute('data-hidden', '');
  });
});

test.describe('live updates and other scenarios', () => {
  test('a live run receives new events and new runs appear', async ({ page }) => {
    await page.goto(demo());
    await ready(page);
    await openRun(page, /Add a --due flag to the add command/);
    // Auto-follow: the newest event stays rendered at the bottom as events arrive.
    const lastIndex = () => page.locator('.activity .ev').last().getAttribute('data-index').then(Number);
    const before = await lastIndex();
    const id = await page.locator('.runview').getAttribute('data-run-id');
    await page.evaluate((runId) => {
      const fx = window.__armFixture!;
      const count = () => fx.runs().find((r) => r.id === runId)!.counts.events;
      const start = count();
      for (let i = 0; i < 60 && count() === start; i++) fx.tick();
    }, id);
    await expect.poll(lastIndex).toBeGreaterThan(before);
    const total = await page.getByRole('contentinfo', { name: 'Status bar' }).textContent();
    await page.evaluate(() => window.__armFixture!.addRun({ agent: 'aider', status: 'running', projectName: 'todo-cli', title: 'Brand new demo run' }));
    await expect(page.getByTestId('run-list').getByRole('option', { name: /Brand new demo run/ })).toBeVisible();
    await expect(page.getByRole('contentinfo', { name: 'Status bar' })).not.toHaveText(total ?? '');
  });

  test('many scenario: 300 runs, virtualised list', async ({ page }) => {
    await page.goto(`/?scenario=many&now=${NOW}&live=0`);
    await ready(page);
    await expect(page.getByRole('contentinfo', { name: 'Status bar' })).toContainText('300 runs');
    const rendered = await page.getByTestId('run-list').getByRole('option').count();
    expect(rendered).toBeLessThan(60);
    const firstBefore = await page.getByTestId('run-list').getByRole('option').first().getAttribute('data-run-id');
    await page.getByTestId('run-list').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(page.getByTestId('run-list').getByRole('option').first()).not.toHaveAttribute('data-run-id', firstBefore ?? '');
    expect(await page.getByTestId('run-list').getByRole('option').count()).toBeLessThan(60);
    // Keyboard End jumps to the last run in the list.
    await page.getByTestId('run-list').focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('run-title')).toBeVisible();
  });

  test('empty scenario explains what to do', async ({ page }) => {
    await page.goto(`/?scenario=empty&now=${NOW}`);
    await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible();
  });

  test('first run shows the wizard', async ({ page }) => {
    await page.goto(`/?scenario=firstrun&now=${NOW}&live=0`);
    await expect(page.getByTestId('wizard-placeholder')).toBeVisible();
    await page.getByRole('button', { name: 'Start watching' }).click();
    await expect(page.getByTestId('run-title')).toBeVisible();
  });
});
