#!/usr/bin/env node
// Measures GPU and CPU use of the REAL Electron app (the build in out/) on Windows, with live
// synthetic runs, under several conditions. Run `npm run build` first.
//
//   node scripts/measure-gpu.mjs [--out <dir>] [--seconds 60] [--settle 20] [--repeats 3]
//                                [--conditions grid-off,grid-on,minimised,single]
//
// What it does:
// 1. Starts scripts/simulate-live-runs.mjs into a fresh temporary home (--count 30 --seed 270:
//    with that seed, 12 of the 30 sessions keep working for about 18 minutes; the rest finish,
//    fail, wait or stall within the first minute). It keeps running through every measurement.
// 2. After a minute, launches the app once (Playwright) and asks window.armBackend.listRuns() for
//    the runs that are still being written: those 12 ids become a saved layout.
// 3. For each condition, launches the app with a fresh settings folder (ARM_USER_DATA) seeded
//    with settings.json and window-state.json, ARM_HOME pointing at the simulator's home and,
//    for the grid conditions, ARM_OPEN_LAYOUT naming the layout. The window is set to 1600x1000,
//    kept on top (so it is never occluded) and focused. After --settle seconds,
//    scripts/measure-gpu.ps1 samples the app's process tree every second for --seconds seconds.
//    Conditions:
//      grid-off   12 tiles, low GPU off           (repeated --repeats times)
//      grid-on    12 tiles, low GPU on            (repeated --repeats times, interleaved)
//      minimised  12 tiles, low GPU off, window minimised
//      single     one live run in the run view, low GPU off
// 4. Writes <out>/gpu-raw/<condition>.jsonl (per-second samples) and <out>/gpu-measure.json
//    (per-condition statistics), and prints a table.
//
// Only synthetic data is involved: the app never sees the real home (ARM_HOME), and nothing
// about other processes on the machine is recorded except an aggregate of their 3D engine use.
//
// ELECTRON_RUN_AS_NODE is removed from the app's environment (some shells set it, and Electron
// then starts as plain Node).

import { _electron } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'arm-gpu-measure')));
const SECONDS = Number(opt('seconds', 60));
const SETTLE = Number(opt('settle', 20));
const REPEATS = Number(opt('repeats', 3));
const WANT = new Set(opt('conditions', 'grid-off,grid-on,minimised,single').split(','));
const LAYOUT = 'gpu-12';
const BOUNDS = { x: 100, y: 16, width: 1600, height: 1000 };
const SIM = { count: 30, seed: 270, duration: 1500 };

if (process.platform !== 'win32') {
  console.error('measure-gpu needs Windows (GPU Engine performance counters).');
  process.exit(2);
}
if (!existsSync(path.join(REPO, 'out/main/index.js'))) {
  console.error('No build in out/. Run npm run build first.');
  process.exit(2);
}

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(path.join(OUT, 'gpu-raw'), { recursive: true });

// ---- simulator ---------------------------------------------------------------------------------------

const work = mkdtempSync(path.join(os.tmpdir(), 'arm-gpu-'));
const home = path.join(work, 'home');
const claudeDir = path.join(home, '.claude');
mkdirSync(claudeDir, { recursive: true });
const sim = spawn(
  process.execPath,
  [path.join(REPO, 'scripts/simulate-live-runs.mjs'), '--count', String(SIM.count), '--seed', String(SIM.seed), '--duration', String(SIM.duration), '--dir', claudeDir],
  { stdio: 'ignore' },
);
const simStart = Date.now();
log(`simulator started (pid ${sim.pid}), ${SIM.count} sessions, seed ${SIM.seed}`);

// ---- app launch ------------------------------------------------------------------------------------------

function appEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ARM_HOME', 'ARM_OPEN_LAYOUT', 'ARM_USER_DATA']) delete env[k];
  return { ...env, ARM_E2E: '1', ARM_HOME: home, ...extra };
}

function settingsFor(lowGpu, runIds) {
  return {
    version: 1,
    firstRunComplete: true,
    notifyOnFinish: false,
    notifyOnFailure: false,
    lowGpu,
    reduceMotion: 'off',
    synonyms: true,
    fakeProgress: true,
    gridTileLimit: 12,
    layouts: runIds ? [{ name: LAYOUT, runIds }] : [],
  };
}

async function launch({ lowGpu, runIds, openLayout }) {
  const userData = mkdtempSync(path.join(work, 'userdata-'));
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settingsFor(lowGpu, runIds), null, 2));
  writeFileSync(path.join(userData, 'window-state.json'), JSON.stringify({ ...BOUNDS, maximized: false }));
  const env = appEnv({ ARM_USER_DATA: userData, ...(openLayout ? { ARM_OPEN_LAYOUT: LAYOUT } : {}) });
  const app = await _electron.launch({ args: ['.'], cwd: REPO, env, timeout: 60_000 });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userData };
}

async function showWindow(app) {
  return app.evaluate(({ BrowserWindow }, b) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w.isMinimized()) w.restore();
    w.setBounds(b);
    w.setAlwaysOnTop(true, 'floating');
    w.show();
    w.moveTop();
    w.focus();
    const r = w.getBounds();
    return { focused: w.isFocused(), visible: w.isVisible(), minimized: w.isMinimized(), width: r.width, height: r.height };
  }, BOUNDS);
}

// Renderer-side state: policy attributes, running animations, tiles, and event counters.
async function rendererState(page) {
  return page.evaluate(() => {
    const html = document.documentElement;
    const anims = document.getAnimations();
    const running = anims.filter((a) => a.playState === 'running');
    const infinite = running.filter((a) => a.effect?.getTiming?.().iterations === Infinity);
    const names = {};
    for (const a of running) {
      const n = a.animationName || a.transitionProperty || a.constructor.name;
      names[n] = (names[n] ?? 0) + 1;
    }
    const grid = document.querySelector('[data-testid="mv-grid"]');
    return {
      lowGpuAttr: html.hasAttribute('data-low-gpu'),
      reduceMotionAttr: html.hasAttribute('data-reduce-motion'),
      hiddenAttr: html.hasAttribute('data-hidden'),
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      tiles: grid ? Number(grid.getAttribute('data-tile-count')) : 0,
      grid: grid?.getAttribute('data-grid') ?? null,
      pausedTiles: document.querySelectorAll('[data-tile-id][data-paused]').length,
      runViewOpen: !!document.querySelector('.runview'),
      animations: { total: anims.length, running: running.length, infinite: infinite.length, byName: names },
      counters: globalThis.__armGpuCounters ?? null,
    };
  });
}

async function startCounters(page) {
  await page.evaluate(() => {
    if (globalThis.__armGpuCounters) {
      Object.assign(globalThis.__armGpuCounters, { detail: 0, runs: 0, since: Date.now() });
      return;
    }
    const c = { detail: 0, runs: 0, since: Date.now() };
    globalThis.__armGpuCounters = c;
    window.armBackend.onRunDetail(() => c.detail++);
    window.armBackend.onRunsUpdate(() => c.runs++);
  });
}

// ---- sampling ---------------------------------------------------------------------------------------------

function sample(rootPid, file) {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'scripts/measure-gpu.ps1'), '-RootPid', String(rootPid), '-Seconds', String(SECONDS), '-OutFile', file],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    ps.stderr.on('data', (d) => (err += d));
    ps.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`measure-gpu.ps1 exited ${code}: ${err.slice(0, 500)}`))));
  });
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const r2 = (x) => Math.round(x * 100) / 100;
const stats = (xs) => ({ mean: r2(mean(xs)), p95: r2(pct(xs, 95)), max: r2(Math.max(0, ...xs)) });

function analyse(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const processes = lines[0]?.processes ?? [];
  const typeOf = new Map(processes.map((p) => [String(p.pid), p.type]));
  const maxEngine = [];
  const sum3d = [];
  const gpuProcMax = [];
  const other3d = [];
  const cpu = [];
  const cpuByType = {};
  const enginesUsed = new Set();
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const byEngine = new Map();
    let s3 = 0;
    let gMax = 0;
    for (const [key, v] of Object.entries(L.tree ?? {})) {
      const [pid, luid, phys, eng, type] = key.split('|');
      const ek = `${luid}|${phys}|${eng}|${type}`;
      byEngine.set(ek, (byEngine.get(ek) ?? 0) + v);
      if (type === '3d') s3 += v;
      if (typeOf.get(pid) === 'gpu-process') gMax = Math.max(gMax, v);
      if (v > 0.05) enginesUsed.add(`${typeOf.get(pid) ?? pid}:${type}@${luid}`);
    }
    maxEngine.push(Math.max(0, ...byEngine.values()));
    sum3d.push(s3);
    gpuProcMax.push(gMax);
    other3d.push(L.other3d ?? 0);
    if (i > 0) {
      const dt = (Date.parse(L.t) - Date.parse(lines[i - 1].t)) / 1000;
      if (dt > 0) {
        cpu.push(((L.cpu - lines[i - 1].cpu) / dt) * 100);
        const perType = {};
        for (const [pid, sec] of Object.entries(L.cpuByPid ?? {})) {
          const prev = lines[i - 1].cpuByPid?.[pid];
          if (prev === undefined) continue;
          const type = typeOf.get(pid) ?? 'other';
          perType[type] = (perType[type] ?? 0) + ((sec - prev) / dt) * 100;
        }
        for (const [type, v] of Object.entries(perType)) (cpuByType[type] ??= []).push(v);
      }
    }
  }
  const cores = os.cpus().length;
  return {
    samples: lines.length,
    processes: processes.map((p) => p.type),
    gpuMaxEngine: stats(maxEngine),
    gpu3dSum: stats(sum3d),
    gpuProcessMaxEngine: stats(gpuProcMax),
    cpuPercentOfOneCore: stats(cpu),
    cpuPercentOfMachine: { mean: r2(mean(cpu) / cores), p95: r2(pct(cpu, 95) / cores) },
    cpuPercentOfOneCoreByProcess: Object.fromEntries(Object.entries(cpuByType).map(([t, xs]) => [t, r2(mean(xs))])),
    background3dOtherProcesses: stats(other3d),
    enginesUsed: [...enginesUsed].sort(),
  };
}

// ---- background load ----------------------------------------------------------------------------------------

async function backgroundSnapshot() {
  const ps = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "$c = Get-CimInstance Win32_Process; " +
        "$h = @($c | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match '--headless' -and $_.CommandLine -notmatch '--type=' }).Count; " +
        "$ch = @($c | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -notmatch '--type=' }).Count; " +
        "$e = @($c | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -notmatch '--type=' }).Count; " +
        "$n = @($c | Where-Object { $_.Name -eq 'node.exe' }).Count; " +
        "$l = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; " +
        "@{ chromeBrowsers = $ch; headlessChromeBrowsers = $h; electronApps = $e; nodeProcesses = $n; cpuLoadPercent = $l } | ConvertTo-Json -Compress",
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let out = '';
  ps.stdout.on('data', (d) => (out += d));
  await new Promise((r) => ps.on('exit', r));
  try {
    return JSON.parse(out);
  } catch {
    return { error: 'could not read' };
  }
}

// ---- main -----------------------------------------------------------------------------------------------------

const results = { startedAt: new Date().toISOString(), seconds: SECONDS, settle: SETTLE, window: BOUNDS, simulator: SIM, conditions: [] };

async function discover() {
  const wait = 60_000 - (Date.now() - simStart);
  if (wait > 0) {
    log(`waiting ${Math.round(wait / 1000)} s for the short sessions to end`);
    await sleep(wait);
  }
  const { app, page, userData } = await launch({ lowGpu: 'off' });
  try {
    // Every session listed, then two snapshots 8 s apart: live runs are the ones whose event count grew.
    const list = () => page.evaluate(() => window.armBackend.listRuns());
    const deadline = Date.now() + 60_000;
    while ((await list()).length < SIM.count && Date.now() < deadline) await sleep(1000);
    await sleep(3000);
    const first = new Map((await list()).map((r) => [r.id, r.counts.events]));
    await sleep(8000);
    const runs = await list();
    results.gpuInfo = await app.evaluate(async ({ app: a }) => {
      const info = await a.getGPUInfo('basic');
      return (info.gpuDevice ?? []).map((d) => ({ vendorId: d.vendorId, deviceId: d.deviceId, active: d.active }));
    });
    const statusCounts = {};
    for (const r of runs) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    const live = runs.filter((r) => r.counts.events > (first.get(r.id) ?? Infinity)).sort((a, b) => a.id.localeCompare(b.id));
    results.discovery = { runs: runs.length, statusCounts, liveWriting: live.length };
    log(`discovery: ${runs.length} runs ${JSON.stringify(statusCounts)}, ${live.length} being written`);
    if (live.length < 12) throw new Error(`only ${live.length} live runs`);
    return { liveIds: live.slice(0, 12).map((r) => r.id) };
  } finally {
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
  }
}

async function runCondition(name, label, { lowGpu, liveIds, grid, minimise }) {
  log(`${label}: launching (lowGpu ${lowGpu})`);
  const { app, page, userData } = await launch({ lowGpu, runIds: grid ? liveIds : undefined, openLayout: grid });
  try {
    const win = await showWindow(app);
    if (grid) {
      await page.waitForFunction(() => Number(document.querySelector('[data-testid="mv-grid"]')?.getAttribute('data-tile-count')) === 12, null, { timeout: 60_000 });
    } else {
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="run-list"] [role="option"]').length > 0, null, { timeout: 60_000 });
      await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('arm:ev:openRun', id), liveIds[0]);
      await page.waitForSelector('.runview', { timeout: 30_000 });
    }
    await showWindow(app);
    await sleep(SETTLE * 1000);
    if (minimise) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await sleep(5000);
    } else {
      await showWindow(app);
    }
    await startCounters(page);
    const before = await rendererState(page);
    const bg = await backgroundSnapshot();
    // The Electron main process itself (on Windows, Playwright's spawned pid is a launcher above it).
    const pid = await app.evaluate(() => process.pid);
    const file = path.join(OUT, 'gpu-raw', `${label}.jsonl`);
    log(`${label}: sampling ${SECONDS} s`);
    const t0 = Date.now();
    await sample(pid, file);
    const elapsed = (Date.now() - t0) / 1000;
    const after = await rendererState(page);
    const winAfter = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return { focused: w.isFocused(), visible: w.isVisible(), minimized: w.isMinimized() };
    });
    const a = analyse(file);
    const c = after.counters;
    const span = c ? (Date.now() - c.since) / 1000 : elapsed;
    const rec = {
      condition: name,
      label,
      lowGpu,
      window: { atStart: win, atEnd: winAfter },
      background: bg,
      renderer: { atStart: { ...before, counters: undefined }, atEnd: { ...after, counters: undefined } },
      updates: c ? { runDetailPerSec: r2(c.detail / span), runsUpdatePerSec: r2(c.runs / span), seconds: r2(span) } : null,
      ...a,
    };
    results.conditions.push(rec);
    log(
      `${label}: GPU max-engine mean ${a.gpuMaxEngine.mean}% p95 ${a.gpuMaxEngine.p95}% | 3D sum mean ${a.gpu3dSum.mean}% | CPU ${a.cpuPercentOfOneCore.mean}% of a core | detail ${rec.updates?.runDetailPerSec}/s | anims ${after.animations.running} running (${after.animations.infinite} infinite)`,
    );
  } finally {
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
  }
}

try {
  const { liveIds } = await discover();
  const plan = [];
  for (let i = 0; i < REPEATS; i++) {
    if (WANT.has('grid-off')) plan.push(['grid-off', `grid-off-${i + 1}`, { lowGpu: 'off', grid: true }]);
    if (WANT.has('grid-on')) plan.push(['grid-on', `grid-on-${i + 1}`, { lowGpu: 'on', grid: true }]);
  }
  if (WANT.has('minimised')) plan.push(['minimised', 'minimised', { lowGpu: 'off', grid: true, minimise: true }]);
  if (WANT.has('single')) plan.push(['single', 'single', { lowGpu: 'off', grid: false }]);
  for (const [name, label, o] of plan) {
    const age = (Date.now() - simStart) / 1000;
    if (age > 17 * 60) log(`warning: simulator is ${Math.round(age)} s old; busy sessions end around 18 min`);
    await runCondition(name, label, { ...o, liveIds });
  }
} finally {
  sim.kill();
  results.finishedAt = new Date().toISOString();
  writeFileSync(path.join(OUT, 'gpu-measure.json'), JSON.stringify(results, null, 2));
  log(`wrote ${path.join(OUT, 'gpu-measure.json')}`);
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
