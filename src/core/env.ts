// Builds the Env adapters look through. Normally that is simply the user's home folder and
// process.env. ARM_HOME swaps in a different home for tests and for the clean-profile check:
// then every home-like variable is redirected into it and every variable that points into the
// real home is dropped, so nothing from the real profile can leak into a test run.

import os from 'node:os';
import path from 'node:path';
import type { Env } from './adapter';

type Vars = Record<string, string | undefined>;

/** Variables that hold "where the user's stuff lives", redirected under ARM_HOME. */
function redirectedVars(home: string, platform: NodeJS.Platform): Vars {
  const v: Vars = { HOME: home, ARM_HOME: home };
  if (platform === 'win32') {
    v.USERPROFILE = home;
    v.APPDATA = path.win32.join(home, 'AppData', 'Roaming');
    v.LOCALAPPDATA = path.win32.join(home, 'AppData', 'Local');
    const parsed = path.win32.parse(home);
    v.HOMEDRIVE = parsed.root.replace(/\\$/, '');
    v.HOMEPATH = home.slice(v.HOMEDRIVE.length) || '\\';
  } else {
    v.XDG_CONFIG_HOME = path.posix.join(home, '.config');
    v.XDG_DATA_HOME = path.posix.join(home, '.local', 'share');
    v.XDG_STATE_HOME = path.posix.join(home, '.local', 'state');
    v.XDG_CACHE_HOME = path.posix.join(home, '.cache');
  }
  return v;
}

function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (s: string) => (platform === 'win32' ? p.resolve(s).toLowerCase() : p.resolve(s));
  const c = norm(child);
  const r = norm(parent);
  if (c === r) return true;
  const rel = p.relative(r, c);
  return !!rel && !rel.startsWith('..') && !p.isAbsolute(rel);
}

export interface MakeEnvSource {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** The real home folder (os.homedir()). */
  homedir: string;
}

/**
 * The Env for this process. With ARM_HOME set, home is ARM_HOME, home-like variables point into
 * it, and any variable naming a single path inside the real home (CLAUDE_CONFIG_DIR, CODEX_HOME,
 * TEMP, ...) is removed unless it already points inside ARM_HOME.
 */
export function makeEnv(src: MakeEnvSource = { platform: process.platform, env: process.env, homedir: os.homedir() }): Env {
  const override = src.env.ARM_HOME?.trim();
  if (!override) return { platform: src.platform, home: src.homedir, vars: { ...src.env } };

  const p = src.platform === 'win32' ? path.win32 : path.posix;
  const home = p.resolve(override);
  const realRoots = [src.homedir, src.env.APPDATA, src.env.LOCALAPPDATA, src.env.XDG_CONFIG_HOME, src.env.XDG_DATA_HOME]
    .filter((s): s is string => !!s && p.isAbsolute(s));
  const delimiter = src.platform === 'win32' ? ';' : ':';

  const vars: Vars = {};
  for (const [k, v] of Object.entries(src.env)) {
    if (v == null) continue;
    // Path lists (PATH, PSModulePath) are kept; they name programs, not agent data.
    const single = p.isAbsolute(v) && !v.includes(delimiter);
    const pointsAtRealProfile = single && realRoots.some((r) => isInside(v, r, src.platform));
    if (pointsAtRealProfile && !isInside(v, home, src.platform)) continue;
    vars[k] = v;
  }
  Object.assign(vars, redirectedVars(home, src.platform));
  return { platform: src.platform, home, vars };
}
