// Where OpenCode keeps its data, and path helpers for the forms it stores.
// [SRC sst/opencode main @ f993a89 packages/util/src/global-roots.ts, packages/cli/src/database-path.ts]
// OpenCode uses XDG paths on every OS (Windows and macOS included): $XDG_DATA_HOME/opencode, else
// ~/.local/share/opencode. $OPENCODE_DB names the database (absolute, or relative to that folder).

import path from 'node:path';
import type { Env } from '../../adapter';

/** opencode.db, opencode-<channel>.db, opencode-next.db (never the -wal / -shm sidecars). */
export const DB_NAME = /^opencode(?:-[\w.-]+)?\.db$/i;

function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function dataDir(env: Env): string {
  const p = pathFor(env.platform);
  const xdg = env.vars.XDG_DATA_HOME?.trim();
  return p.join(xdg || p.join(env.home, '.local', 'share'), 'opencode');
}

export function defaultRoots(env: Env): string[] {
  const p = pathFor(env.platform);
  const root = dataDir(env);
  const roots = [root];
  const db = env.vars.OPENCODE_DB?.trim();
  if (db && db !== ':memory:') {
    const file = p.isAbsolute(db) ? db : p.join(root, db);
    // The folder listing already finds opencode*.db files sitting in the data folder.
    if (p.dirname(file) !== root || !DB_NAME.test(p.basename(file))) roots.push(file);
  }
  return roots;
}

const WIN_DRIVE = /^[A-Za-z]:[\\/]/;

/** OpenCode 2.x stores Windows folders with forward slashes (C:/Users/...): show them natively. */
export function nativePath(p: string): string {
  return WIN_DRIVE.test(p) ? p.replace(/\//g, '\\') : p;
}

function isAbsoluteAny(p: string): boolean {
  return p.startsWith('/') || WIN_DRIVE.test(p) || p.startsWith('\\\\');
}

/** Tool inputs may name files relative to the session folder; make them absolute when we can. */
export function resolveIn(base: string | undefined, p: string): string {
  if (isAbsoluteAny(p) || !base) return nativePath(p);
  return WIN_DRIVE.test(base) ? path.win32.join(base, p) : path.posix.join(base, p);
}
