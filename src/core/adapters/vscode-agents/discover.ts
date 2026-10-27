// Discovery for Cline, Roo Code and Continue: readdir + stat, plus the small history indexes
// these agents keep (Cline's state/taskHistory.json, Continue's sessions.json) for titles and
// project folders. A missing or unreadable root yields nothing; one bad entry never stops a scan.

import { basename, join } from 'node:path';
import type { AgentId } from '@shared/schema';
import type { DiscoverContext, SessionRef } from '../../adapter';
import { baseName } from '../../events';
import { isObj, listDir, readJsonQuiet, statOrNull, str, uriToPath, type Obj } from './common';

/** Cline 4.x session ids: `${Date.now()}_${nanoid(5)}` [source: shared/src/session/index.ts]. */
const SDK_ID = /^\d{10,}_[0-9a-z]+$/i;
/**
 * Session folders also include resumed 3.x tasks, which keep their old id (`Date.now()` digits):
 * historyItemToSessionHistoryRecord sets sessionId = item.id [source: apps/vscode/src/sdk/
 * sdk-task-history.ts]. Only used inside a known sessions folder, where a manifest must exist.
 */
const SESSION_DIR = /^\d{10,}(?:_[0-9a-z]+)?$/i;

// ---------------------------------------------------------------- Cline / Roo task folders

/** Cline's HistoryItem list, by task id: title, cwd and model for the run list. */
async function clineHistory(root: string): Promise<Map<string, Obj>> {
  const list = await readJsonQuiet(join(root, 'state', 'taskHistory.json'));
  const out = new Map<string, Obj>();
  if (Array.isArray(list)) for (const h of list) if (isObj(h) && typeof h.id === 'string') out.set(h.id, h);
  return out;
}

function historyHint(h: Obj | undefined): Record<string, string> {
  const hint: Record<string, string> = {};
  if (!h) return hint;
  const project = str(h.cwdOnTaskInitialization) ?? str(h.workspace) ?? str(h.shadowGitConfigWorkTree);
  if (project) {
    hint.projectPath = project;
    hint.project = baseName(project);
  }
  if (str(h.task)) hint.title = String(h.task).slice(0, 2000);
  if (str(h.modelId)) hint.model = String(h.modelId);
  return hint;
}

/**
 * Scans `<tasksDir>/<id>/ui_messages.json`. Skips `_index.json`, dotfiles and the agents'
 * temporary write files (`*.tmp*`, `*.lock`), which are never sessions.
 */
async function scanTasks(
  agent: AgentId,
  tasksDir: string,
  since: number,
  history: Map<string, Obj> | undefined,
  skipIds: Set<string>,
): Promise<SessionRef[]> {
  const refs: SessionRef[] = [];
  for (const e of await listDir(tasksDir)) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_') || /\.(tmp|lock)/i.test(e.name)) continue;
    if (skipIds.has(e.name)) continue; // resumed in Cline 4.x: the SDK session supersedes it
    const ui = join(tasksDir, e.name, 'ui_messages.json');
    const st = await statOrNull(ui); // Roo briefly has no file between its two renames: skip this round
    if (!st || !st.isFile() || st.size === 0) continue;
    if (since > 0 && st.mtimeMs < since) continue;
    const hint = { kind: 'legacy', taskId: e.name, ...historyHint(history?.get(e.name)) };
    refs.push({ agent, path: ui, mtimeMs: st.mtimeMs, size: st.size, hint });
  }
  return refs;
}

async function tasksDirsOf(root: string): Promise<{ tasks?: string; sessions?: string }> {
  if (basename(root) === 'tasks') return { tasks: root };
  const names = [...(await listDir(root))].filter((e) => e.isDirectory()).map((e) => e.name);
  // CLINE_SESSION_DATA_DIR points straight at a folder of <sessionId>/ folders.
  const isSessionsDir = basename(root) === 'sessions' || names.some((n) => SDK_ID.test(n));
  return {
    tasks: names.includes('tasks') ? join(root, 'tasks') : undefined,
    sessions: names.includes('sessions') ? join(root, 'sessions') : isSessionsDir ? root : undefined,
  };
}

// ---------------------------------------------------------------- Cline 4.x sessions

async function scanSdkSessions(dir: string, since: number, ids: Set<string>): Promise<SessionRef[]> {
  const refs: SessionRef[] = [];
  for (const e of await listDir(dir)) {
    if (!e.isDirectory() || !SESSION_DIR.test(e.name)) continue;
    const manifest = join(dir, e.name, `${e.name}.json`);
    const messages = join(dir, e.name, `${e.name}.messages.json`);
    const [ms, mm] = await Promise.all([statOrNull(messages), statOrNull(manifest)]);
    const main = ms && ms.size > 0 ? ms : mm;
    if (!main) continue;
    ids.add(e.name);
    const mtimeMs = Math.max(ms?.mtimeMs ?? 0, mm?.mtimeMs ?? 0);
    if (since > 0 && mtimeMs < since) continue;
    refs.push({
      agent: 'cline',
      path: main === ms ? messages : manifest,
      mtimeMs,
      size: main.size,
      hint: { kind: 'sdk', sessionId: e.name, manifest },
    });
  }
  return refs;
}

// ---------------------------------------------------------------- discover entry points

export async function discoverTaskAgent(agent: 'cline' | 'roo-code', roots: string[], ctx: DiscoverContext): Promise<SessionRef[]> {
  const layouts = await Promise.all([...new Set(roots)].map(async (root) => ({ root, ...(await tasksDirsOf(root)) })));
  // Cline 4.x sessions first, so a legacy task that was resumed there is listed once.
  const sdkIds = new Set<string>();
  const out: SessionRef[] = [];
  if (agent === 'cline') {
    for (const l of layouts) if (l.sessions) out.push(...(await scanSdkSessions(l.sessions, ctx.since, sdkIds)));
  }
  for (const l of layouts) {
    if (!l.tasks) continue;
    const history = agent === 'cline' ? await clineHistory(l.tasks === l.root ? join(l.root, '..') : l.root) : undefined;
    out.push(...(await scanTasks(agent, l.tasks, ctx.since, history, sdkIds)));
  }
  const seen = new Set<string>();
  return out.filter((r) => !seen.has(r.path) && !!seen.add(r.path));
}

/** Continue's sessions.json: `{sessionId, title, dateCreated, workspaceDirectory}` per session. */
async function continueIndex(dir: string): Promise<Map<string, Obj>> {
  const list = await readJsonQuiet(join(dir, 'sessions.json'));
  const out = new Map<string, Obj>();
  // snake_case entries are from Continue's old Python server and are ignored, as Continue does.
  if (Array.isArray(list)) for (const s of list) if (isObj(s) && typeof s.sessionId === 'string') out.set(s.sessionId, s);
  return out;
}

export async function discoverContinue(roots: string[], ctx: DiscoverContext): Promise<SessionRef[]> {
  const out: SessionRef[] = [];
  const seen = new Set<string>();
  for (const root of new Set(roots)) {
    // Accept the sessions folder itself or the ~/.continue folder above it.
    const sub = (await listDir(root)).some((e) => e.isDirectory() && e.name === 'sessions');
    const dir = sub ? join(root, 'sessions') : root;
    const entries = (await listDir(dir)).filter((e) => e.isFile() && /\.json$/i.test(e.name) && e.name !== 'sessions.json');
    if (!entries.length) continue;
    const index = await continueIndex(dir);
    for (const e of entries) {
      const path = join(dir, e.name);
      if (seen.has(path)) continue;
      const st = await statOrNull(path);
      if (!st || st.size === 0) continue;
      if (ctx.since > 0 && st.mtimeMs < ctx.since) continue;
      seen.add(path);
      const id = e.name.replace(/\.json$/i, '');
      const meta = index.get(id);
      const hint: Record<string, string> = { sessionId: id };
      if (meta) {
        if (str(meta.dateCreated)) hint.dateCreated = String(meta.dateCreated);
        const ws = str(meta.workspaceDirectory);
        if (ws) {
          hint.projectPath = uriToPath(ws);
          hint.project = baseName(hint.projectPath);
        }
        if (str(meta.title)) hint.title = String(meta.title);
      }
      out.push({ agent: 'continue', path, mtimeMs: st.mtimeMs, size: st.size, hint });
    }
  }
  return out;
}
