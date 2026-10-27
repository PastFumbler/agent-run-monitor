// Start with the OS on Linux: the XDG autostart .desktop file, written into a temporary home.
// The Windows (Run key) and macOS (login item) paths go through Electron's
// app.setLoginItemSettings and are not covered by a test.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Env } from '@core/adapter';
import { autostartFile, desktopEntry, setLinuxAutostart } from './autostart';

let home: string;
const env = (vars: Record<string, string | undefined> = {}): Env => ({ platform: 'linux', home, vars });

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'arm-autostart-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('Linux autostart', () => {
  it('writes ~/.config/autostart/agent-run-monitor.desktop and removes it again', async () => {
    const exec = '/opt/Agent Run Monitor/agent-run-monitor';
    const file = await setLinuxAutostart(true, env(), exec);
    expect(file).toBe(path.join(home, '.config', 'autostart', 'agent-run-monitor.desktop'));
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n')).toEqual([
      '[Desktop Entry]',
      'Type=Application',
      'Name=Agent Run Monitor',
      'Comment=Watch your coding-agent runs',
      'Exec="/opt/Agent Run Monitor/agent-run-monitor"',
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ]);

    await setLinuxAutostart(false, env(), exec);
    expect(existsSync(file)).toBe(false);
    // Only our own file is touched: the folder stays, nothing else is created.
    expect(readdirSync(path.dirname(file))).toEqual([]);
  });

  it('follows XDG_CONFIG_HOME', async () => {
    const xdg = path.join(home, 'xdg');
    const file = await setLinuxAutostart(true, env({ XDG_CONFIG_HOME: xdg }), '/usr/bin/arm');
    expect(file).toBe(path.join(xdg, 'autostart', 'agent-run-monitor.desktop'));
    expect(existsSync(file)).toBe(true);
    expect(existsSync(path.join(home, '.config'))).toBe(false);
    expect(autostartFile(env({ XDG_CONFIG_HOME: '' }))).toBe(path.join(home, '.config', 'autostart', 'agent-run-monitor.desktop'));
  });

  it('turning it off when it was never on is fine', async () => {
    await expect(setLinuxAutostart(false, env(), '/usr/bin/arm')).resolves.toBeTruthy();
    expect(existsSync(path.join(home, '.config'))).toBe(false);
  });

  it('leaves other autostart entries alone', async () => {
    const other = path.join(home, '.config', 'autostart', 'someone-else.desktop');
    await setLinuxAutostart(true, env(), '/usr/bin/arm');
    writeFileSync(other, '[Desktop Entry]\n');
    await setLinuxAutostart(false, env(), '/usr/bin/arm');
    expect(readdirSync(path.dirname(other))).toEqual(['someone-else.desktop']);
  });

  it('quotes Exec per the Desktop Entry spec, so an AppImage path cannot inject arguments', () => {
    expect(desktopEntry('/home/a/My "odd" $dir`x`\\app.AppImage')).toContain(
      'Exec="/home/a/My \\"odd\\" \\$dir\\`x\\`\\\\app.AppImage"',
    );
  });
});
