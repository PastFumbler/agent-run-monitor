// Lists Claude Code runs with readdir + stat only (no content is read here):
//   <root>/projects/<encoded-cwd>/<sid>.jsonl                          main session
//   <root>/projects/<enc>/<sid>/subagents/agent-<id>.jsonl             Agent/Task sub-agent
//   <root>/projects/<enc>/<sid>/subagents/workflows/wf_<id>/journal.jsonl   workflow run
//   <root>/projects/<enc>/<sid>/subagents/workflows/wf_<id>/agent-<id>.jsonl workflow agent
// Layout verified against a real install (8 sessions, 12 sub-agents, 57 workflow runs).
// A custom root may also be the folder holding .claude, a projects folder, or one <encoded-cwd>
// folder (see layoutOf).

import { basename, join, resolve } from 'node:path';
import type { DiscoverContext, SessionRef } from '../../adapter';
import { listDir, statOrNull } from './io';
import type { ClaudeRunKind } from './paths';

const AGENT_FILE = /^agent-.+\.jsonl$/;

type Hint = Record<string, string> & { kind: ClaudeRunKind };
interface Candidate {
  path: string;
  hint: Hint;
}

/** Stats run this many at a time: sequential stats made discovery take seconds on big histories. */
const STAT_BATCH = 64;

export async function discover(roots: string[], ctx: DiscoverContext): Promise<SessionRef[]> {
  const candidates: Candidate[] = [];
  for (const root of roots) {
    const layout = await layoutOf(root);
    if (!layout) continue;
    if ('project' in layout) {
      candidates.push(...(await discoverProject(layout.project, basename(layout.project))));
      continue;
    }
    const projects = layout.projects;
    const dirs = (await listDir(projects)).filter((d) => d.isDirectory());
    const found = await Promise.all(dirs.map((d) => discoverProject(join(projects, d.name), d.name)));
    for (const list of found) candidates.push(...list);
  }
  // Overlapping roots (CLAUDE_CONFIG_DIR pointing at ~/.claude) list the same files twice.
  const foldCase = ctx.env.platform !== 'linux';
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = foldCase ? resolve(c.path).toLowerCase() : resolve(c.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const since = ctx.since > 0 ? ctx.since : 0;
  const out: SessionRef[] = [];
  for (let i = 0; i < unique.length; i += STAT_BATCH) {
    const batch = unique.slice(i, i + STAT_BATCH);
    const stats = await Promise.all(batch.map((c) => statOrNull(c.path)));
    batch.forEach((c, j) => {
      const st = stats[j];
      if (!st || !st.isFile) return; // vanished (retention cleanup) or unreadable
      if (since && st.mtimeMs < since) return;
      out.push({ agent: 'claude-code', path: c.path, mtimeMs: st.mtimeMs, size: st.size, hint: c.hint });
    });
  }
  return out;
}

/** Claude Code names a main session file by its session id, a UUID. */
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
/** How many sub-folders to look into when guessing whether a folder is a renamed projects folder. */
const PEEK_FOLDERS = 64;

const holdsSessions = (entries: { name: string; isFile(): boolean }[]) => entries.some((e) => e.isFile() && SESSION_FILE.test(e.name));

/**
 * What a root is. Users add custom folders at every level, so each is accepted:
 * - the config folder (`<root>/projects`), or the folder that holds `.claude` (their home folder);
 * - a projects folder itself (named `projects`, or a renamed copy whose sub-folders hold sessions);
 * - one project folder that directly holds `<session-id>.jsonl` files.
 */
async function layoutOf(root: string): Promise<{ projects: string } | { project: string } | undefined> {
  if (!root) return undefined;
  for (const inner of [join(root, 'projects'), join(root, '.claude', 'projects')]) {
    if ((await statOrNull(inner))?.isDir) return { projects: inner };
  }
  if (!(await statOrNull(root))?.isDir) return undefined;
  if (basename(root) === 'projects') return { projects: root };
  const entries = await listDir(root);
  if (holdsSessions(entries)) return { project: root };
  const subs = entries.filter((e) => e.isDirectory()).slice(0, PEEK_FOLDERS);
  const peeks = await Promise.all(subs.map(async (d) => holdsSessions(await listDir(join(root, d.name)))));
  return peeks.some(Boolean) ? { projects: root } : undefined;
}

async function discoverProject(projDir: string, folder: string): Promise<Candidate[]> {
  const entries = await listDir(projDir);
  const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  const sessions = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
  const lists = await Promise.all(
    sessions.map(async (e) => {
      const path = join(projDir, e.name);
      const sid = e.name.slice(0, -'.jsonl'.length);
      const own: Candidate = { path, hint: { kind: 'session', project: folder } };
      // Children have their own mtimes: a quiet parent can still have a busy workflow.
      return dirs.has(sid) ? [own, ...(await discoverChildren(join(projDir, sid), path, folder))] : [own];
    }),
  );
  return lists.flat();
}

async function discoverChildren(sessionDir: string, mainPath: string, folder: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const sub = join(sessionDir, 'subagents');
  const entries = await listDir(sub);
  for (const e of entries) {
    if (e.isFile() && AGENT_FILE.test(e.name)) out.push({ path: join(sub, e.name), hint: { kind: 'subagent', parent: mainPath, project: folder } });
  }
  if (!entries.some((e) => e.isDirectory() && e.name === 'workflows')) return out;
  const wfRoot = join(sub, 'workflows');
  const runs = (await listDir(wfRoot)).filter((w) => w.isDirectory() && w.name.startsWith('wf_'));
  const lists = await Promise.all(
    runs.map(async (w) => {
      const wdir = join(wfRoot, w.name);
      const journal = join(wdir, 'journal.jsonl');
      const files = await listDir(wdir);
      const list: Candidate[] = [];
      if (files.some((f) => f.isFile() && f.name === 'journal.jsonl')) {
        list.push({ path: journal, hint: { kind: 'workflow', parent: mainPath, project: folder, runId: w.name, sessionDir } });
      }
      for (const f of files) {
        if (f.isFile() && AGENT_FILE.test(f.name)) {
          list.push({ path: join(wdir, f.name), hint: { kind: 'workflow-agent', parent: journal, project: folder, runId: w.name } });
        }
      }
      return list;
    }),
  );
  return out.concat(lists.flat());
}
