// Feature 8: timeline zoom (fixture backend, synthetic demo data only).
import { expect, test, type Locator, type Page } from '@playwright/test';

const NOW = '2026-10-27T15:30:00';
const demo = `/?now=${NOW}&live=0`;
const RUN = /Add a --due flag to the add command/;

async function openTimeline(page: Page) {
  await page.goto(demo);
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await page.getByTestId('run-list').getByRole('option', { name: RUN }).first().click();
  await expect(page.getByTestId('run-title')).toHaveText(RUN);
  await page.getByRole('radio', { name: 'Timeline' }).click();
  await expect(page.getByTestId('view-timeline')).toBeVisible();
}

const scroller = (page: Page) => page.getByTestId('timeline-scroll');
const scrollOf = (l: Locator) => l.evaluate((el) => ({ left: el.scrollLeft, width: el.scrollWidth, client: el.clientWidth }));

/** Visible tick labels never overlap, and returns their texts. */
async function readableTicks(page: Page): Promise<string[]> {
  const boxes = await page.getByTestId('timeline-ticks').locator('.timeline__tick').evaluateAll((els) => {
    const port = (els[0]?.closest('.timeline__scroll') as HTMLElement | null)?.getBoundingClientRect();
    return els
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { left: r.left, right: r.left + (e as HTMLElement).scrollWidth, text: e.textContent ?? '' };
      })
      .filter((b) => port && b.left >= port.left + 110 && b.left <= port.right);
  });
  expect(boxes.length).toBeGreaterThan(1);
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].left).toBeGreaterThanOrEqual(boxes[i - 1].right);
  return boxes.map((b) => b.text);
}

test('zoom buttons, + / - / 0 keys and Fit to run', async ({ page }) => {
  await openTimeline(page);
  const status = page.getByTestId('timeline-zoom');
  await expect(status).toHaveText('Whole run');
  await expect(page.getByTestId('timeline-zoom-out')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('timeline-fit')).toHaveAttribute('aria-disabled', 'true');
  let s = await scrollOf(scroller(page));
  expect(s.width).toBeLessThanOrEqual(s.client + 1);
  const whole = await readableTicks(page);
  const fromWhole = (await page.getByTestId('timeline-from').textContent()) ?? '';

  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(status).toHaveText('Zoom 2×');
  s = await scrollOf(scroller(page));
  expect(s.width).toBeGreaterThan(s.client * 1.5);
  // Focus stays on the button, so + works from there too.
  await page.keyboard.press('+');
  await expect(status).toHaveText('Zoom 4×');
  // In the run view the keys also work with nothing focused.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('-');
  await expect(status).toHaveText('Zoom 2×');
  await page.keyboard.press('0');
  await expect(status).toHaveText('Whole run');
  expect((await scrollOf(scroller(page))).left).toBe(0);

  // Fully zoomed in: the axis shows seconds and stays readable; zoom in is then disabled.
  const zoomIn = page.getByTestId('timeline-zoom-in');
  for (let i = 0; i < 20 && (await zoomIn.getAttribute('aria-disabled')) !== 'true'; i++) await zoomIn.click();
  await expect(zoomIn).toHaveAttribute('aria-disabled', 'true');
  const close = await readableTicks(page);
  expect(close.join(' ')).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  expect(close).not.toEqual(whole);
  // The axis names the visible part, not the run's start (a multi-day run keeps its date context).
  await expect(page.getByTestId('timeline-from')).not.toHaveText(fromWhole);

  await page.getByTestId('timeline-fit').click();
  await expect(status).toHaveText('Whole run');
  expect(await readableTicks(page)).toEqual(whole);
});

test('Ctrl+wheel zooms at the pointer, and dragging pans', async ({ page }) => {
  await openTimeline(page);
  const bar = page.locator('.timeline__bar').nth(3);
  const before = (await bar.boundingBox())!;
  await page.mouse.move(before.x, before.y + before.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await expect(page.getByTestId('timeline-zoom')).toHaveText(/^Zoom \d/);
  // The moment under the pointer stays put (the bar's start edge).
  await expect.poll(async () => Math.abs((await bar.boundingBox())!.x - before.x)).toBeLessThan(3);
  expect((await bar.boundingBox())!.width).toBeGreaterThanOrEqual(before.width);

  // Drag left to pan right.
  const box = (await scroller(page).boundingBox())!;
  const left0 = (await scrollOf(scroller(page))).left;
  await page.mouse.move(box.x + box.width / 2, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 150, box.y + 30, { steps: 5 });
  await page.mouse.up();
  const left1 = (await scrollOf(scroller(page))).left;
  expect(Math.round(left1 - left0)).toBeGreaterThanOrEqual(140);
  // The lane labels stay in view while panning.
  await expect(page.locator('.timeline__label', { hasText: 'Turns' })).toBeInViewport();
});

test('zooms inside a multiviewer tile with the tile focused', async ({ page }) => {
  await openTimeline(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('m');
  await expect(async () => {
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    await expect(page.getByTestId('multiview')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  const t = page.getByTestId('mv-tile').first();
  await t.getByRole('radio', { name: 'Timeline', exact: true }).click();
  await expect(t.getByTestId('view-timeline')).toBeVisible();
  await t.getByTestId('timeline-scroll').focus();
  await page.keyboard.press('+');
  await expect(t.getByTestId('timeline-zoom')).toHaveText('Zoom 2×');
  await page.keyboard.press('0');
  await expect(t.getByTestId('timeline-zoom')).toHaveText('Whole run');
});
