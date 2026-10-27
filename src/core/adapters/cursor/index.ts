// Cursor adapter: best-effort. Cursor is closed source and was not installed on the machine this
// adapter was written on, so every format detail comes from public reverse-engineering work (open
// source readers whose code was read, forum posts) and is checked only against synthetic fixtures.
// Generic SQLite behaviour (reading a WAL database through a copy) is tested locally; nothing
// Cursor-specific is.
//
// Three stores, one run per chat, deduplicated by chat id in this order of fidelity:
//   1. IDE Composer store  User/globalStorage/state.vscdb (+ workspaceStorage)  -> composer.ts
//   2. cursor-agent CLI    ~/.cursor/chats/*/<id>/store.db, ~/.cursor/acp-sessions -> store.ts
//   3. Agent transcripts   ~/.cursor/projects/<slug>/agent-transcripts/*.jsonl  -> transcript.ts
// SQLite files (db + -wal, never -shm) are copied into a temp folder and the copy is opened
// read-only with node:sqlite (see sqlite.ts); the originals are only ever stat'ed and read, never
// opened by a SQLite engine. Databases over 2 GB are skipped with a reason.

import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { DiscoverContext, Env, ParseContext, ParseState, SessionRef, SourceAdapter } from '../../adapter';
import { emptyRun, freshState } from '../../adapter';
import { buildAiChatRun, buildComposerRun, discoverUserDir, parseFromDb } from './composer';
import { closeAllSnapshots } from './sqlite';
import { discoverStore, parseStore } from './store';
import { discoverTranscripts, parseTranscript } from './transcript';

export { closeAllSnapshots };

/**
 * Where Cursor keeps data. No Cursor environment override is documented (CURSOR_DATA_PATH and
 * similar belong to third-party tools), so only Electron's own XDG_CONFIG_HOME rule applies on Linux.
 * WSL users should add the Windows-side folder (/mnt/c/Users/<you>/AppData/Roaming/Cursor/User).
 */
export function defaultRoots(env: Env): string[] {
  const p = env.platform === 'win32' ? path.win32 : path.posix;
  const home = env.home;
  const dot = p.join(home, '.cursor');
  if (env.platform === 'win32') {
    const appData = env.vars.APPDATA || p.join(home, 'AppData', 'Roaming');
    return [p.join(appData, 'Cursor', 'User'), dot];
  }
  if (env.platform === 'darwin') return [p.join(home, 'Library', 'Application Support', 'Cursor', 'User'), dot];
  const config = env.vars.XDG_CONFIG_HOME || p.join(home, '.config');
  return [p.join(config, 'Cursor', 'User'), dot, p.join(config, 'cursor')];
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** A root may be a Cursor `User` folder, its parent, `~/.cursor`, or `~/.config/cursor`. */
async function classify(root: string): Promise<{ user?: string; dot?: string }> {
  const out: { user?: string; dot?: string } = {};
  if ((await isDir(path.join(root, 'globalStorage'))) || (await isDir(path.join(root, 'workspaceStorage')))) out.user = root;
  else if (await isDir(path.join(root, 'User', 'globalStorage'))) out.user = path.join(root, 'User');
  for (const d of ['projects', 'chats', 'acp-sessions']) if (await isDir(path.join(root, d))) out.dot = root;
  return out;
}

async function discover(roots: string[], ctx: DiscoverContext): Promise<SessionRef[]> {
  const since = ctx.since > 0 ? ctx.since : 0;
  const kinds = await Promise.all(roots.map(classify));
  const seen = new Set<string>();
  const refs: SessionRef[] = [];
  for (const k of kinds) if (k.user) refs.push(...(await discoverUserDir(k.user, since, seen).catch(() => [])));
  for (const k of kinds) if (k.dot) refs.push(...(await discoverStore(k.dot, since, seen).catch(() => [])));
  for (const k of kinds) if (k.dot) refs.push(...(await discoverTranscripts(k.dot, since, ctx.env, seen).catch(() => [])));
  return refs;
}

/** A database that could not be listed (too large to copy, or corrupt): one run saying why. */
function dbErrorState(ref: SessionRef): ParseState {
  const st = freshState();
  st.run = emptyRun('Cursor chats');
  st.run.title = ref.hint?.tooLarge ? 'Cursor chat database too large to read' : '';
  st.run.readError = ref.hint?.error || "Couldn't read Cursor's chat database.";
  st.size = ref.size;
  st.mtimeMs = ref.mtimeMs;
  return st;
}

async function parse(ref: SessionRef, prev: ParseState | undefined, ctx: ParseContext): Promise<ParseState> {
  switch (ref.hint?.kind) {
    case 'composer':
      return parseFromDb(ref, prev, ctx, buildComposerRun);
    case 'aichat':
      return parseFromDb(ref, prev, ctx, buildAiChatRun);
    case 'store':
      return parseStore(ref, prev, ctx);
    case 'db-error':
      return dbErrorState(ref);
    case 'transcript':
    default:
      if (ref.path.endsWith('.jsonl')) return parseTranscript(ref, prev);
      if (ref.subId) return parseFromDb(ref, prev, ctx, ref.subId.startsWith('aichat:') ? buildAiChatRun : buildComposerRun);
      if (ref.path.endsWith('store.db')) return parseStore(ref, prev, ctx);
      throw new Error('Not a Cursor session file this app knows.');
  }
}

export const adapter: SourceAdapter = {
  id: 'cursor',
  displayName: 'Cursor',
  confidence: 'best-effort',
  note:
    'Reads Cursor chats from its state.vscdb (a temporary read-only copy, up to 2 GB), cursor-agent CLI sessions and agent transcripts. Best-effort: Cursor is closed source; formats come from open-source readers, not a real install.',
  defaultRoots,
  discover,
  parse,
};

export const adapters = [adapter];
