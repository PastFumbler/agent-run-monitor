// Where Codex keeps rollouts, and how to list them cheaply (readdir + stat only).
//
// [SRC utils/home-dir] CODEX_HOME (when set and non-empty) else <home>/.codex, on every OS.
// [SRC rollout/src/recorder.rs, rollout_file_name.rs]
//   sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread-uuid>[_<rollout-uuid>].jsonl[.zst]
//   archived_sessions/rollout-....jsonl[.zst]   (flat; archiving is a rename)
// A revert writes a new file with a `_<rollout-uuid>` suffix for the same thread: newest mtime wins.
// A `.jsonl.zst` (compressed cold rollout) is ignored when its plain `.jsonl` sibling exists.
// [UNVERIFIED] The pre-Rust TypeScript CLI wrote sessions/rollout-YYYY-MM-DD-<uuid>.json.

import { readdir, stat } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import type { DiscoverContext, Env, SessionRef } from '../../adapter';

export const ROLLOUT_RE = /^rollout-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl(\.zst)?$/i;
export const LEGACY_JSON_RE = /^rollout-(\d{4}-\d\d-\d\d)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;

/** Session folders are date-named (YYYY, MM, DD), so the walk never needs to go deeper than this. */
const MAX_DEPTH = 4;

export function codexHome(env: Env): string {
  const override = env.vars.CODEX_HOME?.trim();
  if (override) return override;
  const p = env.platform === 'win32' ? win32 : posix;
  return p.join(env.home, '.codex');
}

export function defaultRoots(env: Env): string[] {
  // Codex ignores XDG and APPDATA: CLI, IDE extension and desktop app all share CODEX_HOME. [SRC]
  return [codexHome(env)];
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** The folders to walk under a root: its sessions/ and archived_sessions/, or the root itself. */
async function sessionDirs(root: string): Promise<{ dir: string; home?: string }[]> {
  const out: { dir: string; home?: string }[] = [];
  for (const sub of ['sessions', 'archived_sessions']) {
    const d = join(root, sub);
    if (await isDir(d)) out.push({ dir: d, home: root });
  }
  if (!out.length && (await isDir(root))) out.push({ dir: root }); // a custom root pointing at a sessions folder
  return out;
}

async function walk(dir: string, depth: number, onFile: (path: string, name: string) => Promise<void>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing or not permitted: skip quietly
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH && /^\d{1,4}$/.test(e.name)) await walk(full, depth + 1, onFile);
    } else if (ROLLOUT_RE.test(e.name) || LEGACY_JSON_RE.test(e.name)) {
      await onFile(full, e.name);
    }
  }
}

/** The thread id in a rollout file name (lower case), or undefined. */
export function threadIdOf(name: string): string | undefined {
  return (ROLLOUT_RE.exec(name)?.[2] ?? LEGACY_JSON_RE.exec(name)?.[2])?.toLowerCase();
}

export async function discoverRollouts(roots: string[], ctx: DiscoverContext): Promise<SessionRef[]> {
  const byThread = new Map<string, SessionRef>();
  const seenPaths = new Set<string>();
  for (const root of roots) {
    for (const { dir, home } of await sessionDirs(root)) {
      await walk(dir, 0, async (path, name) => {
        if (seenPaths.has(path)) return;
        seenPaths.add(path);
        if (name.endsWith('.zst') && seenPaths.has(path.slice(0, -4))) return;
        let st;
        try {
          st = await stat(path);
        } catch {
          return; // vanished (archived / compressed meanwhile) or not permitted
        }
        if (!st.isFile()) return;
        if (ctx.since > 0 && st.mtimeMs < ctx.since) return;
        const id = threadIdOf(name) ?? path;
        const prev = byThread.get(id);
        if (prev && !preferNew(prev, path, st.mtimeMs)) return;
        const hint: Record<string, string> = { threadId: id };
        if (home) hint.home = home;
        if (dir.endsWith('archived_sessions')) hint.archived = '1';
        byThread.set(id, { agent: 'codex', path, mtimeMs: st.mtimeMs, size: st.size, hint });
      });
    }
  }
  return [...byThread.values()];
}

/** Plain .jsonl beats its .zst sibling; otherwise the newest file of a thread wins. */
function preferNew(prev: SessionRef, path: string, mtimeMs: number): boolean {
  if (prev.path.endsWith('.zst') && path === prev.path.slice(0, -4)) return true;
  if (path.endsWith('.zst') && prev.path === path.slice(0, -4)) return false;
  return mtimeMs > prev.mtimeMs;
}

/**
 * Finds the rollout file of another thread (a sub-agent's parent). Thread ids are UUIDv7, whose first
 * 48 bits are the creation time in ms, so only the child's own folder and the date folders around that
 * day are listed, never the whole tree. [SRC]
 */
export async function findThreadFile(home: string, threadId: string, nearDir?: string): Promise<string | undefined> {
  const id = threadId.toLowerCase();
  const dirs: string[] = nearDir ? [nearDir] : [];
  const hex = id.replace(/-/g, '').slice(0, 12);
  const ms = id[14] === '7' ? parseInt(hex, 16) : NaN;
  if (Number.isFinite(ms)) {
    for (const off of [0, -1, 1]) {
      const d = new Date(ms + off * 86_400_000);
      const y = String(d.getUTCFullYear());
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      dirs.push(join(home, 'sessions', y, m, day));
    }
  }
  dirs.push(join(home, 'archived_sessions'));
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    const hit = names.find((n) => threadIdOf(n) === id);
    if (hit) return join(dir, hit);
  }
  return undefined;
}
