// Aider (aider-chat) source adapter.
//
// Provenance: the format was checked against Aider's source (github.com/Aider-AI/aider main at
// 5dc9490, v0.86.x: io.py, args.py, main.py, base_coder.py, editblock_coder.py, architect_coder.py),
// with older tags (v0.10 to v0.75) for the stable core prefixes. Aider was NOT installed on the
// machine this was written on, so nothing here is checked against a real installation; the
// fixtures are synthesised by re-implementing io.py's writers. Confidence: 'source'.
//
// What Aider writes: one append-only Markdown file per project, .aider.chat.history.md in the git
// root (or launch folder), holding every session. Each "# aider chat started at" header starts a
// session; we return one SessionRef per session (subId = the header's byte offset) and parse only
// that slice. Only the session start time is recorded (local time), so every event gets it.

import { dirname, join, posix, win32 } from 'node:path';
import { emptyRun, type DiscoverContext, type Env, type ParseContext, type ParsedRun, type ParseState, type SessionRef, type SourceAdapter } from '../../adapter';
import { baseName } from '../../events';
import { ABANDONED_AFTER } from '../../status';
import { HISTORY_FILE, headerAt, indexSessions, pathKey, statFile, walkForHistories } from './discover';
import { scanLines } from './lines';
import { HEADER } from './patterns';
import { newParserState, SessionParser, type ParserState } from './parser';

const FORMAT_CHANGED = 'No records this app recognises; the agent may have changed its format.';

/** Carried between incremental parses in ParseState.extra (plain data only). */
interface AiderExtra {
  v: 1;
  /** The session's header offset. */
  start: number;
  /** Parser state as it was before the last finish() (pending block not yet flushed). */
  parser: ParserState;
  /** The run as it was at that moment, without its events: see markRun. */
  mark: { rest: Omit<ParsedRun, 'events'>; count: number };
}

function isExtra(x: unknown, start: number): x is AiderExtra {
  const e = x as AiderExtra | undefined;
  return !!e && e.v === 1 && e.start === start && !!e.parser && !!e.mark;
}

// finish() flushes the block still being collected and sets the turn. The next lines may extend
// that block (a reply still being written, a "Cost:" continuation), so before finishing we note
// where the run stood and roll back to it on the next incremental parse.
function markRun(run: ParsedRun): AiderExtra['mark'] {
  const { events, ...rest } = run;
  return { rest: structuredClone(rest), count: events.length };
}

function rollback(run: ParsedRun, mark: AiderExtra['mark']): ParsedRun | undefined {
  if (run.dropped !== mark.rest.dropped || run.events.length < mark.count) return undefined;
  return { ...structuredClone(mark.rest), events: run.events.slice(0, mark.count) };
}

function projectOf(ref: SessionRef): { name: string; path: string } {
  const path = ref.hint?.projectPath ?? dirname(ref.path);
  return { name: ref.hint?.project ?? baseName(path), path };
}

async function parseSession(ref: SessionRef, prev: ParseState | undefined): Promise<ParseState> {
  const start = ref.subId ? Number(ref.subId) : 0;
  if (!Number.isFinite(start) || start < 0) throw new Error(`Bad session offset ${ref.subId}`);
  const st = await statFile(ref.path);
  if (!st) throw Object.assign(new Error('The file is gone'), { code: 'ENOENT' });

  let run: ParsedRun | undefined;
  let pstate: ParserState | undefined;
  let offset = start;
  // A file deleted and recreated (rm .aider*) can grow past its old size before we look again:
  // only resume when the session's header is still where it was.
  if (prev && isExtra(prev.extra, start) && st.size >= prev.size && (ref.subId === undefined || (await headerAt(ref.path, start)))) {
    if (st.size === prev.size && st.mtimeMs === prev.mtimeMs) return prev;
    // A later session already started: nothing appended can belong to this one.
    if (prev.extra.parser.ended) return { ...prev, size: st.size, mtimeMs: st.mtimeMs };
    run = rollback(prev.run, prev.extra.mark);
    if (run) {
      pstate = structuredClone(prev.extra.parser);
      offset = prev.offset;
    }
  }
  if (!run || !pstate) {
    const project = projectOf(ref);
    run = emptyRun(project.name);
    run.projectPath = project.path;
    pstate = newParserState(start);
  }

  const parser = new SessionParser(run, pstate);
  let first = offset === start && ref.subId !== undefined;
  let moved = false;
  const res = await scanLines(ref.path, offset, (bytes) => {
    const line = bytes.toString('utf8');
    if (first) {
      first = false;
      // The offset came from discover(); if the file was rewritten it may no longer be a header.
      if (!HEADER.test(line)) {
        moved = true;
        return false;
      }
    }
    return parser.feed(line);
  });

  if (moved) {
    run.readError = 'This session is no longer where it was in the file (the file was rewritten).';
    return { offset: start, size: st.size, mtimeMs: st.mtimeMs, run, extra: {} };
  }

  const extra: AiderExtra = { v: 1, start, parser: structuredClone(parser.s), mark: markRun(run) };
  parser.finish({ fileMtime: st.mtimeMs, stale: Date.now() - st.mtimeMs >= ABANDONED_AFTER });
  if (!parser.s.headerSeen && run.skipped > 0) run.readError = FORMAT_CHANGED;
  if (!run.title) run.title = parser.s.startedAt ? `Aider session ${new Date(parser.s.startedAt).toLocaleString()}` : '';
  return { offset: res.consumed, size: res.size, mtimeMs: res.mtimeMs, run, extra: extra as unknown as Record<string, unknown> };
}

async function discoverSessions(roots: string[], ctx: DiscoverContext): Promise<SessionRef[]> {
  const files = new Map<string, string>();
  const addFile = (p: string) => {
    const k = pathKey(p);
    if (!files.has(k)) files.set(k, p);
  };
  // The home folder holds a history file when Aider was started there; never walk all of home.
  addFile(join(ctx.env.home, HISTORY_FILE));
  for (const root of [...roots, ...ctx.projectRoots]) {
    const st = await statFile(root);
    if (st) {
      addFile(root); // a file root: a custom --chat-history-file
      continue;
    }
    for (const f of await walkForHistories(root)) addFile(f);
  }

  const refs: SessionRef[] = [];
  for (const path of files.values()) {
    const st = await statFile(path);
    if (!st || st.size === 0) continue;
    if (ctx.since > 0 && st.mtimeMs < ctx.since) continue;
    let sessions;
    try {
      sessions = await indexSessions(path, st.size, st.mtimeMs);
    } catch {
      continue; // unreadable right now (locked, permissions): try again next scan
    }
    const dir = dirname(path);
    const hint = { project: baseName(dir), projectPath: dir };
    if (sessions.length === 0) {
      // A non-empty file with no session header: let parse() report the format change.
      refs.push({ agent: 'aider', path, mtimeMs: st.mtimeMs, size: st.size, hint });
      continue;
    }
    sessions.forEach((s, i) => {
      const next = sessions[i + 1];
      // Earlier sessions ended no later than the next one started; header-only duplicates
      // (Aider re-execs itself in some cases) are dropped unless they are the live one.
      if (next && !s.content) return;
      const mtimeMs = next ? Math.min(st.mtimeMs, next.startedAt ?? st.mtimeMs) : st.mtimeMs;
      if (ctx.since > 0 && mtimeMs < ctx.since) return;
      // size is the whole file's size, not the slice's: the store compares it with a stat of the
      // file and treats a smaller size as a truncation (forcing a full re-parse of every session).
      refs.push({ agent: 'aider', path, subId: String(s.offset), mtimeMs, size: st.size, hint });
    });
  }
  return refs;
}

function posixOrWin(env: Env) {
  return env.platform === 'win32' ? win32 : posix;
}

export const adapter: SourceAdapter = {
  id: 'aider',
  displayName: 'Aider',
  confidence: 'source',
  note:
    'Reads .aider.chat.history.md in the project folders you choose (and your home folder). Format checked against Aider\'s source, not a live install; only session start times are recorded.',
  defaultRoots(env: Env): string[] {
    // No central folder on any OS (args.py: the file lives in the git root or launch folder).
    // The home-folder file is the only fixed place; AIDER_CHAT_HISTORY_FILE can name another.
    const p = posixOrWin(env);
    const roots = [p.join(env.home, HISTORY_FILE)];
    const custom = env.vars.AIDER_CHAT_HISTORY_FILE;
    if (custom && p.isAbsolute(custom)) roots.push(custom);
    return roots;
  },
  discover: discoverSessions,
  parse(ref: SessionRef, prev: ParseState | undefined, _ctx: ParseContext): Promise<ParseState> {
    return parseSession(ref, prev);
  },
};

export const aiderAdapter = adapter;
export const adapters: SourceAdapter[] = [adapter];
