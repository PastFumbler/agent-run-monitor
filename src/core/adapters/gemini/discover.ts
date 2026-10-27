// Finding Gemini CLI and Qwen Code sessions: readdir + stat, plus two tiny reads (Gemini's
// `.project_root` marker and `projects.json` registry, Qwen's settings.json for a moved
// runtime folder). Layouts (research, from source):
//   Gemini  <root>/tmp/<slug>/chats/session-<UTC minute>-<id8>.jsonl     (current)
//           <root>/tmp/<slug>/chats/<parent session id>/<subagent>.jsonl (subagents)
//           <root>/tmp/<sha256(project path)>/chats/session-*.json       (legacy, before 2026-02)
//   Qwen    <root>/projects/<sanitized cwd>/chats/<uuid>.jsonl
//           <root>/projects/<sanitized cwd>/subagents/<session id>/agent-<id>.jsonl
//           <root>/tmp/<hash>/chats/session-*.json                        (legacy, before 2025-12)

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { AgentId } from '@shared/schema';
import type { DiscoverContext, SessionRef } from '../../adapter';
import { baseName, isObj } from '../../events';
import { expandHome } from './common';

const GEMINI_SESSION = /^session-.+\.jsonl?$/;
const QWEN_SESSION = /^[0-9a-fA-F-]{32,36}\.jsonl$/;
const HASH_DIR = /^[0-9a-f]{64}$/;

interface Registry {
  /** slug or sha256 hash -> project path */
  byKey: Map<string, string>;
}

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // missing root, no permission, not a folder
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readSmall(p: string, max = 64 * 1024): Promise<string | undefined> {
  try {
    const st = await stat(p);
    if (!st.isFile() || st.size > max) return undefined;
    return await readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

async function readSmallJson(p: string): Promise<unknown> {
  const text = await readSmall(p, 1024 * 1024);
  if (!text) return undefined;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return undefined;
  }
}

/** Gemini's projects.json maps project path -> slug; legacy folders are sha256(project path). */
async function loadRegistry(root: string): Promise<Registry> {
  const byKey = new Map<string, string>();
  const doc = await readSmallJson(join(root, 'projects.json'));
  const projects = isObj(doc) && isObj(doc.projects) ? doc.projects : {};
  for (const [path, slug] of Object.entries(projects)) {
    if (typeof slug === 'string') byKey.set(slug, path);
    byKey.set(createHash('sha256').update(path).digest('hex'), path);
  }
  return { byKey };
}

class Collector {
  readonly refs: SessionRef[] = [];
  private readonly seen = new Set<string>();
  constructor(
    readonly agent: AgentId,
    readonly since: number,
  ) {}

  async add(path: string, hint: Record<string, string>): Promise<void> {
    if (this.seen.has(path)) return;
    try {
      const st = await stat(path);
      if (!st.isFile()) return;
      if (this.since > 0 && st.mtimeMs < this.since) return;
      this.seen.add(path);
      this.refs.push({ agent: this.agent, path, mtimeMs: st.mtimeMs, size: st.size, hint });
    } catch {
      // vanished between readdir and stat, or no permission: skip this entry only
    }
  }
}

/** Project hint for a Gemini-style `tmp/<slug or hash>` folder. */
async function projectHint(dir: string, reg: Registry): Promise<Record<string, string>> {
  const key = basename(dir);
  const marker = (await readSmall(join(dir, '.project_root')))?.trim();
  const projectPath = marker || reg.byKey.get(key);
  if (projectPath) return { project: baseName(projectPath), projectPath };
  // Unresolvable legacy hash folder: show the hash shortened.
  return { project: HASH_DIR.test(key) ? key.slice(0, 8) : key };
}

/**
 * A `chats` folder: main sessions (Gemini `session-*.json[l]`, Qwen `<uuid>.jsonl`), and
 * Gemini subagent folders named after the parent's full session id.
 */
async function scanChats(c: Collector, chats: string, hint: Record<string, string>): Promise<void> {
  const entries = await listDir(chats);
  const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  for (const e of entries) {
    if (e.isFile()) {
      if (QWEN_SESSION.test(e.name)) await c.add(join(chats, e.name), hint);
      else if (GEMINI_SESSION.test(e.name)) {
        // A resumed legacy .json is migrated to a sibling .jsonl and left in place: prefer .jsonl.
        if (e.name.endsWith('.json') && names.has(`${e.name}l`)) continue;
        await c.add(join(chats, e.name), hint);
      }
    } else if (e.isDirectory() && e.name !== 'archive') {
      const parent = [...names].find((n) => GEMINI_SESSION.test(n) && n.replace(/\.jsonl?$/, '').endsWith(`-${e.name.slice(0, 8)}`));
      const subHint = parent ? { ...hint, parentPath: join(chats, parent) } : hint;
      for (const s of await listDir(join(chats, e.name))) {
        if (s.isFile() && s.name.endsWith('.jsonl')) await c.add(join(chats, e.name, s.name), subHint);
      }
    }
  }
}

/** `<root>/tmp/*` project folders (Gemini, and legacy Qwen). */
async function scanTmp(c: Collector, root: string): Promise<void> {
  const reg = await loadRegistry(root);
  for (const d of await listDir(join(root, 'tmp'))) {
    if (!d.isDirectory() || d.name === 'bin') continue;
    const dir = join(root, 'tmp', d.name);
    if (!(await isDir(join(dir, 'chats')))) continue;
    await scanChats(c, join(dir, 'chats'), await projectHint(dir, reg));
  }
}

/** `<root>/projects/*` (Qwen). The folder name is a lossy sanitised cwd; records carry the real one. */
async function scanQwenProjects(c: Collector, root: string): Promise<void> {
  for (const d of await listDir(join(root, 'projects'))) {
    if (!d.isDirectory()) continue;
    const dir = join(root, 'projects', d.name);
    const hint = { project: d.name };
    await scanChats(c, join(dir, 'chats'), hint);
    for (const s of await listDir(join(dir, 'subagents'))) {
      if (!s.isDirectory()) continue;
      const parentPath = join(dir, 'chats', `${s.name}.jsonl`);
      for (const f of await listDir(join(dir, 'subagents', s.name))) {
        if (f.isFile() && /^agent-.+\.jsonl$/.test(f.name)) await c.add(join(dir, 'subagents', s.name, f.name), { ...hint, parentPath });
      }
    }
  }
}

/** A root may also be a single project folder or a chats folder the user picked. */
async function scanNarrowRoot(c: Collector, root: string): Promise<void> {
  if (await isDir(join(root, 'chats'))) {
    await scanChats(c, join(root, 'chats'), await projectHint(root, { byKey: new Map() }));
  } else if (basename(root) === 'chats') {
    await scanChats(c, root, await projectHint(dirname(root), { byKey: new Map() }));
  }
}

export async function discoverGemini(roots: string[], ctx: DiscoverContext): Promise<SessionRef[]> {
  const c = new Collector('gemini-cli', ctx.since);
  for (const root of roots) {
    if (await isDir(join(root, 'tmp'))) await scanTmp(c, root);
    else await scanNarrowRoot(c, root);
  }
  return c.refs;
}

/** settings.json `advanced.runtimeOutputDir` moves Qwen's sessions elsewhere. */
async function qwenRuntimeDir(root: string, ctx: DiscoverContext): Promise<string | undefined> {
  const doc = await readSmallJson(join(root, 'settings.json'));
  const dir = isObj(doc) && isObj(doc.advanced) ? doc.advanced.runtimeOutputDir : undefined;
  if (typeof dir !== 'string' || !dir.trim()) return undefined;
  const p = expandHome(dir.trim(), ctx.env);
  return isAbsolute(p) ? p : undefined; // relative paths resolve against each project: unknowable here
}

export async function discoverQwen(roots: string[], ctx: DiscoverContext): Promise<SessionRef[]> {
  const c = new Collector('qwen-code', ctx.since);
  const bases: string[] = [];
  for (const root of roots) {
    bases.push(root);
    const moved = await qwenRuntimeDir(root, ctx);
    if (moved) bases.push(moved);
  }
  for (const base of [...new Set(bases)]) {
    const hasProjects = await isDir(join(base, 'projects'));
    const hasTmp = await isDir(join(base, 'tmp'));
    if (hasProjects) await scanQwenProjects(c, base);
    if (hasTmp) await scanTmp(c, base);
    if (!hasProjects && !hasTmp) await scanNarrowRoot(c, base);
  }
  return c.refs;
}
