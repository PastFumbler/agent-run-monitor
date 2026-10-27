// OpenCode 2.x storage (G3): opencode.db tables `session_v2` + `session_message`.
// [SRC sst/opencode main @ f993a89: packages/core/src/database/schema.gen.ts, session/{sql,store,projector}.ts,
//  packages/schema/src/{session-message,session-error,file-diff,llm}.ts, core/src/tool/plugin/edit.ts]
// session_message.data is the message minus `id` and `type` (both are columns); rows are ordered by
// `seq`. All time_* values are epoch ms. `idle` rows mark the end of a turn (succeeded | failed |
// interrupted). A held execution claim (`time_suspended`) means a turn is running. Pending
// permission asks are not persisted anywhere, so "waiting for approval" cannot be seen [SRC].

import type { FileOp, ParsedRun, TurnState } from '../../adapter';
import { isObj, pushEvent, textOf, toMs } from '../../events';
import {
  NO_RECORDS,
  addTokens,
  emitStepFiles,
  emitTool,
  errorInfo,
  modelName,
  newBuilder,
  num,
  opOf,
  projectLabel,
  settle,
  str,
  type Builder,
} from './common';
import { nativePath, resolveIn } from './paths';
import { all, asNum, asText, each, one, parseJson, pick, tableNames, type Database, type Row } from './sqlite';

const SESSION_COLS = [
  'id', 'project_id', 'parent_id', 'title', 'directory', 'model', 'tokens_input', 'tokens_output', 'tokens_reasoning',
  'tokens_cache_read', 'tokens_cache_write', 'time_created', 'time_updated', 'idle_outcome', 'time_suspended',
] as const;

export interface SessionListing {
  id: string;
  updated: number;
  created?: number;
  rows: number;
  parent?: string;
}

/** Sessions in session_v2 with their newest activity (session_message.time_updated grows while a row streams). */
export function listV2(db: Database): SessionListing[] {
  const cols = pick(db, 'session_v2', ['id', 'parent_id', 'time_created', 'time_updated']);
  const stats = new Map<string, { last: number; n: number }>();
  if (tableNames(db).has('session_message')) {
    for (const r of all(db, 'SELECT session_id, MAX(time_updated) AS last, COUNT(*) AS n FROM session_message GROUP BY session_id'))
      stats.set(String(r.session_id), { last: asNum(r.last) ?? 0, n: asNum(r.n) ?? 0 });
  }
  return all(db, `SELECT ${cols} FROM session_v2`)
    .filter((r) => typeof r.id === 'string')
    .map((r) => {
      const s = stats.get(String(r.id));
      return {
        id: String(r.id),
        created: asNum(r.time_created),
        updated: Math.max(asNum(r.time_updated) ?? 0, s?.last ?? 0),
        rows: s?.n ?? 0,
        parent: asText(r.parent_id),
      };
    });
}

/** A cheap fingerprint of one session, to skip re-building runs that did not change. */
export function v2Signature(db: Database, id: string): string {
  const s = one(db, `SELECT ${pick(db, 'session_v2', ['time_updated', 'time_suspended', 'idle_outcome'])} FROM session_v2 WHERE id = ?`, [id]);
  const m = one(db, 'SELECT MAX(time_updated) AS last, COUNT(*) AS n, MAX(seq) AS seq FROM session_message WHERE session_id = ?', [id]);
  return JSON.stringify([s ?? null, m ?? null]);
}

/** Shared by the 2.x and 1.x tables: both have project(id, worktree, name). */
export function projectName(db: Database, projectId: string | undefined, dir: string | undefined): string | undefined {
  const p =
    projectId && tableNames(db).has('project')
      ? one(db, `SELECT ${pick(db, 'project', ['name', 'worktree'])} FROM project WHERE id = ?`, [projectId])
      : undefined;
  return projectLabel(asText(p?.name), asText(p?.worktree), dir);
}

export function buildV2Run(db: Database, id: string): ParsedRun {
  const s = one(db, `SELECT ${pick(db, 'session_v2', SESSION_COLS)} FROM session_v2 WHERE id = ?`, [id]);
  if (!s) throw new Error('This session is no longer in the OpenCode database.');
  const dir = asText(s.directory) ? nativePath(asText(s.directory)!) : undefined;
  const b = newBuilder(dir, projectName(db, asText(s.project_id), dir), asText(s.title));
  const run = b.run;
  run.model = modelName(asText(s.model));
  // A sub-agent (task tool) session: its parent is another session_v2 row in this database.
  run.parentSubId = asText(s.parent_id) || undefined;
  const sessionIn = (asNum(s.tokens_input) ?? 0) + (asNum(s.tokens_cache_read) ?? 0) + (asNum(s.tokens_cache_write) ?? 0);
  const sessionOut = (asNum(s.tokens_output) ?? 0) + (asNum(s.tokens_reasoning) ?? 0);
  if (sessionIn || sessionOut) {
    run.inputTokens = sessionIn;
    run.outputTokens = sessionOut;
  }

  const t: TurnTracker = { turn: 'unknown', errorInTurn: false, fromIdle: false };
  let lastAt = asNum(s.time_updated) ?? 0;
  let rows = 0;
  // Row by row: tool outputs can be megabytes each, so a long session is never held as one array.
  each(db, 'SELECT type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? ORDER BY seq', [id], (r) => {
    rows++;
    lastAt = Math.max(lastAt, asNum(r.time_updated) ?? 0);
    handleRow(b, r, t);
  });

  // A held execution claim means a turn is running (or the process died mid-turn) unless an idle row
  // ended it. A step that already failed or was interrupted keeps that state: the claim outliving a
  // crash must not turn a failed run back into a running one.
  if (s.time_suspended != null && !t.fromIdle && (t.turn === 'completed' || t.turn === 'unknown')) {
    t.turn = 'in_progress';
    t.detail = undefined;
  }
  if (t.turn === 'unknown' && asText(s.idle_outcome)) idleTurn(t, asText(s.idle_outcome)!, undefined);
  settle(b, t.turn, t.detail, t.turn === 'in_progress' || t.turn === 'unknown');

  if (rows && !b.recognised) run.readError = NO_RECORDS;
  const created = asNum(s.time_created);
  if (created && (!run.startedAt || created < run.startedAt)) run.startedAt = created;
  if (lastAt && (!run.lastEventAt || lastAt > run.lastEventAt)) run.lastEventAt = lastAt;
  return run;
}

interface TurnTracker {
  turn: TurnState;
  detail?: string;
  /** An error event was already shown for the current turn (the idle row repeats it). */
  errorInTurn: boolean;
  /** The turn state came from an `idle` row, which is definitive. */
  fromIdle: boolean;
}

function idleTurn(t: TurnTracker, outcome: string, error: unknown): void {
  t.fromIdle = true;
  if (outcome === 'succeeded') t.turn = 'completed';
  else if (outcome === 'interrupted') {
    t.turn = 'aborted';
    t.detail = 'Interrupted';
  } else if (outcome === 'failed') {
    t.turn = 'error';
    t.detail = errorInfo(error)?.text ?? t.detail ?? 'The turn failed';
  } else t.turn = 'unknown';
}

function handleRow(b: Builder, r: Row, t: TurnTracker): void {
  const run = b.run;
  const type = asText(r.type) ?? '';
  const d = parseJson(r.data);
  const ts = asNum(r.time_created);
  if (!isObj(d)) {
    run.skipped++; // unreadable data column
    return;
  }
  const sys = (text: string) => pushEvent(run, { kind: 'system', text, ts });
  switch (type) {
    case 'user': {
      const text = str(d.text) ?? '';
      const files = Array.isArray(d.files) ? d.files.length : 0;
      pushEvent(run, { kind: 'user', text: files ? `${text}\n[${files} attached file${files > 1 ? 's' : ''}]` : text, ts });
      Object.assign(t, { turn: 'in_progress', detail: undefined, errorInTurn: false, fromIdle: false });
      b.open.clear();
      break;
    }
    case 'synthetic':
    case 'system':
      sys(str(d.description) ?? str(d.text) ?? type);
      break;
    case 'skill':
      sys(`Skill: ${str(d.name) ?? str(d.skill) ?? ''}`.trim());
      break;
    case 'agent-switched':
      sys(`Agent: ${str(d.agent) ?? '?'}`);
      break;
    case 'model-switched':
      run.model = modelName(d.model) ?? run.model;
      sys(`Model: ${modelName(d.model) ?? '?'}`);
      break;
    case 'location-switched':
      sys(`Location: ${str(d.location) ?? str(d.subpath) ?? '?'}`);
      break;
    case 'shell':
      shellRow(b, d, ts, t);
      break;
    case 'assistant':
      assistantRow(b, d, ts, t);
      break;
    case 'compaction': {
      const failed = d.status === 'failed';
      pushEvent(run, failed
        ? { kind: 'error', text: `Compaction failed${errorInfo(d.error) ? `: ${errorInfo(d.error)!.text}` : ''}`, isError: true, ts }
        : { kind: 'system', text: `Compacting the conversation (${str(d.reason) ?? 'auto'}, ${str(d.status) ?? 'running'})`, ts });
      if (isObj(d.tokens)) addTokens(b, d.tokens);
      break;
    }
    case 'idle': {
      const outcome = str(d.outcome) ?? '';
      const err = errorInfo(d.error);
      if (outcome === 'failed' && !t.errorInTurn) pushEvent(run, { kind: 'error', text: err?.text ?? 'The turn failed', isError: true, ts });
      if (outcome === 'interrupted') sys('Interrupted');
      idleTurn(t, outcome, d.error);
      b.open.clear();
      break;
    }
    default:
      run.skipped++;
      return;
  }
  b.recognised++;
}

/** The user's own `!command` (not the agent's shell tool). */
function shellRow(b: Builder, d: Record<string, unknown>, ts: number | undefined, t: TurnTracker): void {
  const time = isObj(d.time) ? d.time : {};
  const output = isObj(d.output) ? str(d.output.output) : undefined;
  const done = time.completed != null || d.exit != null || (d.status !== 'running' && d.status !== undefined);
  const exit = num(d.exit);
  emitTool(
    b,
    {
      id: str(d.shellID),
      name: 'shell',
      status: done ? (exit && exit !== 0 ? 'error' : 'completed') : 'running',
      input: { command: str(d.command) ?? '' },
      output: output ?? '',
      error: output ?? `Exit code ${exit}`,
      start: toMs(time.created) ?? ts,
      end: toMs(time.completed),
      files: [],
    },
    ts,
    new Set(),
  );
  if (!done && t.turn !== 'in_progress') {
    t.turn = 'in_progress';
    t.fromIdle = false;
  }
}

function assistantRow(b: Builder, d: Record<string, unknown>, ts: number | undefined, t: TurnTracker): void {
  const run = b.run;
  const time = isObj(d.time) ? d.time : {};
  run.model = modelName(d.model) ?? run.model;
  // A new step starts only after the previous step's tools finished: any still open were cut off.
  b.open.clear();
  const touched = new Set<string>();
  const content = Array.isArray(d.content) ? d.content : [];
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c.type === 'text') {
      if (str(c.text)) pushEvent(run, { kind: 'assistant', text: c.text as string, ts });
    } else if (c.type === 'reasoning') {
      const ct = isObj(c.time) ? c.time : {};
      if (str(c.text)) pushEvent(run, { kind: 'reasoning', text: c.text as string, ts: toMs(ct.created) ?? ts });
    } else if (c.type === 'tool') {
      emitTool(b, v2Tool(b, c), ts, touched);
    } else run.skipped++;
  }
  const snap = isObj(d.snapshot) ? d.snapshot : {};
  emitStepFiles(b, snap.files, toMs(time.completed) ?? ts, touched);
  if (isObj(d.tokens)) addTokens(b, d.tokens);

  const err = errorInfo(d.error);
  if (err) {
    pushEvent(run, err.aborted ? { kind: 'system', text: err.text, ts: toMs(time.completed) ?? ts } : { kind: 'error', text: err.text, isError: true, ts: toMs(time.completed) ?? ts });
    if (!err.aborted) t.errorInTurn = true;
  }
  t.fromIdle = false;
  const retrying = isObj(d.retry) && time.completed == null;
  // An error with no retry pending ends the turn even before time.completed is written.
  if (time.completed == null && !(err && !retrying)) {
    t.turn = 'in_progress';
    t.detail = isObj(d.retry) ? `Retrying after an error (attempt ${num(d.retry.attempt) ?? '?'})` : undefined;
  } else if (err) {
    t.turn = err.aborted ? 'aborted' : 'error';
    t.detail = err.text;
  } else if (d.finish === 'stop' || d.finish === 'length' || d.finish === 'content-filter') {
    t.turn = 'completed';
  } else if (d.finish === 'error') {
    t.turn = 'error';
    t.detail = 'The model stopped with an error';
  } else {
    t.turn = 'in_progress'; // 'tool-calls': the next step follows
  }
}

/** G3 tool state: streaming {input: string} | running {input} | completed {input, content[]} | error {input, error{}}. */
function v2Tool(b: Builder, c: Record<string, unknown>) {
  const st = isObj(c.state) ? c.state : {};
  const time = isObj(c.time) ? c.time : {};
  const meta = isObj(st.metadata) ? st.metadata : {};
  const status = str(st.status) ?? 'running';
  const files: { path: string; op: FileOp; text: string }[] = [];
  if (Array.isArray(meta.files))
    for (const f of meta.files) if (isObj(f) && str(f.file)) files.push({ path: resolveIn(b.dir, f.file as string), op: opOf(f.status), text: str(f.patch) ?? '' });
  const contentText = Array.isArray(st.content)
    ? st.content.map((x) => (isObj(x) && x.type === 'text' ? str(x.text) ?? '' : isObj(x) ? `[${str(x.type) ?? 'item'} ${str(x.filename) ?? str(x.mime) ?? ''}]`.replace(' ]', ']') : '')).filter(Boolean).join('\n')
    : textOf(st.content);
  return {
    id: str(c.id),
    name: str(c.name) ?? 'tool',
    status,
    input: st.input,
    output: contentText,
    error: (isObj(st.error) ? str(st.error.message) : undefined) ?? errorInfo(st.error)?.text ?? (contentText || undefined),
    start: toMs(time.created),
    end: toMs(time.completed),
    files,
    op: (str(c.name) === 'write' ? (files[0]?.op ?? 'edit') : undefined) as FileOp | undefined,
  };
}
