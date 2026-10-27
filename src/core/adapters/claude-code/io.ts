// Read-only file helpers for the Claude Code adapter: readdir, stat, open 'r' and readFile only.

import { open, readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { ParseState } from '../../adapter';
import { isObj } from '../../events';

/** readdir that never throws: a missing or unreadable folder is just empty. */
export async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** stat that never throws. */
export async function statOrNull(path: string): Promise<{ mtimeMs: number; birthtimeMs: number; size: number; isDir: boolean; isFile: boolean } | null> {
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs, size: s.size, isDir: s.isDirectory(), isFile: s.isFile() };
  } catch {
    return null;
  }
}

/** Reads and parses a small JSON file; undefined when missing, too big or not JSON. */
export async function readSmallJson(path: string, max = 1024 * 1024): Promise<unknown> {
  const text = await readSmallText(path, max);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Reads a small text file; undefined when it is missing, too big or unreadable. */
export async function readSmallText(path: string, max = 256 * 1024): Promise<string | undefined> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > max) return undefined;
    const text = await readFile(path, 'utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

/**
 * The first `cwd` in a transcript, reading at most `max` bytes from the start. Claude Code puts
 * one in the first few records (line 0 to 3 in every file surveyed), so this stays cheap even on
 * 100 MB+ sessions.
 */
export async function headCwd(path: string, max = 256 * 1024): Promise<string | undefined> {
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    const lines = buf.toString('utf8', 0, bytesRead).split('\n');
    lines.pop(); // possibly cut off by the window
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (isObj(rec) && typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
      } catch {
        // skip bad lines
      }
    }
  } catch {
    // unreadable parent: no project path
  } finally {
    await fh?.close();
  }
  return undefined;
}

/**
 * Copies a previous state so an incremental parse never mutates the caller's copy. Events are
 * shared by reference (the adapter replaces, never edits, an event it needs to change).
 */
export function cloneState(prev: ParseState): ParseState {
  const files: ParseState['run']['files'] = {};
  for (const [k, f] of Object.entries(prev.run.files)) files[k] = { ...f, ops: [...f.ops] };
  return {
    offset: prev.offset,
    size: prev.size,
    mtimeMs: prev.mtimeMs,
    run: {
      ...prev.run,
      events: prev.run.events.slice(),
      tally: { ...prev.run.tally },
      files,
      openTool: prev.run.openTool ? { ...prev.run.openTool } : undefined,
    },
    extra: structuredClone(prev.extra),
  };
}
