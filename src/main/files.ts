// The only files the app writes: its own settings and window state, inside userData.
// Writes are atomic (temp file + rename) and refuse any target outside userData.

import { randomBytes } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeSettings, type Settings } from '@shared/settings';

function inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Writes `data` as JSON to `dir/name` atomically. Throws if the target is not inside `dir`. */
export async function writeJsonAtomic(dir: string, name: string, data: unknown): Promise<void> {
  const target = path.join(dir, name);
  if (!inside(target, dir) || path.basename(target) !== name) throw new Error('refusing to write outside the app folder');
  const tmp = path.join(dir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // Windows can briefly refuse the rename while an antivirus scanner holds the old file.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await delay(40 * (attempt + 1));
        continue;
      }
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }
}

async function readJsonFile(file: string): Promise<{ exists: boolean; data?: unknown; error?: string }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    return { exists: true, error: String((e as Error).message) };
  }
  try {
    return { exists: true, data: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
  } catch (e) {
    return { exists: true, error: String((e as Error).message) };
  }
}

export class SettingsFile {
  private chain: Promise<void> = Promise.resolve();
  constructor(readonly dir: string) {}

  get path(): string {
    return path.join(this.dir, 'settings.json');
  }

  /** Missing file: defaults with firstRunComplete false (the wizard runs). Damaged file: defaults, wizard skipped. */
  async load(): Promise<{ settings: Settings; existed: boolean; error?: string }> {
    const r = await readJsonFile(this.path);
    if (!r.exists) return { settings: normalizeSettings(undefined), existed: false };
    const settings = normalizeSettings(r.data);
    if (r.error) settings.firstRunComplete = true;
    return { settings, existed: true, error: r.error };
  }

  /** Saves in order; concurrent saves never interleave. */
  save(settings: Settings): Promise<void> {
    const next = this.chain.then(() => writeJsonAtomic(this.dir, 'settings.json', settings));
    this.chain = next.catch(() => {});
    return next;
  }
}

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const DEFAULT_WINDOW: WindowState = { width: 1280, height: 820, maximized: false };

export async function loadWindowState(dir: string): Promise<WindowState> {
  const r = await readJsonFile(path.join(dir, 'window-state.json'));
  const d = r.data as Partial<WindowState> | undefined;
  if (!d || typeof d !== 'object') return { ...DEFAULT_WINDOW };
  const num = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;
  return {
    x: num(d.x, -100_000, 100_000),
    y: num(d.y, -100_000, 100_000),
    width: num(d.width, 480, 10_000) ?? DEFAULT_WINDOW.width,
    height: num(d.height, 360, 10_000) ?? DEFAULT_WINDOW.height,
    maximized: d.maximized === true,
  };
}

export function saveWindowState(dir: string, s: WindowState): Promise<void> {
  return writeJsonAtomic(dir, 'window-state.json', s);
}
