#!/usr/bin/env node
// Makes the README's GIFs in docs/images from the browser demo (the fixture backend: synthetic
// runs only, never anything from your disk).
//
//   node scripts/make-gif.mjs                  every clip
//   node scripts/make-gif.mjs demo timeline    only the named clips
//   ARM_GIF_FRAMES=<folder> node scripts/make-gif.mjs   also saves every frame as a PNG there (to check)
//   ARM_SHOTS_DIR=<folder> node scripts/make-gif.mjs    write the GIFs there instead of docs/images
//
// The clips (see CLIPS), each about 10 seconds:
//   demo.gif           a live run updating; m to add runs to the multiviewer and → to step to the
//                      next run; Ctrl+K, a palette search and Enter; g then m to open the multiviewer
//   code-changed.gif   the demo's hand-written run (centerTheDiv in demoData.ts): edits with a
//                      total, diffs opening one by one
//   timeline.gif       zooming with + and Ctrl+scroll, dragging to pan, 0 to fit the run again
//   organise.gif       All runs: Shift-click a range, Move to folder, the folder shows on each row
// A small caption names each key as it is pressed (drawn by this script, not part of the app).
//
// How: Playwright drives the installed Google Chrome (channel 'chrome') at 1440 x 900 CSS pixels with
// a device scale factor of 2/3, so Chrome itself renders each frame at 960 x 600 (sharper than
// shrinking a big screenshot). Frames come straight from the DevTools protocol, at most one per
// FRAME_MS; each scene is a fixed number of frames and every frame plays for FRAME_MS, so the clip
// always has the same length.
//
// Time is faked with Playwright's page.clock. The page loads with Date.now() fixed at exactly NOW
// (so the demo's ?now= pin is exact), runs normally while the script sets up, and is paused before
// the first frame. From then on every frame advances the page's clock by exactly FRAME_MS
// (page.clock.runFor), so the demo's live updates, timers, the ETA and the rotating word move by
// the same amount per frame on every run, however slow the machine is. CSS and Web Animations still
// run on real time, which is why frames stay FRAME_MS apart in real time too. Then gifenc (MIT) builds one 255-colour palette for the whole clip, and every frame after
// the first stores only the pixels that changed (the rest is transparent over the previous frame),
// which keeps the file small. Reuses the demo server and helpers from make-screenshots.mjs.

import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { chromium } from 'playwright';
import gifenc from 'gifenc';
import { BASE, EGG, NOW, OUT_DIR, ROOT, blurActive, decodePng, ensureServer, openRunByTitle, runClock, startClock, waitReady } from './make-screenshots.mjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const SCALE = 2 / 3; // 1440 x 900 CSS px -> 960 x 600 frames
const FRAME_MS = 110; // spacing between frames when capturing, and how long each frame plays (about 9 fps)
const HOLD_LAST_MS = 1200; // the last frame stays up a little before the clip loops
const MAX_BYTES = 2.5 * 1024 * 1024;
/** Fake time (after NOW) at which recording starts. Longer than the set-up before the first frame. */
const RECORD_AT_MS = 20_000;

const runView = (page, name) => page.getByRole('radiogroup', { name: 'Run view' }).getByRole('radio', { name, exact: true });

/**
 * Each clip: `setup` runs on the normal clock (open the screen to start from), `record` with the
 * page's clock paused, moving only as frames are taken.
 */
const CLIPS = {
  demo: {
    // Start on the live Claude Code run.
    async setup(page) {
      await openRunByTitle(page, 'todo-cli', 'running');
    },
    async record(page, rec) {
      await recordDemo(page, rec);
    },
  },

  'code-changed': {
    async setup(page) {
      await openRunByTitle(page, EGG, 'running');
      await runView(page, 'Code changed').click();
      await page.getByTestId('view-changes').waitFor();
    },
    async record(page, rec) {
      const items = page.getByTestId('view-changes').getByRole('list', { name: 'Code changes, oldest first' }).getByRole('listitem');
      const toggle = (i) => items.nth(i).getByRole('button').click();
      await caption(page, 'Code changed: every edit in order, with a total');
      await rec.frames(14);
      await caption(page, 'Click an edit to see its diff');
      await toggle(0);
      await rec.frames(14);
      await toggle(0);
      await toggle(2);
      await rec.frames(14);
      await toggle(2);
      await caption(page, 'Three hours in: the real culprit');
      await toggle(3);
      await rec.frames(22);
      await toggle(4);
      await rec.frames(16);
    },
  },

  timeline: {
    // The busy live run: the easter egg's edits are too far apart to show zooming well.
    async setup(page) {
      await openRunByTitle(page, 'todo-cli', 'running');
      await runView(page, 'Timeline').click();
      await page.getByTestId('view-timeline').waitFor();
    },
    async record(page, rec) {
      await caption(page, 'Timeline: the whole run');
      await rec.frames(12);
      // Zoom in where the pointer is, over the run's first cluster of shell calls (its busiest
      // stretch; zooming around the middle of the view would land in a quiet gap).
      const bars = page.locator('.timeline__bar');
      const widths = await bars.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
      const bar = await bars.nth(widths.indexOf(Math.max(...widths))).boundingBox();
      const y = bar.y + bar.height / 2;
      const x = bar.x + bar.width / 2;
      await caption(page, 'Ctrl + scroll   zoom in where the pointer is');
      await page.mouse.move(x, y);
      await page.keyboard.down('Control');
      for (let i = 0; i < 2; i++) {
        await page.mouse.wheel(0, -100);
        await rec.frames(6);
      }
      await page.keyboard.up('Control');
      await rec.frames(6);
      await caption(page, 'Drag to pan along the run');
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) {
        // Rightwards: back to the start of the run (the prompt and the first shell calls).
        await page.mouse.move(x + i * 28, y);
        await rec.frames(1);
      }
      await page.mouse.up();
      await rec.frames(8);
      await caption(page, '0   fit the whole run again');
      await page.keyboard.press('0');
      await rec.frames(14);
    },
  },

  organise: {
    async setup(page) {
      await page.getByTestId('open-all-runs').click();
      await page.getByTestId('all-runs').waitFor();
    },
    async record(page, rec) {
      const today = page.locator('[data-group="today"] .allruns__row');
      await caption(page, 'All runs, grouped by when they started');
      await rec.frames(12);
      await caption(page, 'Click a run to select it');
      await today.nth(1).getByRole('checkbox').click();
      await rec.frames(8);
      await caption(page, 'Shift-click selects everything in between');
      await page.keyboard.down('Shift');
      await today.nth(4).locator('.allruns__main').click();
      await page.keyboard.up('Shift');
      await rec.frames(12);
      await caption(page, 'Move to folder');
      await page.getByTestId('allruns-move').click();
      await rec.framesUntil(async () => (await page.getByRole('dialog').count()) > 0, 12, 'the folder dialog to open');
      await rec.frames(10);
      await page.getByRole('dialog').getByRole('button', { name: 'Move to Side projects' }).click();
      await rec.framesUntil(async () => (await page.getByRole('dialog').count()) === 0, 12, 'the folder dialog to close');
      await caption(page, 'Each run shows its folder');
      await rec.frames(20);
    },
  },
};

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const unknown = wanted.filter((w) => !CLIPS[w]);
  if (unknown.length) {
    console.error(`unknown clip(s): ${unknown.join(', ')}\navailable: ${Object.keys(CLIPS).join(', ')}`);
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const stop = await ensureServer();
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    for (const name of wanted.length ? wanted : Object.keys(CLIPS)) {
      const frames = await recordClip(browser, CLIPS[name]);
      encode(frames, join(OUT_DIR, `${name}.gif`));
    }
  } finally {
    await browser.close();
    stop();
  }
}

/** Opens the demo, runs the clip's set-up, pauses the page's clock and records. Returns the frames. */
async function recordClip(browser, clip) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: SCALE,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
  });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('arm.gif.seeded')) {
        localStorage.setItem('arm.fixture.settings.demo', JSON.stringify({ theme: 'paper' }));
        sessionStorage.setItem('arm.gif.seeded', '1');
      }
    });
    // Live timer on: the demo's running runs keep writing while we record (on the fake clock).
    await startClock(page);
    await page.goto(`${BASE}/?now=${NOW}`);
    await runClock(page);
    await waitReady(page);
    await installCaption(page);
    await clip.setup(page);
    await blurActive(page);
    await page.waitForTimeout(600);

    // From here the page's clock only moves when a frame is taken.
    const fakeNow = await page.evaluate(() => Date.now());
    if (fakeNow > NOW + RECORD_AT_MS) throw new Error(`set-up took longer than RECORD_AT_MS (${fakeNow - NOW} ms)`);
    await page.clock.pauseAt(NOW + RECORD_AT_MS);
    const rec = recorder(page, await context.newCDPSession(page));
    await clip.record(page, rec);
    if (errors.length) console.error(`page errors: ${errors.join(' | ')}`);
    return rec.taken;
  } finally {
    await context.close();
  }
}

/** demo.gif: live updates, stepping between runs, the palette and the multiviewer. */
async function recordDemo(page, rec) {
  // 1. A live run updating (nudge the demo so new events land on camera).
  await caption(page, 'A live run, updating as the agent works');
  await rec.frames(13, async (i) => {
    if (i % 6 === 3) await page.evaluate(() => window.__armFixture?.tick());
  });

  // 2. m adds the run to the multiviewer, → steps to the next run.
  for (const [key, text] of [
    ['m', 'm   add this run to the multiviewer'],
    ['ArrowRight', '→   next run'],
    ['m', 'm   add it too'],
    ['ArrowRight', '→   next run'],
    ['m', 'm   and this one'],
  ]) {
    await caption(page, text);
    await page.keyboard.press(key);
    await rec.frames(5);
  }

  // 3. Ctrl+K: search runs by agent, status and time.
  await caption(page, 'Ctrl+K   search runs and commands');
  await page.keyboard.press('Control+K');
  const input = page.getByRole('combobox', { name: 'Search runs and commands' });
  await input.waitFor();
  await rec.frames(3);
  for (const ch of 'codex failed') {
    await input.press(ch === ' ' ? 'Space' : ch);
    await rec.frames(1);
  }
  await rec.frames(5);
  await caption(page, 'Enter   open the run');
  await page.keyboard.press('Enter');
  // The palette's closing animation needs the clock to move: take frames until it is gone.
  await rec.framesUntil(async () => (await page.getByRole('dialog').count()) === 0, 12, 'the palette to close');
  await rec.frames(3);
  await caption(page, 'm   add it to the multiviewer');
  await page.keyboard.press('m');
  await rec.frames(4);

  // 4. g then m opens the multiviewer with the chosen runs, still live.
  await caption(page, 'g then m   open the multiviewer');
  await page.keyboard.press('g');
  await page.keyboard.press('m');
  await rec.framesUntil(async () => (await page.getByTestId('multiview').count()) > 0, 12, 'the multiviewer to open');
  await rec.frames(15, async (i) => {
    if (i % 5 === 2) await page.evaluate(() => window.__armFixture?.tick());
  });
}

/** Takes frames no closer than FRAME_MS apart, moving the page's paused clock FRAME_MS per frame. */
function recorder(page, cdp) {
  const frames = []; // PNG buffers
  let last = 0;
  let slowest = 0;
  // Page.captureScreenshot directly: about twice as fast as page.screenshot(), still lossless PNG.
  const clip = { x: 0, y: 0, width: 1440, height: 900, scale: SCALE };
  const frame = async () => {
    const wait = last + FRAME_MS - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    if (last) slowest = Math.max(slowest, Date.now() - last);
    last = Date.now();
    await page.clock.runFor(FRAME_MS);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip });
    frames.push(Buffer.from(data, 'base64'));
  };
  return {
    async frames(n, each) {
      for (let i = 0; i < n; i++) {
        if (each) await each(i);
        await frame();
      }
    },
    /** Frames until `done()` is true (checked after each frame), at least one, at most `max`. */
    async framesUntil(done, max, what) {
      for (let i = 0; i < max; i++) {
        await frame();
        if (await done()) return;
      }
      throw new Error(`no ${what} after ${max} frames`);
    },
    get slowestGapMs() {
      return slowest;
    },
    get taken() {
      return frames;
    },
  };
}

/** A key caption at the bottom of the window, drawn by this script (not part of the app). */
async function installCaption(page) {
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'gif-caption';
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
      position: 'fixed',
      left: '50%',
      bottom: '44px',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      padding: '9px 18px',
      borderRadius: '10px',
      background: 'rgba(24, 28, 36, 0.88)',
      color: '#fff',
      font: '600 19px/1.3 system-ui, "Segoe UI", sans-serif',
      whiteSpace: 'pre',
      pointerEvents: 'none',
      boxShadow: '0 4px 14px rgba(0,0,0,.18)',
    });
    document.body.appendChild(el);
  });
}

async function caption(page, text) {
  await page.evaluate((t) => {
    const el = document.getElementById('gif-caption');
    if (el) el.textContent = t;
  }, text);
}

function encode(frames, out) {
  if (frames.length < 2) throw new Error('no frames recorded');
  const dump = process.env.ARM_GIF_FRAMES;
  if (dump) {
    mkdirSync(dump, { recursive: true });
    const clip = basename(out, '.gif');
    frames.forEach((png, i) => writeFileSync(join(dump, `${clip}-${String(i).padStart(3, '0')}.png`), png));
  }
  const decoded = frames.map((png) => decodePng(png));
  const { width, height } = decoded[0];

  // One palette for the whole clip, from every 4th frame (subsampled), so colours never flicker.
  const sample = [];
  for (let i = 0; i < decoded.length; i += 4) sample.push(decoded[i].rgba);
  const all = new Uint8Array(sample.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of sample) {
    all.set(a, o);
    o += a.length;
  }
  const palette = quantize(all, 255, { format: 'rgb565' });
  while (palette.length < 256) palette.push([0, 0, 0]);
  const TRANSPARENT = 255;

  const gif = GIFEncoder();
  let prev = null;
  let changedTotal = 0;
  decoded.forEach((d, i) => {
    const index = applyPalette(d.rgba, palette.slice(0, 255), 'rgb565');
    const delay = i === decoded.length - 1 ? HOLD_LAST_MS : FRAME_MS;
    if (!prev) {
      gif.writeFrame(index, width, height, { palette, delay, repeat: 0 });
    } else {
      // Unchanged pixels become transparent: the previous frame shows through (dispose 1 = keep).
      const delta = Uint8Array.from(index);
      let changed = 0;
      for (let p = 0; p < delta.length; p++) {
        if (delta[p] === prev[p]) delta[p] = TRANSPARENT;
        else changed++;
      }
      changedTotal += changed;
      gif.writeFrame(delta, width, height, { delay, transparent: true, transparentIndex: TRANSPARENT, dispose: 1 });
    }
    prev = index;
  });
  gif.finish();
  writeFileSync(out, gif.bytes());

  const bytes = statSync(out).size;
  const seconds = ((frames.length - 1) * FRAME_MS + HOLD_LAST_MS) / 1000;
  const summary = {
    file: relative(ROOT, out).split('\\').join('/'),
    width,
    height,
    frames: frames.length,
    seconds: Number(seconds.toFixed(2)),
    fps: Number((1000 / FRAME_MS).toFixed(1)),
    bytes,
    megabytes: Number((bytes / 1024 / 1024).toFixed(2)),
    meanChangedPixelsPerFrame: Math.round(changedTotal / (frames.length - 1)),
  };
  console.log(JSON.stringify(summary));
  if (bytes > MAX_BYTES) {
    console.error(`${summary.file} is ${summary.megabytes} MB, over the 2.5 MB target`);
    process.exitCode = 1;
  }
}

await main();
