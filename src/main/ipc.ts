// IPC handlers for every Backend method. Every call is checked: it must come from the app's own
// page in the app's own window, and every argument is validated before it reaches the store.

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import path from 'node:path';
import { IPC } from '@shared/ipc';
import { AGENT_IDS } from '@shared/schema';
import type { Settings, SourceSettings } from '@shared/settings';
import { normalizeSettings } from '@shared/settings';
import { isAppUrl } from './security';

export interface IpcImpl {
  appInfo(): unknown;
  getSettings(): unknown;
  setSettings(patch: Partial<Settings>): Promise<unknown>;
  listRuns(): unknown;
  getRun(id: string, limit: number): Promise<unknown>;
  getSources(rescan: boolean): Promise<unknown>;
  pickFolder(): Promise<string | null>;
  revealSource(id: string): Promise<void>;
  getPower(): unknown;
  checkForUpdate(): Promise<unknown>;
  watchRuns(ids: string[]): void;
  setUpdateInterval(ms: number): void;
}

export class BadRequest extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validId(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length >= 200) throw new BadRequest('bad run id');
  return v;
}

export function validLimit(v: unknown): number {
  if (v === undefined || v === null) return 2000;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequest('bad limit');
  return Math.min(20_000, Math.max(1, Math.floor(v)));
}

export function validIds(v: unknown): string[] {
  if (!Array.isArray(v)) throw new BadRequest('bad id list');
  return v.slice(0, 100).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200);
}

export function validInterval(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequest('bad interval');
  return Math.min(60_000, Math.max(0, Math.round(v)));
}

const absolutePaths = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)) : undefined;

/**
 * Merges a settings patch into the current settings and normalises the result. Sources merge per
 * agent, so `{sources: {codex: {enabled: false}}}` keeps codex's custom folders. Folder lists keep
 * absolute paths only.
 */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  if (!isObj(patch)) throw new BadRequest('settings patch must be an object');
  if (JSON.stringify(patch).length > 512 * 1024) throw new BadRequest('settings patch too large');
  const merged: Record<string, unknown> = { ...current, ...patch };
  const sources: Record<string, SourceSettings> = { ...current.sources };
  if (isObj(patch.sources)) {
    for (const id of AGENT_IDS) {
      const p = patch.sources[id];
      if (!isObj(p)) continue;
      const roots = absolutePaths(p.customRoots);
      sources[id] = {
        enabled: typeof p.enabled === 'boolean' ? p.enabled : current.sources[id].enabled,
        customRoots: roots ?? current.sources[id].customRoots,
      };
    }
  }
  merged.sources = sources;
  if ('projectRoots' in patch) merged.projectRoots = absolutePaths(patch.projectRoots) ?? current.projectRoots;
  merged.version = 1;
  return normalizeSettings(merged);
}

export function registerIpc(impl: IpcImpl, opts: { window: () => WebContents | undefined; devOrigin?: string; log: (m: string) => void }) {
  const trusted = (e: IpcMainInvokeEvent | IpcMainEvent) => {
    const wc = opts.window();
    const url = e.senderFrame?.url ?? '';
    return !!wc && e.sender === wc && isAppUrl(url, opts.devOrigin);
  };

  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) throw new Error('refused: unknown sender');
      try {
        return await fn(...args);
      } catch (e) {
        if (e instanceof BadRequest) opts.log(`ipc ${channel}: ${e.message}`);
        throw e;
      }
    });
  };
  const listen = (channel: string, fn: (...args: unknown[]) => void) => {
    ipcMain.on(channel, (event, ...args) => {
      if (!trusted(event)) return;
      try {
        fn(...args);
      } catch (e) {
        opts.log(`ipc ${channel}: ${String((e as Error).message)}`);
      }
    });
  };

  handle(IPC.appInfo, () => impl.appInfo());
  handle(IPC.getSettings, () => impl.getSettings());
  handle(IPC.setSettings, (patch) => impl.setSettings(patch as Partial<Settings>));
  handle(IPC.listRuns, () => impl.listRuns());
  handle(IPC.getRun, (id, limit) => impl.getRun(validId(id), validLimit(limit)));
  handle(IPC.getSources, (rescan) => impl.getSources(rescan === true));
  handle(IPC.pickFolder, () => impl.pickFolder());
  handle(IPC.revealSource, (id) => impl.revealSource(validId(id)));
  handle(IPC.getPower, () => impl.getPower());
  handle(IPC.checkForUpdate, () => impl.checkForUpdate());
  listen(IPC.watchRuns, (ids) => impl.watchRuns(validIds(ids)));
  listen(IPC.setUpdateInterval, (ms) => impl.setUpdateInterval(validInterval(ms)));
}
