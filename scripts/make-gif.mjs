#!/usr/bin/env node
// Makes docs/images/demo.gif for the README from the browser demo (the fixture backend: synthetic
// runs only, never anything from your disk).
//
//   node scripts/make-gif.mjs
//   ARM_GIF_FRAMES=<folder> node scripts/make-gif.mjs   also saves every frame as a PNG there (to check)
//   ARM_SHOTS_DIR=<folder> node scripts/make-gif.mjs    write demo.gif there instead of docs/images
//
// What it shows, in about 10 seconds: a live run updating; m to add runs to the multiviewer and
// → to step to the next run; Ctrl+K, a palette search and Enter to open a result; g then m to open
// the multiviewer. A small caption names each key as it is pressed (drawn by this script, not part
// of the app).
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
import { join, relative } from 'node:path';
import { chromium } from 'playwright';
import gifenc from 'gifenc';
import { BASE, NOW, OUT_DIR, ROOT, blurActive, decodePng, ensureServer, runClock, startClock, waitReady } from './make-screenshots.mjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const SCALE = 2 / 3; // 1440 x 900 CSS px -> 960 x 600 frames
const FRAME_MS = 110; // spacing between frames when capturing, and how long each frame plays (about 9 fps)
const HOLD_LAST_MS = 1200; // the last frame stays up a little before the clip loops
const OUT = join(OUT_DIR, 'demo.gif');
const MAX_BYTES = 2.5 * 1024 * 1024;
/** Fake time (after NOW) at which recording starts. Longer than the set-up before the first frame. */
const RECORD_AT_MS = 20_000;

const frames = []; // PNG buffers

async function main() {
  const stop = await ensureServer();
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: SCALE,
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
    });
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

    // Start on the live Claude Code run.
    await page
      .getByTestId('run-list')
      .locator('[role="option"][data-status="running"]')
      .filter({ hasText: 'todo-cli' })
      .first()
      .click();
    await blurActive(page);
    await page.waitForTimeout(600);

    // From here the page's clock only moves when a frame is taken.
    const fakeNow = await page.evaluate(() => Date.now());
    if (fakeNow > NOW + RECORD_AT_MS) throw new Error(`set-up took longer than RECORD_AT_MS (${fakeNow - NOW} ms)`);
    await page.clock.pauseAt(NOW + RECORD_AT_MS);
    const rec = recorder(page, await context.newCDPSession(page));

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

    if (errors.length) console.error(`page errors: ${errors.join(' | ')}`);
  } finally {
    await browser.close();
    stop();
  }
  encode();
}

/** Takes frames no closer than FRAME_MS apart, moving the page's paused clock FRAME_MS per frame. */
function recorder(page, cdp) {
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

function encode() {
  if (frames.length < 2) throw new Error('no frames recorded');
  const dump = process.env.ARM_GIF_FRAMES;
  if (dump) {
    mkdirSync(dump, { recursive: true });
    frames.forEach((png, i) => writeFileSync(join(dump, `frame-${String(i).padStart(3, '0')}.png`), png));
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
  writeFileSync(OUT, gif.bytes());

  const bytes = statSync(OUT).size;
  const seconds = ((frames.length - 1) * FRAME_MS + HOLD_LAST_MS) / 1000;
  const summary = {
    file: relative(ROOT, OUT).split('\\').join('/'),
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
    console.error(`demo.gif is ${summary.megabytes} MB, over the 2.5 MB target`);
    process.exitCode = 1;
  }
}

await main();
