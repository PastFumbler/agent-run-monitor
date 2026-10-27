// The live-session registry, `<root>/sessions/<pid>.json`, rewritten by Claude Code whenever a
// session's state changes: {pid, sessionId, status: busy|shell|idle|waiting, waitingFor?, ...}.
// It is the only place a pending permission prompt is visible; the transcript looks the same
// whether a tool is running or waiting for approval. Fields and values verified against the
// v2.1.310 bundle and a real install. Entries can outlive a crash, so an entry only counts when
// its process is alive (signal 0 probes without touching it) AND the transcript itself has an
// open tool call, which guards against a reused PID.

import { join } from 'node:path';
import { isObj } from '../../events';
import { listDir, readSmallJson } from './io';

export interface RegistryEntry {
  pid: number;
  status: string;
  waitingFor?: string;
}

/** The registry entry for `sessionId` whose process is still alive, if any. */
export async function liveEntry(root: string, sessionId: string): Promise<RegistryEntry | undefined> {
  const dir = join(root, 'sessions');
  for (const e of await listDir(dir)) {
    // Only <pid>.json; the <pid>.<sha256>.key files next to them are messaging keys, never read.
    if (!e.isFile() || !/^\d+\.json$/.test(e.name)) continue;
    const rec = await readSmallJson(join(dir, e.name), 64 * 1024);
    if (!isObj(rec) || rec.sessionId !== sessionId) continue;
    const pid = Number(rec.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) continue;
    return {
      pid,
      status: typeof rec.status === 'string' ? rec.status : '',
      waitingFor: typeof rec.waitingFor === 'string' ? rec.waitingFor : undefined,
    };
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
}

/** Plain words for a registry wait. */
export function waitDetail(waitingFor: string | undefined): string {
  if (waitingFor === 'permission prompt') return 'Waiting for tool approval';
  if (waitingFor === 'input needed') return 'Waiting for your answer';
  return 'Waiting for your input';
}
