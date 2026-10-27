// Where Cline, Roo Code and Continue keep their data, per OS.
//
// Editor hosts: VS Code, Code - Insiders, VSCodium, Cursor and Windsurf each have their own
// <UserData>/User/globalStorage/<publisher.name> folder [research: UNVERIFIED for every host
// except VS Code on Windows, which was seen on the development machine]. The folder names come
// from the extensions' package.json (saoudrizwan.claude-dev, rooveterinaryinc.roo-cline) [source].
// Cline 4.x (the "Cline SDK") keeps sessions in ~/.cline/data, with CLINE_DIR / CLINE_DATA_DIR /
// CLINE_SESSION_DATA_DIR overrides [source: sdk/packages/shared/src/storage/paths.ts].
// Continue keeps sessions in ~/.continue/sessions, CONTINUE_GLOBAL_DIR overrides [source:
// core/util/paths.ts].

import { posix, win32 } from 'node:path';
import type { Env } from '../../adapter';

export const CLINE_EXT = 'saoudrizwan.claude-dev';
export const ROO_EXT = 'rooveterinaryinc.roo-cline';

const HOSTS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];
/** Remote-server data folders, used when the monitor runs on the remote machine itself. */
const SERVERS = ['.vscode-server', '.vscode-server-insiders', '.cursor-server', '.windsurf-server', '.vscodium-server'];

function pathFor(env: Env): typeof posix {
  return env.platform === 'win32' ? win32 : posix;
}

/** The <UserData>/User folders of every VS Code-family editor for this OS. */
export function editorUserDirs(env: Env): string[] {
  const p = pathFor(env);
  const v = env.vars;
  const dirs: string[] = [];
  // Portable mode keeps user data next to the executable.
  if (v.VSCODE_PORTABLE) dirs.push(p.join(v.VSCODE_PORTABLE, 'user-data', 'User'));
  const appData =
    env.platform === 'win32'
      ? v.APPDATA || p.join(env.home, 'AppData', 'Roaming')
      : env.platform === 'darwin'
        ? p.join(env.home, 'Library', 'Application Support')
        : v.XDG_CONFIG_HOME || p.join(env.home, '.config');
  for (const h of HOSTS) dirs.push(p.join(appData, h, 'User'));
  if (env.platform === 'linux') {
    dirs.push(p.join(env.home, '.var', 'app', 'com.vscodium.codium', 'config', 'VSCodium', 'User'));
    for (const s of SERVERS) dirs.push(p.join(env.home, s, 'data', 'User'));
  }
  return [...new Set(dirs)];
}

export function extensionRoots(env: Env, ext: string): string[] {
  const p = pathFor(env);
  return editorUserDirs(env).map((u) => p.join(u, 'globalStorage', ext));
}

/** ~/.cline/data (Cline 4.x sessions, and pre-4.0 CLI / JetBrains tasks). */
export function clineDataRoots(env: Env): string[] {
  const p = pathFor(env);
  const v = env.vars;
  const clineDir = v.CLINE_DIR || p.join(env.home, '.cline');
  const roots = [v.CLINE_DATA_DIR || p.join(clineDir, 'data')];
  if (v.CLINE_SESSION_DATA_DIR) roots.push(v.CLINE_SESSION_DATA_DIR);
  return roots;
}

export function clineRoots(env: Env): string[] {
  return [...new Set([...extensionRoots(env, CLINE_EXT), ...clineDataRoots(env)])];
}

export function rooRoots(env: Env): string[] {
  return extensionRoots(env, ROO_EXT);
}

export function continueRoots(env: Env): string[] {
  const p = pathFor(env);
  const o = env.vars.CONTINUE_GLOBAL_DIR?.trim();
  // A relative override is resolved against the working directory, as Continue does.
  const base = o ? (p.isAbsolute(o) ? o : p.resolve(o)) : p.join(env.home, '.continue');
  return [p.join(base, 'sessions')];
}
