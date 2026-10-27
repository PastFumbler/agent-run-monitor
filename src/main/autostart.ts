// Start with the OS on Linux: the app's own XDG autostart .desktop file. Kept free of Electron so
// it can be unit-tested with a temporary home folder (autostart.test.ts). Windows and macOS use
// app.setLoginItemSettings in system.ts instead (the Windows Run key is not covered by a test).

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Env } from '@core/adapter';

/** $XDG_CONFIG_HOME/autostart/agent-run-monitor.desktop, or ~/.config/autostart/... */
export function autostartFile(env: Env): string {
  const configHome = env.vars.XDG_CONFIG_HOME || path.join(env.home, '.config');
  return path.join(configHome, 'autostart', 'agent-run-monitor.desktop');
}

/** The .desktop entry. Exec is quoted per the Desktop Entry spec ("`$\ escaped). */
export function desktopEntry(exec: string): string {
  const quoted = `"${exec.replace(/(["`$\\])/g, '\\$1')}"`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Agent Run Monitor',
    'Comment=Watch your coding-agent runs',
    `Exec=${quoted}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/**
 * Writes (enabled) or removes (disabled) only the app's own .desktop file; removing one that is
 * not there is fine. Returns the file's path.
 */
export async function setLinuxAutostart(enabled: boolean, env: Env, exec: string): Promise<string> {
  const file = autostartFile(env);
  if (enabled) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, desktopEntry(exec), 'utf8');
  } else {
    await unlink(file).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  return file;
}
