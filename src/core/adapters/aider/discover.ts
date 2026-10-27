// Finding Aider sessions. Aider keeps no central store: each project gets its own
// .aider.chat.history.md in the git root (or the launch folder), appended forever, one
// "# aider chat started at" header per session (aider/args.py, aider/io.py). So we walk the
// folders the user chose, to a bounded depth, and index the session headers of each file found.

import { open, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HEADER_PREFIX, headerTime } from './patterns';
import { scanLines } from './lines';

export const HISTORY_FILE = '.aider.chat.history.md';
export const DEFAULT_DEPTH = 4;
const MAX_DIRS = 50_000;

/** Folders never worth descending into: dependencies, VCS data, virtualenvs, build output, caches. */
const PRUNE = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target',
  'out', 'obj', 'bin', '.next', '.nuxt', '.cache', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.gradle', '.terraform', 'bower_components', 'Pods', '.idea', '.vs', '.vscode', 'AppData',
  '.Trash', '$RECYCLE.BIN', 'System Volume Information',
]);
const pruned = (name: string) => PRUNE.has(name) || name.startsWith('.aider.tags.cache');

/** Walks `root` to `maxDepth` levels and collects every Aider chat history file. Never throws. */
export async function walkForHistories(root: string, maxDepth = DEFAULT_DEPTH, out = new Set<string>()): Promise<Set<string>> {
  let budget = MAX_DIRS;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (budget-- <= 0) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing folder or no permission: skip it
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      // Dirent comes from lstat, so symlinks and Windows junctions are never followed (no cycles).
      if (e.isSymbolicLink()) continue;
      if (e.isFile() && e.name === HISTORY_FILE) out.add(join(dir, e.name));
      else if (e.isDirectory() && depth < maxDepth && !pruned(e.name)) subdirs.push(join(dir, e.name));
    }
    for (const d of subdirs) await visit(d, depth + 1);
  };
  await visit(root, 0);
  return out;
}

export interface SessionIndexEntry {
  /** Byte offset of the header line. */
  offset: number;
  /** Header time (local), epoch ms. */
  startedAt?: number;
  /** Whether anything other than "> " lines follows the header (a prompt or a reply). */
  content: boolean;
}

interface FileIndex {
  size: number;
  mtimeMs: number;
  /** Offset just past the last complete line indexed. */
  scanned: number;
  sessions: SessionIndexEntry[];
}

// Header offsets per file. The file is append-only, so a grown file is indexed from where we stopped.
const cache = new Map<string, FileIndex>();

export function clearIndexCache(): void {
  cache.clear();
}

function isHeader(bytes: Buffer): boolean {
  return bytes.length >= HEADER_PREFIX.length && bytes.subarray(0, HEADER_PREFIX.length).equals(HEADER_PREFIX);
}

/** Lists the sessions in one history file. Reads only the bytes appended since the last call. */
export async function indexSessions(path: string, size: number, mtimeMs: number): Promise<SessionIndexEntry[]> {
  const prev = cache.get(path);
  if (prev && prev.size === size && prev.mtimeMs === mtimeMs) return prev.sessions;
  const lastSeen = prev?.sessions.at(-1);
  // Grown and still holding the last header we saw: appended to, so index only the new bytes.
  const grown = prev && size > prev.size && (!lastSeen || (await headerAt(path, lastSeen.offset)));
  const idx: FileIndex = grown
    ? { ...prev, sessions: prev.sessions.map((s) => ({ ...s })) }
    : { size: 0, mtimeMs: 0, scanned: 0, sessions: [] };
  const res = await scanLines(path, idx.scanned, (bytes, at) => {
    if (isHeader(bytes)) {
      // Only the exact header form counts, so discover and parse agree on where sessions start.
      const startedAt = headerTime(bytes.toString('utf8'));
      if (startedAt !== undefined) {
        idx.sessions.push({ offset: at, startedAt, content: false });
        return;
      }
    }
    const last = idx.sessions[idx.sessions.length - 1];
    if (last && !last.content && bytes.length > 0 && bytes[0] !== 0x3e /* '>' */ && bytes.toString('latin1').trim()) {
      last.content = true;
    }
  });
  idx.scanned = res.consumed;
  idx.size = size;
  idx.mtimeMs = mtimeMs;
  cache.set(path, idx);
  return idx.sessions;
}

/** Whether a session header still starts at `offset` (one small read; false on any error). */
export async function headerAt(path: string, offset: number): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(HEADER_PREFIX.length);
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    return bytesRead === buf.length && buf.equals(HEADER_PREFIX);
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Stats a candidate history file; undefined when it is missing, unreadable or not a file. */
export async function statFile(path: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const st = await stat(path);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

/** A stable de-duplication key for a path (Windows paths are case-insensitive). */
export function pathKey(p: string): string {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
