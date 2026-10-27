// LOCAL ONLY. Runs the real app against the REAL home folder and a Claude Code session that is
// being written right now (for example the session running this test). Skipped unless
// ARM_REAL_CLAUDE=1, and always skipped in CI.
//
//   ARM_REAL_CLAUDE=1 npx playwright test -c playwright.electron.config.ts --project live-local
//
// ARM_LIVE_SESSION may name the growing *.jsonl; otherwise the setup picks it by modification time
// under ~/.claude/projects, preferring a file that grows during a short check and, among growing
// files, a top-level session over a sub-agent or workflow transcript. ARM_LIVE_REPORT may name a
// JSON file for the results. The report records whether the run was ever seen as idle.
//
// PRIVACY: real sessions are private. This test prints and records counts and statuses only:
// never titles, paths or content. Its assertions compare numbers and booleans only, so a failure
// message cannot quote session text, and its project keeps no traces or screenshots.

import { expect, test } from '@playwright/test';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, type Launched } from './helpers';

const ENABLED = process.env.ARM_REAL_CLAUDE === '1' && !process.env.CI;
test.skip(!ENABLED, 'local only: set ARM_REAL_CLAUDE=1 (never runs in CI)');

const SAMPLE_EVERY_MS = 10_000;
const SAMPLES = 9; // ~90 s

function jsonlFiles(dir: string, depth = 0, out: { file: string; mtime: number; size: number }[] = []) {
  if (depth > 6) return out;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsonlFiles(p, depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        const st = statSync(p);
        out.push({ file: p, mtime: st.mtimeMs, size: st.size });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

type FileKind = 'main-session' | 'sub-agent' | 'workflow' | 'workflow-agent';

function fileKind(file: string): FileKind {
  if (/[\\/]subagents[\\/]workflows[\\/]/.test(file)) return file.endsWith('journal.jsonl') ? 'workflow' : 'workflow-agent';
  if (/[\\/]subagents[\\/]/.test(file)) return 'sub-agent';
  return 'main-session';
}

/**
 * The live session file. Among the most recently modified files, the ones that grow during the
 * check (5 s, extended up to 30 s while nothing grows: agents write in bursts) win, and a
 * top-level session beats a sub-agent or workflow transcript (a main session is what a user opens
 * first, and it carries the sub-runs). With nothing growing: the newest top-level session, else
 * the newest file.
 */
async function findLiveSession(): Promise<{ file: string; grewInCheck: boolean; candidates: number; growing: number }> {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const all = jsonlFiles(root).sort((a, b) => b.mtime - a.mtime);
  const top = all.slice(0, 16);
  const grown = () =>
    top.filter((c) => {
      try {
        return statSync(c.file).size > c.size;
      } catch {
        return false; // vanished
      }
    });
  await new Promise((r) => setTimeout(r, 5_000));
  let growing = grown();
  for (let waited = 5_000; !growing.length && waited < 30_000; waited += 2_500) {
    await new Promise((r) => setTimeout(r, 2_500));
    growing = grown();
  }
  const preferMain = (list: typeof all) => list.find((c) => fileKind(c.file) === 'main-session') ?? list[0];
  const pick = growing.length ? preferMain(growing) : preferMain(top);
  return { file: pick?.file ?? '', grewInCheck: growing.length > 0, candidates: all.length, growing: growing.length };
}

const norm = (p: string) => path.resolve(p).toLowerCase();

let launched: Launched | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test('a growing Claude Code session shows as a live run whose event count rises', async () => {
  test.setTimeout(300_000);
  const found = process.env.ARM_LIVE_SESSION
    ? { file: process.env.ARM_LIVE_SESSION, grewInCheck: false, candidates: -1, growing: -1 }
    : await findLiveSession();
  expect(found.file.length > 0, 'a session file was found').toBe(true);
  const target = norm(found.file);
  const kind = fileKind(found.file);

  // Real home (no ARM_HOME), fresh settings folder, no settings file: the wizard runs.
  launched = await launchApp({ home: null });
  const { app, page } = launched;
  await expect(page.getByTestId('wizard')).toBeVisible({ timeout: 60_000 });
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: /^(Open my latest run|Start watching)$/ }).click();
  await expect(page.getByTestId('wizard')).toHaveCount(0);

  type Probe = { total: number; claude: number; children: number; found: boolean; id: string; status: string; events: number; isChild: boolean; parentListed: boolean };
  const probe = () =>
    page.evaluate(async (t) => {
      const b = (window as unknown as { armBackend: { listRuns(): Promise<{ id: string; agent: string; sourcePath: string; status: string; parentId?: string; counts: { events: number } }[]> } }).armBackend;
      const runs = await b.listRuns();
      const n = (p: string) => p.replace(/\//g, '\\').toLowerCase();
      const r = runs.find((x) => n(x.sourcePath) === n(t));
      const ids = new Set(runs.map((x) => x.id));
      return {
        total: runs.length,
        claude: runs.filter((x) => x.agent === 'claude-code').length,
        children: runs.filter((x) => x.parentId && ids.has(x.parentId)).length,
        found: !!r,
        id: r?.id ?? '',
        status: r?.status ?? '',
        events: r?.counts.events ?? -1,
        isChild: !!r?.parentId,
        parentListed: !!r?.parentId && ids.has(r.parentId),
      };
    }, target) as Promise<Probe>;

  // Wait for the run to be listed (parsing a large history can take a while).
  await expect.poll(async () => (await probe()).found, { timeout: 90_000, message: 'live run listed' }).toBe(true);

  const samples: { atS: number; events: number; status: string }[] = [];
  const t0 = Date.now();
  for (let i = 0; i < SAMPLES; i++) {
    const p = await probe();
    samples.push({ atS: Math.round((Date.now() - t0) / 1000), events: p.events, status: p.status });
    if (i < SAMPLES - 1) await page.waitForTimeout(SAMPLE_EVERY_MS);
  }
  const last = await probe();

  // Sub-agent / workflow runs shown as children: open runs through the app's own "open run"
  // channel (what a notification click uses) and count the related-run entries in their Overview.
  // Three roles: a top-level parent (Sub-runs), a middle run such as a workflow inside a session
  // (Part of + Sub-runs), and a leaf child (Part of).
  const roles = await page.evaluate(async () => {
    const b = (window as unknown as { armBackend: { listRuns(): Promise<{ id: string; parentId?: string; updatedAt: number }[]> } }).armBackend;
    const runs = await b.listRuns();
    const ids = new Set(runs.map((x) => x.id));
    const kids = runs.filter((x) => x.parentId && ids.has(x.parentId)).sort((a, c) => c.updatedAt - a.updatedAt);
    const parents = new Set(kids.map((k) => k.parentId as string));
    const hasParent = (id: string) => kids.some((k) => k.id === id);
    const top = [...parents].find((p) => !hasParent(p)) ?? '';
    const middle = [...parents].find((p) => hasParent(p)) ?? '';
    const leaf = kids.find((k) => !parents.has(k.id))?.id ?? '';
    const childrenOf = (p: string) => kids.filter((k) => k.parentId === p).length;
    return { top, middle, leaf, topChildren: childrenOf(top), middleChildren: childrenOf(middle), parentsWithChildren: parents.size };
  });

  async function relatedCounts(id: string): Promise<{ partOf: number; subRuns: number }> {
    await app.evaluate(({ BrowserWindow }, runId) => BrowserWindow.getAllWindows()[0].webContents.send('arm:ev:openRun', runId), id);
    await expect.poll(async () => (await page.locator('.runview').getAttribute('data-run-id')) === id).toBe(true);
    await page.getByRole('radio', { name: 'Overview', exact: true }).first().click();
    const ov = page.getByTestId('view-overview');
    await expect.poll(async () => ov.count()).toBe(1);
    await page.waitForTimeout(500);
    const section = (name: string) => ov.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
    const count = async (name: string) => ((await section(name).count()) ? section(name).locator('li').count() : 0);
    return { partOf: await count('Part of'), subRuns: await count('Sub-runs') };
  }

  const childCheck: Record<string, unknown> = { parentsWithChildren: roles.parentsWithChildren };
  if (roles.top) childCheck.topLevelParent = { childrenInList: roles.topChildren, ...(await relatedCounts(roles.top)) };
  if (roles.middle) childCheck.middleRun = { childrenInList: roles.middleChildren, ...(await relatedCounts(roles.middle)) };
  if (roles.leaf) childCheck.leafChild = await relatedCounts(roles.leaf);

  const report = {
    sessionFilesUnderProjects: found.candidates,
    liveFileKind: kind,
    liveFileGrewDuringSetupCheck: found.grewInCheck,
    growingFilesInSetupCheck: found.growing,
    runsListed: last.total,
    claudeCodeRuns: last.claude,
    childRunsWithListedParent: last.children,
    liveRunIsChild: last.isChild,
    liveRunParentListed: last.parentListed,
    samples,
    eventsFirst: samples[0].events,
    eventsLast: samples[samples.length - 1].events,
    statusesSeen: [...new Set([...samples.map((s) => s.status), last.status])],
    // A live session turns idle between turns: seeing it shows the running -> idle transition.
    idleSeen: samples.some((s) => s.status === 'idle') || last.status === 'idle',
    lastStatus: last.status,
    childCheck: roles.parentsWithChildren ? childCheck : 'no child runs present',
  };
  console.log(`live-claude ${JSON.stringify(report)}`);
  if (process.env.ARM_LIVE_REPORT) writeFileSync(process.env.ARM_LIVE_REPORT, `${JSON.stringify(report, null, 2)}
`);

  expect(['running', 'idle', 'waiting'].includes(samples[samples.length - 1].status), 'live run status is running/idle/waiting').toBe(true);
  expect(report.eventsLast > report.eventsFirst, 'event count increased').toBe(true);
  const c = childCheck as Record<string, { partOf: number; subRuns: number; childrenInList?: number }>;
  if (c.topLevelParent) expect(c.topLevelParent.subRuns, 'top-level parent lists all its sub-runs').toBe(c.topLevelParent.childrenInList);
  if (c.middleRun) {
    expect(c.middleRun.partOf, 'middle run shows its parent').toBe(1);
    expect(c.middleRun.subRuns, 'middle run lists all its sub-runs').toBe(c.middleRun.childrenInList);
  }
  if (c.leafChild) expect(c.leafChild.partOf, 'child shows its parent').toBe(1);
  expect(launched.errors.length, 'errors in the window').toBe(0);
});
