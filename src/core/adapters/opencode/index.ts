// OpenCode adapter (sst/opencode). Confidence: source. Every format detail was checked against
// OpenCode's source code (sst/opencode main @ f993a89, 2026-10-27; tags v1.1.65, v1.2.27, v1.19.4),
// NOT against a real installation: OpenCode was not installed on the machine this was written on,
// and the fixtures are synthesized from those source definitions.
//
// Three on-disk generations, one run per session, deduplicated by session id:
//   G3  opencode*.db  session_v2 + session_message   (2.x, current)         -> v2.ts
//   G2  opencode*.db  session + message + part        (1.2 - 1.19)           -> v1.ts + messages.ts
//   G1  storage/session|message|part/**.json          (<= 1.1.x, fallback)   -> legacy.ts + messages.ts
// The 1.x and 2.x lines ship in parallel, migrations keep the older tables and the JSON tree, and
// dev/preview builds use opencode-<channel>.db, so all of them are read and the freshest copy of a
// session wins (G3 over G2 over G1). Databases are copied (db + -wal) into the temp folder and the
// copy is opened read-only with node:sqlite (see src/core/sqlite.ts); the originals are only stat'ed
// and read, never opened by a SQLite engine. Only the project, session*,
// session_message, message and part tables are queried: account / credential tables hold tokens.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DiscoverContext, ParseContext, ParseState, SessionRef, SourceAdapter } from '../../adapter';
import { emptyRun, freshState } from '../../adapter';
import { describeError } from '../../build';
import { discoverLegacy, legacyStamp, readLegacy } from './legacy';
import { DB_NAME, defaultRoots } from './paths';
import { closeAllSnapshots, tableNames, withDb } from './sqlite';
import { buildV1DbRun, hasV1, listV1, v1Signature } from './v1';
import { buildV2Run, listV2, v2Signature, type SessionListing } from './v2';

export { closeAllSnapshots, defaultRoots, isRelevantChange };

type Kind = 'v2' | 'v1';

async function statOrNull(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

/** A root is the OpenCode data folder (opencode*.db and/or storage/), or a database file ($OPENCODE_DB). */
async function classify(root: string): Promise<{ dbs: string[]; storage?: string }> {
  const st = await statOrNull(root);
  if (!st) return { dbs: [] };
  // A file root is $OPENCODE_DB, which may have any name (opencode.sqlite, mine.db3, ...).
  if (st.isFile()) return { dbs: [root] };
  if (!st.isDirectory()) return { dbs: [] };
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return { dbs: [] };
  }
  const dbs = names.filter((n) => DB_NAME.test(n)).map((n) => path.join(root, n));
  const storage = path.join(root, 'storage');
  const hasStorage = (await statOrNull(path.join(storage, 'session')))?.isDirectory();
  return { dbs, storage: hasStorage ? storage : undefined };
}

function dbRefs(dbPath: string, tempDir: string | undefined): Promise<SessionRef[]> {
  return withDb(dbPath, tempDir, (db) => {
    const out: SessionRef[] = [];
    const v2 = tableNames(db).has('session_v2') ? listV2(db) : [];
    const inV2 = new Set(v2.map((s) => s.id));
    const add = (s: SessionListing, kind: Kind) =>
      out.push({
        agent: 'opencode',
        path: dbPath,
        subId: s.id,
        mtimeMs: s.updated || s.created || 0,
        // Rows in the session: grows as it does. (The store may briefly swap in the file's size.)
        size: s.rows,
        hint: { kind, ...(s.parent ? { parent: s.parent } : {}) },
      });
    for (const s of v2) add(s, 'v2');
    // The 2.x import keeps the 1.x tables; read the ones it has not imported (yet).
    if (hasV1(db)) for (const s of listV1(db)) if (!inV2.has(s.id)) add(s, 'v1');
    return out;
  });
}

async function discover(roots: string[], ctx: DiscoverContext): Promise<SessionRef[]> {
  const since = ctx.since > 0 ? ctx.since : 0;
  const best = new Map<string, SessionRef>(); // by session id: newest copy wins
  const errors: SessionRef[] = [];
  const seenDb = new Set<string>();
  const storages = new Set<string>();
  for (const root of roots) {
    const { dbs, storage } = await classify(root);
    if (storage) storages.add(storage);
    for (const db of dbs) {
      const key = ctx.env.platform === 'win32' ? path.resolve(db).toLowerCase() : path.resolve(db);
      if (seenDb.has(key)) continue;
      seenDb.add(key);
      const st = await statOrNull(db);
      if (!st || !st.isFile()) continue;
      try {
        for (const ref of await dbRefs(db, ctx.tempDir)) {
          const prev = best.get(ref.subId!);
          if (!prev || ref.mtimeMs > prev.mtimeMs) best.set(ref.subId!, ref);
        }
      } catch (e) {
        // Unreadable or too large: one run that says so, instead of silently showing nothing.
        errors.push({ agent: 'opencode', path: db, subId: 'db-error', mtimeMs: st.mtimeMs, size: st.size, hint: { kind: 'db-error', error: describeError(e) } });
      }
    }
  }
  const skip = new Set(best.keys());
  for (const storage of storages) {
    for (const ref of await discoverLegacy(storage, skip).catch(() => [])) {
      const id = ref.hint!.session;
      if (!best.has(id)) best.set(id, ref);
    }
  }
  return [...best.values(), ...errors].filter((r) => !since || r.mtimeMs >= since);
}

/** Storage folders whose files are sessions; everything else in the data folder is noise. */
const LEGACY_DIRS = new Set(['session', 'message', 'part', 'project']);

/**
 * OpenCode's data folder also holds snapshot/ (a git object store written on every step), log/,
 * bin/ and tool-output/. A change there must not trigger a re-discovery, which reloads the whole
 * database. Relevant: database files and their sidecars, and the JSON tree's session folders.
 */
function isRelevantChange(p: string): boolean {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const base = parts[parts.length - 1] ?? '';
  // A database, its sidecars, or the data folder itself (a new database appearing in it).
  if (/\.(?:db|db3|sqlite3?)(?:-wal|-shm|-journal)?$/i.test(base) || base === 'opencode') return true;
  const i = parts.lastIndexOf('storage');
  return i >= 0 && (i === parts.length - 1 || LEGACY_DIRS.has(parts[i + 1]));
}

function stateFor(ref: SessionRef, run: ParseState['run'], extra: Record<string, unknown>): ParseState {
  return { offset: 0, size: ref.size, mtimeMs: ref.mtimeMs, run, extra };
}

/** Database sessions are rebuilt only when the database changed and this session's rows did. */
async function parseDbSession(ref: SessionRef, prev: ParseState | undefined, kind: Kind | undefined, tempDir: string): Promise<ParseState> {
  const id = ref.subId!;
  return withDb(ref.path, tempDir, (db, stamp) => {
    if (prev && !prev.run.readError && prev.extra.stamp === stamp.key) return prev;
    const k: Kind = kind ?? (tableNames(db).has('session_v2') ? 'v2' : 'v1');
    const sig = k === 'v2' ? v2Signature(db, id) : v1Signature(db, id);
    if (prev && !prev.run.readError && prev.extra.sig === sig) {
      prev.extra = { ...prev.extra, stamp: stamp.key };
      return prev;
    }
    const run = k === 'v2' ? buildV2Run(db, id) : buildV1DbRun(db, id);
    // A child session (sub-agent) is linked to its parent session in the same database.
    if (run.parentSubId) run.parentPath = ref.path;
    return stateFor(ref, run, { stamp: stamp.key, sig });
  });
}

/** JSON-tree sessions are re-read only when a stat of their files shows a change. */
async function parseLegacySession(ref: SessionRef, prev: ParseState | undefined): Promise<ParseState> {
  const storage = ref.hint?.storage ?? path.dirname(path.dirname(path.dirname(ref.path)));
  const s = await legacyStamp(storage, ref.path, ref.hint?.session ?? path.basename(ref.path, '.json'));
  const sig = `${s.mtimeMs}:${s.size}:${s.messages}`;
  if (prev && !prev.run.readError && prev.extra.sig === sig) return prev;
  return stateFor(ref, await readLegacy(ref), { sig });
}

function dbErrorState(ref: SessionRef): ParseState {
  const st = freshState();
  st.run = emptyRun('OpenCode sessions');
  st.run.readError = ref.hint?.error || "Couldn't read OpenCode's session database.";
  st.size = ref.size;
  st.mtimeMs = ref.mtimeMs;
  return st;
}

async function parse(ref: SessionRef, prev: ParseState | undefined, ctx: ParseContext): Promise<ParseState> {
  const kind = ref.hint?.kind;
  if (kind === 'db-error') return dbErrorState(ref);
  if (kind === 'legacy' || (!kind && ref.path.endsWith('.json'))) return parseLegacySession(ref, prev);
  if (ref.subId) return parseDbSession(ref, prev, kind === 'v2' || kind === 'v1' ? kind : undefined, ctx.tempDir);
  throw new Error('Not an OpenCode session this app knows.');
}

export const adapter: SourceAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  confidence: 'source',
  note:
    'Reads OpenCode sessions from opencode.db (2.x session_v2 and 1.x session tables, from a temporary read-only copy, up to 2 GB) and the older storage/ JSON files, under $XDG_DATA_HOME/opencode or ~/.local/share/opencode on every OS. Checked against OpenCode source, not a real install.',
  defaultRoots,
  discover,
  parse,
  isRelevantChange,
};

export const adapters = [adapter];
