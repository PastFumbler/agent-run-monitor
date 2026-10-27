#!/usr/bin/env node
// Runtime half of the Smart App Control audit (Windows only). Launches the PACKAGED app with a
// throw-away profile seeded from test/fixtures, drives the main features with Playwright, and
// meanwhile records every process in the app's process tree and every module each one loads,
// plus the files the app creates in its profile and temp folder. Anything that appears only at
// runtime (not in the static file list of the app folder) is signature-checked with the same
// code as scripts/check-blocks.ps1 and reported with the step that first loaded it.
//
//   node scripts/runtime-modules.mjs --exe "release/<version>/win-unpacked/Agent Run Monitor.exe"
//        [--out <dir>] [--fixtures test/fixtures] [--keep] [--strict]
//
// Writes <out>/runtime-modules.json and <out>/runtime-modules.md (default out: ./sac-report).
// Merge it into the static report with:
//   scripts/check-blocks.ps1 ... -RuntimeReport <out>/runtime-modules.json
//
// The process and module list comes from a child PowerShell polling Get-CimInstance
// Win32_Process and Get-Process .Modules. That is test tooling only: the app itself starts no
// child processes of its own beyond Electron's helpers. ARM_E2E=1 turns off OS notifications and
// login-item changes, so those code paths are not exercised here (see docs/BLOCK-TEST.md).
// Exit: 0 report written, 1 a step failed and --strict was given, 2 the app could not be run.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ---- arguments ------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const flag = (name) => args.includes(`--${name}`);
if (flag('help') || flag('h') || !opt('exe')) {
  console.log('usage: node scripts/runtime-modules.mjs --exe <packaged app exe> [--out <dir>] [--fixtures <dir>] [--keep] [--strict]');
  process.exit(flag('help') || flag('h') ? 0 : 2);
}
if (process.platform !== 'win32') {
  console.error('runtime-modules.mjs records Windows modules and signatures; run it on Windows.');
  process.exit(2);
}
const EXE = path.resolve(opt('exe'));
const EXE_DIR = path.dirname(EXE);
const OUT = path.resolve(opt('out', 'sac-report'));
const FIXTURES = path.resolve(opt('fixtures', path.join(REPO, 'test', 'fixtures')));
const KEEP = flag('keep');
const STRICT = flag('strict');
const CHECK_BLOCKS = path.join(HERE, 'check-blocks.ps1');
if (!existsSync(EXE)) {
  console.error(`not found: ${EXE}`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

// ---- throw-away profile ---------------------------------------------------------------------------

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'arm-runtime-'));
const USER_DATA = path.join(ROOT, 'userdata');
const HOME = path.join(ROOT, 'home');
const TEMP = path.join(HOME, 'AppData', 'Local', 'Temp');
for (const d of [USER_DATA, HOME, TEMP]) mkdirSync(d, { recursive: true });

/** Copies of the synthetic fixtures, laid out where each agent keeps its sessions. */
function seedProfile() {
  const copy = (from, to, filter) => {
    const src = path.join(FIXTURES, from);
    if (!existsSync(src)) return;
    const dest = path.join(HOME, to);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, filter: filter ?? (() => true) });
  };
  copy('claude-code/claude-config', '.claude');
  copy('codex', '.codex/sessions', (s) => statSync(s).isDirectory() || /rollout-.*\.jsonl$/.test(s));
  copy('codex/session_index.jsonl', '.codex/session_index.jsonl');
  copy('codex/history.jsonl', '.codex/history.jsonl');
  copy('gemini/gemini-home/.gemini', '.gemini');
  copy('gemini/qwen-home/.qwen', '.qwen');
  copy('copilot/cli/session-state', '.copilot/session-state');
  copy('copilot/vscode/User', 'AppData/Roaming/Code/User');
  copy('aider/projects/todo-cli/.aider.chat.history.md', '.aider.chat.history.md');
  copy('opencode/v1-json/storage', '.local/share/opencode/storage');
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

// The same type list as check-blocks.ps1 ($PeExts + $ScriptExts + $PackageExts + $MotwExts).
const EXEC_EXTS = new Set(
  [
    '.exe .dll .node .sys .drv .ocx .cpl .scr .com .efi .mui .ax .tlb .winmd',
    '.ps1 .psm1 .psd1 .js .jse .vbs .vbe .vb .wsf .wsh .hta .bat .cmd',
    '.msi .msp .msix .msixbundle .appx .appxbundle .appref-ms .ppkg',
    '.chm .gadget .iso .lnk .msc .pif .printerexport .rdp .reg .scf .settingcontent-ms .url .vhd .vhdx .vxd .wcx .website',
  ]
    .join(' ')
    .split(' '),
);
/** A PE image whatever its extension (starts with "MZ"), like Test-IsPe in check-blocks.ps1. */
function startsWithMz(p) {
  let fd;
  try {
    fd = openSync(p, 'r');
    const b = Buffer.alloc(2);
    return readSync(fd, b, 0, 2, 0) === 2 && b[0] === 0x4d && b[1] === 0x5a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
const isExecType = (p) => EXEC_EXTS.has(path.extname(p).toLowerCase()) || startsWithMz(p);
const key = (p) => path.resolve(p).toLowerCase();
const SYSTEM_ROOT = key(process.env.SystemRoot || 'C:\\Windows');
const under = (p, dir) => key(p).startsWith(key(dir) + path.sep) || key(p) === key(dir);

// ---- process and module monitor -------------------------------------------------------------------

const MONITOR_PS = String.raw`
param([int]$RootPid, [string]$StopFile)
$ErrorActionPreference = 'SilentlyContinue'
while (-not (Test-Path -LiteralPath $StopFile)) {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate)
  $created = @{}
  foreach ($p in $all) { $created[[int]$p.ProcessId] = $p.CreationDate }
  $tree = @{}; $tree[$RootPid] = $true
  do {
    $added = $false
    foreach ($p in $all) {
      $id = [int]$p.ProcessId; $parent = [int]$p.ParentProcessId
      # A child must start after its parent: an older process whose dead parent's PID was reused
      # by the app is not part of the tree.
      if (-not $tree.ContainsKey($id) -and $tree.ContainsKey($parent) -and $p.CreationDate -ge $created[$parent]) { $tree[$id] = $true; $added = $true }
    }
  } while ($added)
  $procs = @($all | Where-Object { $tree.ContainsKey([int]$_.ProcessId) } | ForEach-Object {
    $mods = @()
    try { $mods = @((Get-Process -Id $_.ProcessId -ErrorAction Stop).Modules | ForEach-Object { $_.FileName }) } catch { }
    [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; path = $_.ExecutablePath; cmd = $_.CommandLine; modules = $mods }
  })
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject ([pscustomobject]@{ t = (Get-Date).ToString('o'); procs = $procs }) -Depth 4 -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 400
}
`;

let currentStep = 'launch';
let rootPid = 0;
let samples = 0;
const processes = new Map(); // pid -> info
const modules = new Map(); // key(path) -> { path, firstSeenStep, processes:Set }
const filesCreated = new Map(); // key(path) -> { path, step }

function processType(cmd) {
  const m = /--type=([a-z-]+)/i.exec(cmd || '');
  return m ? m[1] : 'main';
}

function onSample(sample) {
  samples++;
  for (const p of sample.procs || []) {
    // On Windows Playwright starts the app through a cmd.exe wrapper: that is the harness, not the app.
    if (p.pid === rootPid && /(^|[/\\])cmd\.exe$/i.test(p.path || p.name || '')) continue;
    if (!processes.has(p.pid)) {
      const cmd = String(p.cmd || '').split(ROOT).join('<profile>').slice(0, 400);
      processes.set(p.pid, { pid: p.pid, ppid: p.ppid, name: p.name, path: p.path, type: processType(p.cmd), cmd, firstSeenStep: currentStep, moduleCount: 0 });
    }
    const info = processes.get(p.pid);
    const label = `${p.name} (${info.type})`;
    const mods = Array.isArray(p.modules) ? p.modules : p.modules ? [p.modules] : [];
    info.moduleCount = Math.max(info.moduleCount, mods.length);
    for (const m of [p.path, ...mods]) {
      if (!m) continue;
      const k = key(m);
      if (!modules.has(k)) modules.set(k, { path: m, firstSeenStep: currentStep, processes: new Set(), isProcessImage: m === p.path });
      modules.get(k).processes.add(label);
    }
  }
}

function startMonitor(rootPid) {
  const script = path.join(ROOT, 'monitor.ps1');
  const stopFile = path.join(ROOT, 'monitor.stop');
  writeFileSync(script, MONITOR_PS);
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-RootPid', String(rootPid), '-StopFile', stopFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        onSample(JSON.parse(line));
      } catch {
        /* partial or non-JSON line */
      }
    }
  });
  const done = new Promise((r) => child.on('exit', r));
  return {
    stop: async () => {
      writeFileSync(stopFile, '');
      await Promise.race([done, sleep(15000)]);
      child.kill();
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until the monitor has taken `n` more samples (so the step's modules are recorded). */
async function settle(n = 2, maxMs = 8000) {
  const target = samples + n;
  const until = Date.now() + maxMs;
  while (samples < target && Date.now() < until) await sleep(100);
}

let profileBaseline = new Set();
function scanProfile() {
  for (const f of walkFiles(ROOT)) {
    const k = key(f);
    if (profileBaseline.has(k) || filesCreated.has(k)) continue;
    if (path.basename(f).startsWith('monitor.')) continue;
    filesCreated.set(k, { path: f, step: currentStep });
  }
}

// ---- driving the app ------------------------------------------------------------------------------

const steps = [];

async function step(name, fn) {
  currentStep = name;
  const started = Date.now();
  const rec = { name, result: 'ok', detail: '', ms: 0 };
  try {
    const detail = await fn();
    if (typeof detail === 'string') rec.detail = detail;
  } catch (e) {
    rec.result = 'error';
    rec.detail = String(e?.message || e).split('\n')[0].slice(0, 300);
  }
  await settle();
  scanProfile();
  rec.ms = Date.now() - started;
  steps.push(rec);
  console.log(`  ${rec.result === 'ok' ? 'ok   ' : 'ERROR'} ${name}${rec.detail ? ` - ${rec.detail}` : ''}`);
}

const visible = (loc) => loc.isVisible().catch(() => false);

async function waitVisible(loc, ms = 7000) {
  await loc.first().waitFor({ state: 'visible', timeout: ms });
}

async function run() {
  let pw;
  try {
    pw = await import('@playwright/test');
  } catch {
    console.error('Playwright is missing: run npm ci first.');
    process.exit(2);
  }
  seedProfile();
  profileBaseline = new Set(walkFiles(ROOT).map(key));

  const env = { ...process.env, ARM_USER_DATA: USER_DATA, ARM_HOME: HOME, ARM_E2E: '1', TEMP, TMP: TEMP };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;

  console.log(`Launching ${EXE}`);
  let app;
  try {
    app = await pw._electron.launch({ executablePath: EXE, args: [], env, timeout: 60_000 });
  } catch (e) {
    console.error(`could not launch the app: ${e?.message || e}`);
    rmSync(ROOT, { recursive: true, force: true });
    process.exit(2);
  }
  rootPid = app.process().pid;
  const monitor = startMonitor(rootPid);
  const page = await app.firstWindow();
  const runList = page.getByTestId('run-list');
  const options = runList.getByRole('option');
  const runTitle = page.getByTestId('run-title');

  await step('launch', async () => {
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#root > *').first().waitFor({ timeout: 20_000 });
    // The monitor's first sample can take a few seconds (PowerShell and CIM start-up): wait for
    // it so the start-up modules are attributed to this step.
    const until = Date.now() + 30_000;
    while (samples === 0 && Date.now() < until) await sleep(200);
    if (samples === 0) throw new Error('the process monitor produced no sample in 30 s');
    return `window "${await page.title()}"`;
  });

  await step('first-run wizard', async () => {
    const wizard = page.locator('[data-testid^="wizard"]');
    if (!(await visible(wizard.first()))) {
      await sleep(1500);
      if (!(await visible(wizard.first()))) return 'no wizard shown';
    }
    const kind = await wizard.first().getAttribute('data-testid');
    const forward = page.getByRole('button', { name: /^(start watching|get started|next|continue|finish|done|start|let's go|looks good|skip)\b/i });
    let clicks = 0;
    for (let i = 0; i < 15 && !(await visible(runList)); i++) {
      const btn = forward.last();
      if (await visible(btn)) {
        await btn.click();
        clicks++;
      }
      await sleep(500);
    }
    await waitVisible(runList, 10_000);
    return `${kind}, ${clicks} click(s) to finish`;
  });

  await step('open runs', async () => {
    await waitVisible(options, 20_000);
    const n = Math.min(await options.count(), 6);
    const titles = [];
    for (let i = 0; i < n; i++) {
      await options.nth(i).click();
      await waitVisible(runTitle);
      titles.push((await runTitle.textContent())?.trim() ?? '');
      await sleep(300);
    }
    return `${n} runs opened`;
  });

  await step('switch views', async () => {
    const ids = ['view-activity', 'view-overview', 'view-files', 'view-tools', 'view-timeline'];
    const seen = [];
    for (let i = 0; i < ids.length; i++) {
      await page.locator('main').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
      await page.keyboard.press(String(i + 1));
      if (await page.getByTestId(ids[i]).waitFor({ timeout: 4000 }).then(() => true, () => false)) seen.push(ids[i]);
    }
    if (!seen.length) throw new Error('no run view appeared');
    return `views shown: ${seen.join(', ')}`;
  });

  await step('multiviewer', async () => {
    const n = Math.min(await options.count(), 4);
    for (let i = 0; i < n; i++) {
      await options.nth(i).click();
      await page.keyboard.press('m');
      await sleep(200);
    }
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    const mv = page.locator('[data-testid^="multiview"]');
    await waitVisible(mv, 8000);
    const kind = await mv.first().getAttribute('data-testid');
    await sleep(2500); // let tiles load their runs
    return `${kind} with ${n} runs picked`;
  });

  await step('settings and theme', async () => {
    await page.keyboard.press('Escape');
    const before = await page.locator('html').getAttribute('data-theme');
    await page.keyboard.press('Control+Comma');
    const settings = page.locator('[data-testid^="settings"]');
    await waitVisible(settings, 8000);
    const kind = await settings.first().getAttribute('data-testid');
    const target = before === 'harbor' ? /paper/i : /harbor/i;
    let how = 'settings screen';
    const choice = settings.first().getByRole('radio', { name: target }).or(settings.first().getByRole('button', { name: target }));
    if (await visible(choice.first())) {
      await choice.first().click();
    } else {
      how = 'command palette (settings screen has no theme control in this build)';
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+K');
      await page.getByRole('combobox').first().fill(`theme ${before === 'harbor' ? 'paper' : 'harbor'}`);
      await page.keyboard.press('Enter');
    }
    await page.waitForFunction((b) => document.documentElement.getAttribute('data-theme') !== b, before, { timeout: 5000 });
    const after = await page.locator('html').getAttribute('data-theme');
    return `${kind}; theme ${before} -> ${after} via ${how}`;
  });

  await step('idle', async () => {
    await sleep(4000);
    return 'watching for late loads';
  });

  currentStep = 'shutdown';
  await app.close().catch(() => {});
  await settle(1, 3000);
  await monitor.stop();
  scanProfile();

  // ---- analysis -----------------------------------------------------------------------------------

  const staticSet = new Set(walkFiles(EXE_DIR).map(key));
  const locate = (p) => {
    if (under(p, EXE_DIR)) return 'app';
    if (under(p, TEMP)) return 'temp';
    if (under(p, ROOT)) return 'profile';
    if (under(p, SYSTEM_ROOT)) return 'system';
    return 'other';
  };
  const runtimeOnly = [...modules.values()]
    .filter((m) => !staticSet.has(key(m.path)))
    .map((m) => ({ path: m.path, kind: m.isProcessImage ? 'process' : 'module', location: locate(m.path), firstSeenStep: m.firstSeenStep, processName: [...m.processes].join(', ') }));
  for (const f of filesCreated.values()) {
    if (isExecType(f.path) && !modules.has(key(f.path))) {
      runtimeOnly.push({ path: f.path, kind: 'file', location: locate(f.path), firstSeenStep: f.step, processName: 'written by the app' });
    }
  }

  // Same signature check as the static audit.
  const listFile = path.join(ROOT, 'paths.txt');
  const sigFile = path.join(ROOT, 'signatures.json');
  writeFileSync(listFile, runtimeOnly.map((r) => r.path).join('\r\n'));
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CHECK_BLOCKS, '-SignatureOnly', '-PathList', listFile, '-ReportPath', sigFile], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 600_000,
  });
  const notes = [];
  let sigs = [];
  if (ps.status === 0 && existsSync(sigFile)) {
    sigs = JSON.parse(readFileSync(sigFile, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(sigs)) sigs = [sigs];
  } else {
    notes.push(`signature check failed: ${(ps.stderr || ps.error?.message || '').trim().slice(0, 300)}`);
  }
  const sigByPath = new Map(sigs.map((s) => [key(s.path), s]));
  for (const r of runtimeOnly) {
    const s = sigByPath.get(key(r.path));
    r.exists = s ? s.exists : existsSync(r.path);
    r.isPe = s?.isPe ?? false;
    r.signature = s?.signature ?? null;
  }
  runtimeOnly.sort((a, b) => a.location.localeCompare(b.location) || a.path.localeCompare(b.path));

  notes.push('ARM_E2E=1: OS notifications and the start-with-Windows login item are off in this pass, so their code paths were not exercised.');
  notes.push('Static list = every file under the app folder; a runtime-only file is anything loaded or written that is not in it.');
  const appProcs = [...processes.values()];
  const nonApp = runtimeOnly.filter((r) => r.location !== 'system');
  const unsignedNonSystem = nonApp.filter((r) => r.isPe && r.signature && r.signature.status !== 'Valid');

  const report = {
    generated: new Date().toISOString(),
    exe: EXE,
    exeDir: EXE_DIR,
    profile: ROOT,
    steps,
    processes: appProcs,
    modulesSeen: modules.size,
    runtimeOnly,
    filesCreated: [...filesCreated.values()].map((f) => ({ path: path.relative(ROOT, f.path), step: f.step, executableType: isExecType(f.path) })),
    summary: {
      stepsOk: steps.filter((s) => s.result === 'ok').length,
      stepsFailed: steps.filter((s) => s.result !== 'ok').length,
      processes: appProcs.length,
      modulesSeen: modules.size,
      runtimeOnly: runtimeOnly.length,
      runtimeOnlyOutsideWindows: nonApp.length,
      unsignedOutsideWindows: unsignedNonSystem.length,
    },
    notes,
  };
  const jsonPath = path.join(OUT, 'runtime-modules.json');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
  const short = (subj) => (subj ? (/CN=("[^"]+"|[^,]+)/.exec(subj)?.[1] ?? subj).replace(/"/g, '') : '');
  const md = [];
  md.push('# Runtime module check', '');
  md.push(`Generated ${report.generated} for \`${path.basename(EXE)}\`.`, '');
  md.push('| | |', '|---|---|');
  md.push(`| Steps | ${report.summary.stepsOk} ok, ${report.summary.stepsFailed} failed |`);
  md.push(`| Processes in the app's tree | ${appProcs.length} |`);
  md.push(`| Distinct modules loaded | ${modules.size} |`);
  md.push(`| Loaded or written only at runtime | ${runtimeOnly.length} (${nonApp.length} outside the Windows folder) |`);
  md.push(`| Unsigned or invalid PE outside the Windows folder | ${unsignedNonSystem.length} |`, '');
  md.push('## Steps', '', '| Step | Result | Detail |', '|---|---|---|');
  for (const s of steps) md.push(`| ${s.name} | ${s.result} | ${esc(s.detail)} |`);
  md.push('', '## Processes', '', '| PID | Type | Image | First seen | Modules |', '|---|---|---|---|---|');
  for (const p of appProcs) md.push(`| ${p.pid} | ${p.type} | ${esc(p.path && under(p.path, EXE_DIR) ? path.relative(EXE_DIR, p.path) : p.path || p.name)} | ${p.firstSeenStep} | ${p.moduleCount} |`);
  const foreign = appProcs.filter((p) => !(p.path && under(p.path, EXE_DIR)));
  if (foreign.length) {
    md.push('', `Processes in the tree that are not the app's own executable (command lines, profile path shortened):`, '');
    for (const p of foreign) md.push(`- ${p.pid} ${esc(p.name)}: \`${p.cmd.replace(/`/g, "'")}\``);
  }
  md.push('', '## Runtime-only files (outside the Windows folder)', '');
  if (!nonApp.length) md.push('None: every module and process image outside %SystemRoot% came from the app folder.');
  else {
    md.push('| Location | Kind | File | First seen in step | Loaded by | Status | Signer |', '|---|---|---|---|---|---|---|');
    for (const r of nonApp) md.push(`| ${r.location} | ${r.kind} | ${esc(r.path)} | ${r.firstSeenStep} | ${esc(r.processName)} | ${r.signature?.status ?? (r.exists ? '?' : 'gone')} | ${esc(short(r.signature?.signerSubject))} |`);
  }
  const sys = runtimeOnly.filter((r) => r.location === 'system');
  const sysBad = sys.filter((r) => r.signature && r.signature.status !== 'Valid');
  md.push('', '## Windows files loaded', '');
  md.push(`${sys.length} files from %SystemRoot% (${sys.filter((r) => r.signature?.signatureType === 'Catalog').length} catalog-signed). ${sysBad.length ? `Not Valid: ${sysBad.map((r) => `${path.basename(r.path)} (${r.signature.status})`).join(', ')}` : 'All Valid.'}`);
  md.push('', '<details><summary>Full list with the step that first loaded each</summary>', '', '| File | Step | Status | Type |', '|---|---|---|---|');
  for (const r of sys) md.push(`| ${esc(path.basename(r.path))} | ${r.firstSeenStep} | ${r.signature?.status ?? '?'} | ${r.signature?.signatureType ?? ''} |`);
  md.push('', '</details>', '', '## Files created in the profile', '');
  const created = report.filesCreated;
  md.push(`${created.length} files (${created.filter((f) => f.executableType).length} of an executable type).`, '');
  if (created.length) {
    md.push('| File | Step | Executable type |', '|---|---|---|');
    for (const f of created.slice(0, 200)) md.push(`| ${esc(f.path)} | ${f.step} | ${f.executableType ? 'yes' : ''} |`);
    if (created.length > 200) md.push(`| ... ${created.length - 200} more in the JSON | | |`);
  }
  md.push('', '## Notes', '');
  for (const n of notes) md.push(`- ${n}`);
  const mdPath = path.join(OUT, 'runtime-modules.md');
  writeFileSync(mdPath, md.join('\n') + '\n');

  if (!KEEP) rmSync(ROOT, { recursive: true, force: true });
  console.log(`\nruntime check: ${report.summary.stepsOk}/${steps.length} steps ok, ${processes.size} processes, ${modules.size} modules, ${runtimeOnly.length} runtime-only (${nonApp.length} outside Windows, ${unsignedNonSystem.length} unsigned/invalid PE)`);
  console.log(`  ${mdPath}\n  ${jsonPath}`);
  process.exit(STRICT && report.summary.stepsFailed ? 1 : 0);
}

run().catch((e) => {
  console.error(e?.stack || e);
  process.exit(2);
});
