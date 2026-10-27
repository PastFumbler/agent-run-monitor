// Lists Claude Code runs with readdir + stat only (no content is read here):
//   <root>/projects/<encoded-cwd>/<sid>.jsonl                          main session
//   <root>/projects/<enc>/<sid>/subagents/agent-<id>.jsonl             Agent/Task sub-agent
//   <root>/projects/<enc>/<sid>/subagents/workflows/wf_<id>/journal.jsonl   workflow run
//   <root>/projects/<enc>/<sid>/subagents/workflows/wf_<id>/agent-<id>.jsonl workflow agent
// Layout verified against a real install (8 sessions, 12 sub-agents, 57 workflow runs).

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
    const projects = await projectsDir(root);
    if (!projects) continue;
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

/** `<root>/projects`, or the root itself when the user pointed straight at a projects folder. */
async function projectsDir(root: string): Promise<string | undefined> {
  if (!root) return undefined;
  const inner = join(root, 'projects');
  if ((await statOrNull(inner))?.isDir) return inner;
  if (basename(root) === 'projects' && (await statOrNull(root))?.isDir) return root;
  return undefined;
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
