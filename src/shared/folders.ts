// Run folders: the user's own grouping of runs (by project, client, ...). Folders and which run sits
// in which folder are app-owned data kept in the settings file; nothing is ever written to an
// agent's files. A run is "unfiled" when it has no entry in runFolders. Deleting a folder unfiles
// its runs; it never touches the runs themselves. Pure functions, shared by main (which stores the
// result) and the fixture backend.

import type { Settings } from './settings';

export interface RunFolder {
  /** App-generated and stable; renaming a folder keeps its id. */
  id: string;
  name: string;
}

export type FolderOp =
  | { kind: 'create'; name: string }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'delete'; id: string }
  /** folderId null moves the runs back to Unfiled. */
  | { kind: 'move'; runIds: string[]; folderId: string | null };

export interface FolderResult {
  /** The saved settings (unchanged when `error` is set). */
  settings: Settings;
  /** Plain words for the user when the change was refused. */
  error?: string;
  /** The new folder's id after a successful create. */
  folderId?: string;
}

export const MAX_FOLDERS = 100;
export const MAX_FOLDER_NAME = 60;
/** Cap on stored assignments, which keeps the settings file (and IPC payloads) small. */
export const MAX_FILED_RUNS = 10_000;

const FOLDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRunId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 200;

/** Collapses whitespace and control characters, trims and caps the length. '' when nothing is left. */
export function cleanFolderName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_FOLDER_NAME).trim();
}

/** A new folder id that is not in `taken`. */
export function newFolderId(taken: ReadonlySet<string> = new Set()): string {
  for (;;) {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    const rand = c?.randomUUID ? c.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2) + Date.now().toString(16);
    const id = `f_${rand.slice(0, 12)}`;
    if (!taken.has(id)) return id;
  }
}

/** Validates folders and assignments from disk or IPC: bad entries are dropped, never fatal. */
export function normalizeFolders(rawFolders: unknown, rawRunFolders: unknown): { folders: RunFolder[]; runFolders: Record<string, string> } {
  const folders: RunFolder[] = [];
  const ids = new Set<string>();
  if (Array.isArray(rawFolders)) {
    for (const f of rawFolders) {
      if (folders.length >= MAX_FOLDERS) break;
      if (!isObj(f) || typeof f.id !== 'string' || !FOLDER_ID.test(f.id) || ids.has(f.id)) continue;
      const name = cleanFolderName(f.name);
      if (!name) continue;
      ids.add(f.id);
      folders.push({ id: f.id, name });
    }
  }
  const entries: [string, string][] = [];
  if (isObj(rawRunFolders)) {
    for (const [runId, folderId] of Object.entries(rawRunFolders)) {
      if (entries.length >= MAX_FILED_RUNS) break;
      if (isRunId(runId) && typeof folderId === 'string' && ids.has(folderId)) entries.push([runId, folderId]);
    }
  }
  // fromEntries defines own properties, so a key such as "__proto__" stays plain data.
  return { folders, runFolders: Object.fromEntries(entries) };
}

/** Checks a FolderOp that came over IPC; null when it is malformed. */
export function parseFolderOp(raw: unknown): FolderOp | null {
  if (!isObj(raw)) return null;
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  switch (raw.kind) {
    case 'create':
      return str(raw.name, 1000) ? { kind: 'create', name: raw.name as string } : null;
    case 'rename':
      return str(raw.id, 64) && str(raw.name, 1000) ? { kind: 'rename', id: raw.id as string, name: raw.name as string } : null;
    case 'delete':
      return str(raw.id, 64) ? { kind: 'delete', id: raw.id as string } : null;
    case 'move': {
      if (!Array.isArray(raw.runIds) || raw.runIds.length > MAX_FILED_RUNS || !raw.runIds.every(isRunId)) return null;
      if (raw.folderId !== null && !str(raw.folderId, 64)) return null;
      return { kind: 'move', runIds: raw.runIds as string[], folderId: raw.folderId as string | null };
    }
    default:
      return null;
  }
}

const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/**
 * Applies one folder change to `s` and returns the new settings, or the unchanged settings and a
 * plain-words error. Never mutates `s`.
 */
export function applyFolderOp(s: Settings, op: FolderOp, makeId: (taken: ReadonlySet<string>) => string = newFolderId): FolderResult {
  const fail = (error: string): FolderResult => ({ settings: s, error });
  const byId = (id: string) => s.folders.find((f) => f.id === id);
  const nameError = (name: string, exceptId?: string): string | null => {
    if (!name) return 'Give the folder a name.';
    const clash = s.folders.find((f) => f.id !== exceptId && sameName(f.name, name));
    return clash ? `There is already a folder called "${clash.name}".` : null;
  };

  switch (op.kind) {
    case 'create': {
      if (s.folders.length >= MAX_FOLDERS) return fail(`You can have up to ${MAX_FOLDERS} folders.`);
      const name = cleanFolderName(op.name);
      const err = nameError(name);
      if (err) return fail(err);
      const id = makeId(new Set(s.folders.map((f) => f.id)));
      return { settings: { ...s, folders: [...s.folders, { id, name }] }, folderId: id };
    }
    case 'rename': {
      if (!byId(op.id)) return fail('That folder no longer exists.');
      const name = cleanFolderName(op.name);
      const err = nameError(name, op.id);
      if (err) return fail(err);
      return { settings: { ...s, folders: s.folders.map((f) => (f.id === op.id ? { ...f, name } : f)) } };
    }
    case 'delete': {
      if (!byId(op.id)) return { settings: s };
      return {
        settings: {
          ...s,
          folders: s.folders.filter((f) => f.id !== op.id),
          runFolders: Object.fromEntries(Object.entries(s.runFolders).filter(([, fid]) => fid !== op.id)),
        },
      };
    }
    case 'move': {
      if (op.folderId !== null && !byId(op.folderId)) return fail('That folder no longer exists.');
      const moving = new Set(op.runIds.filter(isRunId));
      const entries = Object.entries(s.runFolders).filter(([runId]) => !moving.has(runId));
      if (op.folderId !== null) for (const runId of moving) entries.push([runId, op.folderId]);
      if (entries.length > MAX_FILED_RUNS) return fail(`Up to ${MAX_FILED_RUNS.toLocaleString('en')} runs can be in folders.`);
      return { settings: { ...s, runFolders: Object.fromEntries(entries) } };
    }
  }
}

/** The folder a run is in, or undefined when it is unfiled. */
export function folderOfRun(s: Pick<Settings, 'folders' | 'runFolders'>, runId: string): RunFolder | undefined {
  const id = Object.prototype.hasOwnProperty.call(s.runFolders, runId) ? s.runFolders[runId] : undefined;
  return id ? s.folders.find((f) => f.id === id) : undefined;
}

/** How many runs each folder holds (including runs outside the current history window). */
export function folderCounts(s: Pick<Settings, 'runFolders'>): Map<string, number> {
  const out = new Map<string, number>();
  for (const fid of Object.values(s.runFolders)) out.set(fid, (out.get(fid) ?? 0) + 1);
  return out;
}
