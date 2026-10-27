// OS integration: power state, finish notifications, start-with-the-OS, and the opt-in update check.
// No child processes and no native modules anywhere (Smart App Control and similar policies
// treat both with suspicion), so everything here uses Electron's built-in APIs only.

import { app, Notification, powerMonitor } from 'electron';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_NAMES } from '@shared/schema';
import type { PowerState, RunFinishedNotice, UpdateInfo } from '@shared/ipc';
import { GITHUB_REPO, LATEST_RELEASE_API, RELEASES_URL } from '@shared/project';
import type { Settings } from '@shared/settings';
import type { Env } from '@core/adapter';
import { updateSession, withAllowedUrl } from './security';

// ---- power -------------------------------------------------------------------------------------

/**
 * Battery comes from powerMonitor. Electron exposes no energy-saver / battery-saver flag on any
 * platform, and reading it on Windows would need a native module or a child process (both ruled
 * out), so powerSaver is always false. `known` is true because battery state itself is reliable.
 */
export function powerState(): PowerState {
  let onBattery = false;
  try {
    onBattery = powerMonitor.isOnBatteryPower();
  } catch {
    /* some Linux setups have no power service */
  }
  return { onBattery, powerSaver: false, known: true };
}

export function watchPower(cb: (p: PowerState) => void): void {
  let last = JSON.stringify(powerState());
  const push = () => {
    const p = powerState();
    const key = JSON.stringify(p);
    if (key === last) return;
    last = key;
    cb(p);
  };
  powerMonitor.on('on-battery', push);
  powerMonitor.on('on-ac', push);
  powerMonitor.on('resume', push);
}

// ---- notifications ---------------------------------------------------------------------------

const WORDS: Record<RunFinishedNotice['outcome'], string> = {
  done: 'finished',
  waiting: 'needs you',
  failed: 'failed',
  stuck: 'looks stuck',
};

const COOLDOWN_MS = 20_000;
const lastShown = new Map<string, number>();
// Windows drops click handlers of notifications that were garbage collected: keep the recent ones.
const alive: Notification[] = [];

/** Plain words for a notice. Deliberately leaves out the run's title: it is the user's prompt and may show on a lock screen. */
export function noticeText(n: RunFinishedNotice): { title: string; body: string } {
  const agent = AGENT_NAMES[n.run.agent] ?? n.run.agent;
  return { title: 'Agent Run Monitor', body: `${agent}: ${n.run.projectName} — ${WORDS[n.outcome]}` };
}

export function shouldNotify(n: RunFinishedNotice, s: Settings, now: number): boolean {
  if (n.run.parentId) return false; // sub-agents: a workflow can finish hundreds; the parent says enough
  const failure = n.outcome === 'failed' || n.outcome === 'stuck';
  if (failure ? !s.notifyOnFailure : !s.notifyOnFinish) return false;
  const prev = lastShown.get(n.run.id) ?? 0;
  if (now - prev < COOLDOWN_MS) return false;
  return true;
}

export function showNotice(n: RunFinishedNotice, onClick: (runId: string) => void): void {
  if (!Notification.isSupported()) return;
  lastShown.set(n.run.id, Date.now());
  const { title, body } = noticeText(n);
  const note = new Notification({ title, body, silent: false });
  note.on('click', () => onClick(n.run.id));
  note.on('close', () => {
    const i = alive.indexOf(note);
    if (i >= 0) alive.splice(i, 1);
  });
  alive.push(note);
  if (alive.length > 10) alive.shift();
  note.show();
}

// ---- start with the OS ---------------------------------------------------------------------------

function desktopEntry(exec: string): string {
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
 * Registers or removes the login item. Skipped for unpackaged builds, which would register the
 * development Electron binary. On Linux it writes only the app's own .desktop file.
 */
export async function applyAutostart(enabled: boolean, env: Env, log: (m: string) => void): Promise<void> {
  if (!app.isPackaged) {
    log(`start with the OS ${enabled ? 'on' : 'off'}: skipped (not a packaged build)`);
    return;
  }
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }
  const configHome = env.vars.XDG_CONFIG_HOME || path.join(env.home, '.config');
  const file = path.join(configHome, 'autostart', 'agent-run-monitor.desktop');
  if (enabled) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, desktopEntry(process.env.APPIMAGE || process.execPath), 'utf8');
  } else {
    await unlink(file).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}

// ---- update check ------------------------------------------------------------------------------

function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

let cached: { at: number; info: UpdateInfo } | undefined;

/** One GET to the GitHub Releases API, only while the setting is on. Cached for an hour. */
export async function checkForUpdate(current: string, enabled: boolean): Promise<UpdateInfo> {
  if (!enabled) return { current, error: 'Update checks are turned off in Settings.' };
  if (GITHUB_REPO.startsWith('OWNER/')) return { current, error: 'This build has no release page configured.' };
  if (cached && Date.now() - cached.at < 3_600_000 && cached.info.current === current) return cached.info;
  try {
    const ses = updateSession({ log: () => {} });
    const res = await withAllowedUrl(LATEST_RELEASE_API, () =>
      ses.fetch(LATEST_RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `agent-run-monitor/${current}` },
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      }),
    );
    if (!res.ok) return { current, error: `The release page answered ${res.status}.` };
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    const latest = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '').slice(0, 40) : undefined;
    if (!latest) return { current, error: 'The release page had no version.' };
    const html = typeof body.html_url === 'string' && body.html_url.startsWith(`${RELEASES_URL}/`) ? body.html_url : RELEASES_URL;
    const info: UpdateInfo = { current, latest, url: isNewer(latest, current) ? html : undefined };
    cached = { at: Date.now(), info };
    return info;
  } catch (e) {
    return { current, error: `Couldn't reach the release page: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
}
