// OpenCode <= 1.1.x storage (G1): one pretty-printed JSON file per object under <data>/storage.
// [SRC sst/opencode v1.1.65 storage/storage.ts, session/message-v2.ts]
//   session/<projectID>/<sessionID>.json   Session.Info {id, projectID, directory, parentID?, title, time{created, updated}}
//   message/<sessionID>/<messageID>.json   message info (user | assistant)
//   part/<messageID>/<partID>.json         parts
//   project/<projectID>.json               {id, worktree, ...}
// Message and part ids ascend, so sorted file names are chronological. Writes are not atomic and
// revert/compaction removes files, so half-written or vanished files are skipped, never fatal.
// The 1.2 migration copies this tree into opencode.db without deleting it, so sessions that a
// database also holds are read from the database (see index.ts).

import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ParsedRun, SessionRef } from '../../adapter';
import { isObj } from '../../events';
import { readJson } from '../../jsonl';
import { projectLabel, str } from './common';
import { buildV1Run, type V1Message } from './messages';
import { nativePath } from './paths';

async function list(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // missing folder or no permission: nothing to list here
  }
}

async function mtimeOf(p: string): Promise<number> {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

const jsonNames = (entries: Dirent[]) => entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort();

/**
 * Newest write that touches a session, from stats only: its own file, its message folder (a new
 * message adds a file), the newest message file, and the newest message's part folder and part
 * file (parts are rewritten in place while a step streams).
 */
export async function legacyStamp(storage: string, sessionFile: string, sessionId: string): Promise<{ mtimeMs: number; size: number; messages: number }> {
  const st = await stat(sessionFile);
  const msgDir = path.join(storage, 'message', sessionId);
  const msgs = jsonNames(await list(msgDir));
  let mtimeMs = Math.max(st.mtimeMs, await mtimeOf(msgDir));
  const lastMsg = msgs[msgs.length - 1];
  if (lastMsg) {
    mtimeMs = Math.max(mtimeMs, await mtimeOf(path.join(msgDir, lastMsg)));
    const partDir = path.join(storage, 'part', lastMsg.replace(/\.json$/, ''));
    const parts = jsonNames(await list(partDir));
    mtimeMs = Math.max(mtimeMs, await mtimeOf(partDir));
    if (parts.length) mtimeMs = Math.max(mtimeMs, await mtimeOf(path.join(partDir, parts[parts.length - 1])));
  }
  return { mtimeMs, size: st.size, messages: msgs.length };
}

/** Lists G1 sessions, skipping ids in `skip` (already found in a database). */
export async function discoverLegacy(storage: string, skip: Set<string>): Promise<SessionRef[]> {
  const refs: SessionRef[] = [];
  for (const proj of await list(path.join(storage, 'session'))) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(storage, 'session', proj.name);
    for (const name of jsonNames(await list(dir))) {
      const id = name.replace(/\.json$/, '');
      if (skip.has(id)) continue;
      const file = path.join(dir, name);
      try {
        const s = await legacyStamp(storage, file, id);
        refs.push({ agent: 'opencode', path: file, mtimeMs: s.mtimeMs, size: s.size, hint: { kind: 'legacy', storage, session: id } });
      } catch {
        // removed or unreadable between listing and stat: skip it
      }
    }
  }
  return refs;
}

async function tryJson(p: string): Promise<Record<string, unknown> | undefined> {
  try {
    const v = await readJson(p);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Reads one G1 session. The session file itself must parse (else safeParse marks the run unreadable). */
export async function readLegacy(ref: SessionRef): Promise<ParsedRun> {
  const storage = ref.hint?.storage ?? path.dirname(path.dirname(path.dirname(ref.path)));
  const session = await readJson(ref.path);
  if (!isObj(session)) throw new SyntaxError('session file is not an object');
  const id = str(session.id) ?? path.basename(ref.path, '.json');
  const project = str(session.projectID) ? await tryJson(path.join(storage, 'project', `${session.projectID}.json`)) : undefined;
  const dir = str(session.directory) ? nativePath(session.directory as string) : undefined;

  let unreadable = 0;
  const messages: V1Message[] = [];
  const msgDir = path.join(storage, 'message', id);
  for (const name of jsonNames(await list(msgDir))) {
    const info = await tryJson(path.join(msgDir, name));
    if (!info) {
      unreadable++;
      continue;
    }
    const partDir = path.join(storage, 'part', str(info.id) ?? name.replace(/\.json$/, ''));
    const parts: Record<string, unknown>[] = [];
    for (const pn of jsonNames(await list(partDir))) {
      const part = await tryJson(path.join(partDir, pn));
      if (part) parts.push(part);
      else unreadable++;
    }
    messages.push({ info, parts });
  }

  const time = isObj(session.time) ? session.time : {};
  const worktree = project && str(project.worktree);
  const run = buildV1Run(
    {
      title: str(session.title),
      directory: dir,
      projectName: projectLabel(project && str(project.name), worktree || undefined, dir),
      created: typeof time.created === 'number' ? time.created : undefined,
      updated: typeof time.updated === 'number' ? time.updated : undefined,
    },
    messages,
    unreadable,
  );
  // A child session (sub-agent) points at its parent; G1 parents are files next to it.
  if (str(session.parentID)) run.parentPath = path.join(path.dirname(ref.path), `${session.parentID}.json`);
  return run;
}
