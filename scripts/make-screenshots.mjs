#!/usr/bin/env node
// Makes the README screenshots in docs/images/*.png from the browser demo (the fixture backend:
// synthetic runs only, never anything from your disk). At 1440 x 900 they also meet the Microsoft
// Store's 1366 x 768 minimum. Most run screens show the demo's hand-written run (an easter egg,
// see centerTheDiv in src/renderer/src/backend/demoData.ts).
//
//   node scripts/make-screenshots.mjs              all shots
//   node scripts/make-screenshots.mjs palette ...  only the named shots
//   node scripts/make-screenshots.mjs --raw        keep full-colour PNGs (skip the 256-colour pass)
//   ARM_SHOTS_DIR=<folder> node scripts/make-screenshots.mjs   write there instead of docs/images
//
// Uses the installed Google Chrome through Playwright (channel 'chrome'). It reuses a demo server
// already running on :5317 (npm run dev:web) or starts one with `npx vite --config vite.web.config.ts`
// and stops it again when done. The demo's clock is pinned (?now=) and its live timer is off
// (?live=0); on top of that the page's own clock is faked with Playwright's page.clock: every page
// loads with Date.now() fixed at exactly NOW, runs at normal speed while the script clicks around,
// and reads a fixed time (NOW + SHOT_AT_MS) when the screenshot is taken. Relative times, live
// timers and the ETA therefore come out the same on every run, however fast the machine is. Timers
// keep running at the shot (setFixedTime, not pauseAt), so no animation is caught half-way; the one
// thing still tied to real time is which word the rotating "running" synonym shows. The time zone
// and locale are pinned too.
//
// Each PNG is reduced to a 256-colour palette (the UI is flat colour, so this is hard to see) and
// written with maximum zlib compression, which keeps them around a third of the full-colour size.
// The helpers at the bottom (server, PNG decode/encode, palette) are also used by make-gif.mjs.

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync, deflateSync, crc32, constants as zc } from 'node:zlib';
import { chromium } from 'playwright';
import gifenc from 'gifenc';

const { quantize, applyPalette } = gifenc;

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** docs/images, or ARM_SHOTS_DIR (to compare two runs without touching the committed images). */
export const OUT_DIR = process.env.ARM_SHOTS_DIR ? resolve(process.env.ARM_SHOTS_DIR) : join(ROOT, 'docs', 'images');
export const BASE = process.env.ARM_WEB_URL || 'http://localhost:5317';
/** 2026-10-27 15:30 UTC. Every relative time in the demo is computed from this. */
export const NOW = Date.UTC(2026, 9, 27, 15, 30, 0);
const SETTINGS_KEY = 'arm.fixture.settings.demo';
const VIEWPORT = { width: 1440, height: 900 };

/** How long after it loaded (in fake time) each page's clock is fixed for its screenshot. Must be
 *  longer than the slowest shot takes to set up; freezeClock() fails loudly if it is not. */
const SHOT_AT_MS = 30_000;
/** Fake time at which a page's clock is fixed for a reload (multiviewer), so the reload is pinned too. */
const RELOAD_AT_MS = 30_000;

// ------------------------------------------------------------------------------------------ shots

const SHOTS = {
  /** Home: the dashboard, a section per status with the 3 most recent runs each. */
  async dashboard(browser) {
    const page = await openDemo(browser, { theme: 'paper' });
    await page.getByTestId('dashboard').waitFor();
    await blurActive(page);
    await settle(page, 700);
    return page;
  },

  /** Main run view, light theme (Paper), on the demo's hand-written running run (demoData centerTheDiv). */
  async 'run-view-paper'(browser) {
    const page = await openDemo(browser, { theme: 'paper' });
    await openEgg(page);
    return page;
  },

  /** The same run in a dark theme (Harbor). */
  async 'run-view-harbor'(browser) {
    const page = await openDemo(browser, { theme: 'harbor' }, { colorScheme: 'dark' });
    await openEgg(page);
    return page;
  },

  /** Overview: the summary built on this computer, counts and tokens. */
  async overview(browser) {
    const page = await openDemo(browser, { theme: 'paper' });
    await openEgg(page, 'Overview');
    await page.getByTestId('overview-summary').waitFor();
    await settle(page, 600);
    return page;
  },

  /** Code changed: every edit with a total; the two edits that finally fixed it are expanded. */
  async 'code-changed'(browser) {
    const page = await openDemo(browser, { theme: 'paper' });
    await openEgg(page, 'Code changed');
    const items = page.getByTestId('view-changes').getByRole('list', { name: 'Code changes, oldest first' }).getByRole('listitem');
    for (const i of [3, 4]) await items.nth(i).getByRole('button').click();
    await blurActive(page);
    await settle(page, 500);
    return page;
  },

  /** Reasoning: the run's readable thinking, oldest first. */
  async reasoning(browser) {
    const page = await openDemo(browser, { theme: 'paper' });
    await openEgg(page, 'Reasoning');
    await page.getByTestId('view-reasoning').waitFor();
    await settle(page, 500);
    return page;
  },

  /** Timeline of the busy live Claude Code run (the easter egg's edits are too far apart for a good
   *  picture), zoomed in once. */
  async timeline(browser) {
    const page = await openDemo(browser, { theme: 'paper' });
    await openRunByTitle(page, 'todo-cli', 'running');
    await page.getByRole('radiogroup', { name: 'Run view' }).getByRole('radio', { name: 'Timeline', exact: true }).click();
    await page.getByTestId('view-timeline').waitFor();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    // Zooming keeps the live end in view; this run's busiest stretch is its first half.
    await page.getByTestId('timeline-scroll').evaluate((el) => (el.scrollLeft = 0));
    await blurActive(page);
    await settle(page, 600);
    const shown = await page.getByTestId('timeline-scroll').evaluate((el) => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll('.timeline__bar')].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.right > box.left && r.left < box.right;
      }).length;
    });
    if (shown < 5) throw new Error(`only ${shown} timeline bars in view`);
    return page;
  },

  /** All runs, grouped by start time, with a Shift-click selection ready to move to a folder. */
  async 'all-runs'(browser) {
    const page = await openDemo(browser, { theme: 'paper' });
    await page.getByTestId('open-all-runs').click();
    await page.getByTestId('all-runs').waitFor();
    const today = page.locator('[data-group="today"] .allruns__row');
    await today.nth(1).getByRole('checkbox').click();
    await today.nth(3).locator('.allruns__main').click({ modifiers: ['Shift'] });
    await page.getByTestId('allruns-selected').filter({ hasText: '3 selected' }).waitFor();
    await blurActive(page);
    await settle(page, 500);
    return page;
  },

  /** Usage: tokens per agent and per run, split into input, output and cache. */
  async usage(browser) {
    const page = await openDemo(browser, { theme: 'paper' });
    await page.getByTestId('open-usage').click();
    await page.getByTestId('usage').waitFor();
    await blurActive(page);
    await settle(page, 600);
    return page;
  },

  /** Settings > Customisation: the custom theme editor naming a pair that fails WCAG AA. */
  async 'custom-theme'(browser) {
    const page = await openCustomisation(browser);
    await page.getByTestId('custom-theme-open').click();
    const editor = page.getByTestId('custom-theme-editor');
    await editor.waitFor();
    await editor.getByLabel('Accent', { exact: true }).fill('#7a4fb8');
    await editor.getByLabel('Text', { exact: true }).fill('#77726b');
    await page.getByTestId('custom-theme-problems').waitFor();
    await editor.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await blurActive(page);
    await settle(page, 600);
    return page;
  },

  /** The Simple display: only running runs, one large line each. */
  async 'simple-display'(browser) {
    const page = await openCustomisation(browser);
    await page.getByRole('radio', { name: 'Simple', exact: true }).check();
    await page.keyboard.press('Escape');
    await page.getByTestId('simple-board').waitFor();
    await blurActive(page);
    await settle(page, 700);
    return page;
  },

  /** Multiviewer, 4 tiles (2 x 2). */
  async 'multiviewer-4'(browser) {
    return multiviewer(browser, 4);
  },

  /** Multiviewer, 12 tiles (4 x 3). */
  async 'multiviewer-12'(browser) {
    return multiviewer(browser, 12);
  },

  /** Command palette open with a query. */
  async palette(browser) {
    const page = await openDemo(browser, { theme: 'paper' });
    await page.keyboard.press('Control+K');
    const input = page.getByRole('combobox', { name: 'Search runs and commands' });
    await input.waitFor();
    await input.fill('codex failed');
    await page.locator('[cmdk-item]').first().waitFor();
    await settle(page);
    return page;
  },

  /** Keyboard shortcut cheat sheet. */
  async 'cheat-sheet'(browser) {
    const page = await openDemo(browser, { theme: 'paper' });
    await blurActive(page);
    await page.keyboard.press('?');
    await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
    await settle(page);
    return page;
  },

  /** First-run wizard, detection step. */
  async 'wizard-detect'(browser) {
    const page = await newPage(browser);
    await startClock(page);
    await page.goto(`${BASE}/?scenario=firstrun&now=${NOW}&live=0&fresh=1`);
    await runClock(page);
    await page.getByTestId('wizard').waitFor();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Find your agents' }).waitFor();
    await page.getByTestId('wizard-summary').waitFor();
    await blurActive(page);
    await settle(page);
    return page;
  },

  /** Settings, Motion & performance (reduce motion vs low GPU mode). */
  async 'settings-motion'(browser) {
    const page = await openDemo(browser, { theme: 'paper' });
    await page.keyboard.press('Control+,');
    await page.getByTestId('settings-screen').waitFor();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Motion & performance' }).click();
    await page.getByRole('heading', { level: 2, name: 'Motion & performance' }).waitFor();
    await blurActive(page);
    await settle(page, 600);
    return page;
  },

  /** An unreadable run: the calm "Couldn't read this run" card. */
  async unreadable(browser) {
    const page = await openDemo(browser, { theme: 'paper' });
    await page.getByRole('button', { name: /^Unreadable, \d+ runs?$/ }).click();
    await page.getByTestId('run-list').getByRole('option').first().click();
    await blurActive(page);
    await page.keyboard.press('2');
    await page.getByRole('heading', { name: "Couldn't read this run" }).waitFor();
    await settle(page);
    return page;
  },
};

async function multiviewer(browser, n) {
  const page = await openDemo(browser, { theme: 'paper' });
  // Interesting runs first: every live run, then the ones that need attention, then the newest.
  const ids = await page.evaluate((count) => {
    const rank = { running: 0, waiting: 1, failed: 2, stuck: 3, idle: 4, unreadable: 5, done: 6 };
    return window.__armFixture
      .runs()
      .sort((a, b) => rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
      .slice(0, count)
      .map((r) => r.id);
  }, n);
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    [SETTINGS_KEY, JSON.stringify({ theme: 'paper', layouts: [{ name: `Demo ${n}`, runIds: ids }] })],
  );
  // Fix the clock before the reload so the reloaded page starts from a known fake time as well.
  const reloadAt = clockBase.get(page) + RELOAD_AT_MS;
  await assertBefore(page, reloadAt);
  await startClock(page, reloadAt);
  await page.reload();
  await runClock(page);
  await waitReady(page);
  await openMultiview(page);
  const open = page.getByRole('button', { name: `Open layout Demo ${n}`, exact: true });
  if (!(await open.isVisible())) await page.getByRole('button', { name: /^Layouts/ }).click();
  await open.click();
  await page.getByTestId('mv-grid').and(page.locator(`[data-tile-count="${n}"]`)).waitFor();
  await blurActive(page);
  await settle(page, 900);
  return page;
}

// -------------------------------------------------------------------------------- page helpers

export async function newPage(browser, contextOptions = {}) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    ...contextOptions,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  pageErrors.set(page, errors);
  return page;
}

/** Uncaught errors and console errors per page, reported next to each shot. */
export const pageErrors = new WeakMap();

/** The demo scenario with these settings saved (theme etc.), clock pinned, live timer off. */
export async function openDemo(browser, settings = {}, contextOptions = {}, query = 'live=0') {
  const page = await newPage(browser, contextOptions);
  await page.addInitScript(
    ([key, value]) => {
      // Only on the first load of this tab, so later changes (layouts) are not overwritten.
      if (!sessionStorage.getItem('arm.shot.seeded')) {
        localStorage.setItem(key, value);
        sessionStorage.setItem('arm.shot.seeded', '1');
      }
    },
    [SETTINGS_KEY, JSON.stringify(settings)],
  );
  await startClock(page);
  await page.goto(`${BASE}/?now=${NOW}&${query}`);
  await runClock(page);
  await waitReady(page);
  return page;
}

// -------------------------------------------------------------------------------- fake clock

/** The fake time each page (re)loaded at, for freezeClock() targets. */
export const clockBase = new WeakMap();

/**
 * Installs Playwright's fake clock with Date.now() fixed at `at`. Call before page.goto (or
 * reload), and runClock() after it: while the page loads Date.now() is exactly `at`, so the demo's
 * ?now= pin leaves no offset that depends on how long loading took. (Fixed, not paused: timers and
 * animation frames keep running. A clock paused through page load leaves Motion's enter
 * animations stuck at their first frame.)
 */
export async function startClock(page, at = NOW) {
  await page.clock.setFixedTime(at);
  clockBase.set(page, at);
}

/** After the page has loaded: the clock runs at normal speed again, from the time it loaded at. */
export async function runClock(page) {
  await page.clock.setSystemTime(clockBase.get(page));
}

/**
 * From now on Date.now() reads exactly `at`; timers and animation frames keep running. Waits
 * `settleMs` so every once-a-second timer redraws with the fixed time and number animations (the
 * ETA counter) finish.
 */
export async function freezeClock(page, at, settleMs = 1500) {
  await assertBefore(page, at);
  await page.clock.setFixedTime(at);
  if (settleMs) await page.waitForTimeout(settleMs);
}

async function assertBefore(page, at) {
  const fake = await page.evaluate(() => Date.now());
  if (fake > at) throw new Error(`the fake clock is already ${fake - at} ms past ${at - NOW} ms: setting up took too long`);
}

export async function waitReady(page) {
  await page.getByTestId('run-list').getByRole('option').first().waitFor();
  // The app opens on the dashboard; a reloaded page may come back to a run.
  await page.getByTestId('dashboard').or(page.getByTestId('run-title')).first().waitFor();
}

/** The demo's hand-written running run (demoData.ts centerTheDiv). */
export const EGG = 'center the login button';

/** Opens the easter-egg run, and then the named view of the run view switcher. */
export async function openEgg(page, view) {
  await openRunByTitle(page, EGG, 'running');
  if (!view) return;
  await page.getByRole('radiogroup', { name: 'Run view' }).getByRole('radio', { name: view, exact: true }).click();
  await blurActive(page);
  await settle(page, 400);
}

/** Settings, scrolled to the Customisation section. */
async function openCustomisation(browser) {
  const page = await openDemo(browser, { theme: 'paper' });
  await page.keyboard.press('Control+,');
  await page.getByTestId('settings-screen').waitFor();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Customisation' }).click();
  await page.getByRole('heading', { level: 2, name: 'Customisation' }).waitFor();
  return page;
}

/** Opens the first run in the list whose row mentions `text` and has `status`. */
export async function openRunByTitle(page, text, status) {
  const row = page
    .getByTestId('run-list')
    .locator(`[role="option"]${status ? `[data-status="${status}"]` : ''}`)
    .filter({ hasText: text })
    .first();
  await row.click();
  await blurActive(page);
  await settle(page, 700);
}

export async function openMultiview(page) {
  const mv = page.getByTestId('multiview');
  for (let i = 0; i < 8 && (await mv.count()) === 0; i++) {
    await blurActive(page);
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    await mv.waitFor({ timeout: 2000 }).catch(() => {});
  }
  await mv.waitFor();
}

export async function blurActive(page) {
  await page.evaluate(() => {
    const el = document.activeElement;
    if (el && el !== document.body && typeof el.blur === 'function') el.blur();
  });
  await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
}

/**
 * The rotating "running" word (real-time timer) fades one word out before the next one mounts, so
 * a shot can land on an empty label. Waits until every rotating word is fully drawn.
 */
export async function synonymsShown(page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid="status-synonym"]')].every(
        (el) => el.textContent.trim() !== '' && [...el.querySelectorAll('*')].every((n) => getComputedStyle(n).opacity === '1'),
      ),
    null,
    { timeout: 15_000, polling: 50 },
  );
}

export async function settle(page, ms = 400) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

// ------------------------------------------------------------------------------------- server

/** Uses the demo server on :5317 if it answers, else starts one. Returns a stop function. */
export async function ensureServer() {
  if (await isUp()) return () => {};
  const child = spawn('npx', ['vite', '--config', 'vite.web.config.ts'], {
    cwd: ROOT,
    shell: process.platform === 'win32',
    stdio: 'ignore',
    env: { ...process.env, BROWSER: 'none' },
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isUp()) break;
    if (child.exitCode !== null) throw new Error(`the demo server exited with code ${child.exitCode}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!(await isUp())) throw new Error(`no demo server at ${BASE} after 2 minutes`);
  return () => {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    } else child.kill('SIGTERM');
  };
}

async function isUp() {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
    return res.ok && (await res.text()).includes('Agent Run Monitor');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------- PNG tools

/** Decodes an 8-bit, non-interlaced RGB, RGBA (Chrome screenshots) or palette PNG (ours) to RGBA. */
export function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let plte = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colorType = data[9];
      if (depth !== 8 || ![2, 3, 6].includes(colorType) || data[12] !== 0) throw new Error('unsupported PNG');
    } else if (type === 'PLTE') plte = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 3 ? 1 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const cur = new Uint8Array(stride);
  let prev = new Uint8Array(stride);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (plte) {
        const k = cur[x] * 3;
        rgba[o] = plte[k];
        rgba[o + 1] = plte[k + 1];
        rgba[o + 2] = plte[k + 2];
        rgba[o + 3] = 255;
        continue;
      }
      rgba[o] = cur[x * bpp];
      rgba[o + 1] = cur[x * bpp + 1];
      rgba[o + 2] = cur[x * bpp + 2];
      rgba[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = Uint8Array.from(cur);
  }
  return { width, height, rgba };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Writes an 8-bit indexed (palette) PNG. */
export function encodeIndexedPng(width, height, index, palette) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // palette
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach((c, i) => {
    plte[i * 3] = c[0];
    plte[i * 3 + 1] = c[1];
    plte[i * 3 + 2] = c[2];
  });
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none (best for palette images)
    raw.set(index.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9, memLevel: 9, strategy: zc.Z_DEFAULT_STRATEGY });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Full-colour screenshot PNG -> 256-colour PNG. */
export function toPalettePng(pngBuffer) {
  const { width, height, rgba } = decodePng(pngBuffer);
  const palette = quantize(rgba, 256, { format: 'rgb565' });
  const index = applyPalette(rgba, palette, 'rgb565');
  return encodeIndexedPng(width, height, index, palette);
}

// --------------------------------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const raw = args.includes('--raw');
  const wanted = args.filter((a) => !a.startsWith('--'));
  const unknown = wanted.filter((w) => !SHOTS[w]);
  if (unknown.length) {
    console.error(`unknown shot(s): ${unknown.join(', ')}\navailable: ${Object.keys(SHOTS).join(', ')}`);
    process.exit(1);
  }
  const names = wanted.length ? wanted : Object.keys(SHOTS);
  mkdirSync(OUT_DIR, { recursive: true });
  const stop = await ensureServer();
  const browser = await chromium.launch({ channel: 'chrome' });
  let failed = 0;
  try {
    for (const name of names) {
      let page;
      try {
        page = await SHOTS[name](browser);
        await freezeClock(page, (clockBase.get(page) ?? NOW) + SHOT_AT_MS);
        await synonymsShown(page);
        // No `animations: 'disabled'`: it resets the rotating word's Motion animation to its first
        // frame (invisible). freezeClock's settle has let every short animation finish already.
        const png = await page.screenshot({ caret: 'hide' });
        const out = raw ? png : toPalettePng(png);
        const file = join(OUT_DIR, `${name}.png`);
        writeFileSync(file, out);
        const kb = (statSync(file).size / 1024).toFixed(0);
        console.log(`${name}.png  ${kb} KB${raw ? '' : ` (full colour ${(png.length / 1024).toFixed(0)} KB)`}`);
      } catch (e) {
        failed++;
        console.error(`${name}: FAILED: ${e?.message ?? e}`);
      } finally {
        const errors = (page && pageErrors.get(page)) || [];
        if (errors.length) console.error(`${name}: page errors: ${errors.join(' | ')}`);
        await page?.context().close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
