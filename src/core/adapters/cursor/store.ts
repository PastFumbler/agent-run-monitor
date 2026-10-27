// cursor-agent CLI store: ~/.cursor/chats/<md5(cwd)>/<sessionId>/{meta.json, store.db} and
// ~/.cursor/acp-sessions/<sessionId>/{meta.json, store.db}.
//
// Provenance (research notes; NOT verified against a real installation: the CLI is not installed here):
// - store.db tables meta(key, value) and blobs(id, data); meta row '0' holds hex(UTF-8 JSON) with
//   latestRootBlobId, name, createdAt, lastUsedModel: several sources incl. a published DDL.
// - Tree blobs are protobuf frames with 32-byte SHA-256 refs (fields 1 and 2); leaf blobs are JSON
//   messages {role, content}: two code readers agree, a third disagrees. Walked breadth-first as
//   both of those readers do.
// - Block type strings (tool-call, tool-result, reasoning) are unverified; OpenAI-style tool_calls
//   are handled too. There are no per-message timestamps and no token counts in this store.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyRun, freshState, type ParseContext, type ParseState, type ParsedRun, type SessionRef } from '../../adapter';
import { isObj, pushEvent, textOf, toMs } from '../../events';
import { cleanPrompt, cursorFilePath, cursorInputSummary, cursorToolKind, fileOpFor, jsonString, projectNameOf, stripRedacted, workspacePathFrom } from './common';
import { NO_RECORDS, realName } from './composer';
import { asText, dbStamp, one, parseJson, readOnce, tableNames, type Database } from './sqlite';

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const MAX_BLOBS = 200_000;

async function dirs(p: string): Promise<string[]> {
  try {
    return (await readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(p, d.name));
  } catch {
    return [];
  }
}

/** Session folders under one root (`~/.cursor` or `~/.config/cursor`). */
async function sessionDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const hashDir of await dirs(join(root, 'chats'))) out.push(...(await dirs(hashDir)));
  out.push(...(await dirs(join(root, 'acp-sessions'))));
  return out;
}

export async function discoverStore(root: string, since: number, seen: Set<string>): Promise<SessionRef[]> {
  const refs: SessionRef[] = [];
  for (const dir of await sessionDirs(root)) {
    const id = dir.split(/[\\/]/).pop() ?? '';
    if (seen.has(id)) continue;
    const db = join(dir, 'store.db');
    const [st, wal, meta] = await Promise.all([stat(db).catch(() => null), stat(`${db}-wal`).catch(() => null), stat(join(dir, 'meta.json')).catch(() => null)]);
    if (!st) continue; // store.db appears only once the session has a conversation
    const mtimeMs = Math.max(st.mtimeMs, wal?.mtimeMs ?? 0, meta?.mtimeMs ?? 0);
    if (since > 0 && mtimeMs < since) continue;
    seen.add(id);
    refs.push({ agent: 'cursor', path: db, mtimeMs, size: st.size + (wal?.size ?? 0), hint: { kind: 'store', session: id } });
  }
  return refs;
}

// ---------- blob graph ----------

function readVarint(d: Uint8Array, i: number): [number, number] {
  let v = 0;
  let mul = 1;
  for (let n = 0; n < 10; n++) {
    if (i >= d.length) throw new RangeError('varint');
    const b = d[i++];
    v += (b & 0x7f) * mul;
    if (!(b & 0x80)) return [v, i];
    mul *= 128;
  }
  throw new RangeError('varint');
}

const hex = (d: Uint8Array, a: number, b: number) => Buffer.from(d.buffer, d.byteOffset + a, b - a).toString('hex');

/** Child blob ids of a tree node: length-32 fields 1 (message) and 2 (subtree), in order. */
export function childRefs(d: Uint8Array): string[] {
  const out: string[] = [];
  try {
    let i = 0;
    while (i < d.length) {
      let tag: number;
      [tag, i] = readVarint(d, i);
      const field = Math.floor(tag / 8);
      const wt = tag & 7;
      if (wt === 2) {
        let len: number;
        [len, i] = readVarint(d, i);
        if (i + len > d.length) throw new RangeError('len');
        if (len === 32 && (field === 1 || field === 2)) out.push(hex(d, i, i + 32));
        i += len;
      } else if (wt === 0) [, i] = readVarint(d, i);
      else if (wt === 1) i += 8;
      else if (wt === 5) i += 4;
      else throw new RangeError('wire type');
    }
    return out;
  } catch {
    // Not clean protobuf: fall back to scanning for 0x0a|0x12, 0x20, <32 bytes>.
    out.length = 0;
    for (let i = 0; i + 34 <= d.length; ) {
      if ((d[i] === 0x0a || d[i] === 0x12) && d[i + 1] === 0x20) {
        out.push(hex(d, i + 2, i + 34));
        i += 34;
      } else i++;
    }
    return out;
  }
}

/** A JSON leaf: the message, or null for JSON that is not a message. undefined = not JSON (a tree node). */
function leafMessage(d: Uint8Array): Obj | null | undefined {
  let i = 0;
  while (i < d.length && (d[i] === 0x20 || d[i] === 0x0a || d[i] === 0x0d || d[i] === 0x09)) i++;
  if (d[i] !== 0x7b) return undefined; // '{'
  const v = parseJson(Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString('utf8'));
  if (v === undefined) return undefined;
  return isObj(v) && typeof v.role === 'string' ? v : null;
}

/** JSON message leaves, breadth-first from the root blob. */
function readMessages(db: Database, rootId: string): { messages: Obj[]; unknownLeaves: number } {
  const get = db.prepare('SELECT data FROM blobs WHERE id = ?');
  const messages: Obj[] = [];
  let unknownLeaves = 0;
  const seen = new Set<string>();
  const queue = [rootId];
  let head = 0; // an index, not shift(): shift is O(n) and trees can hold many thousands of blobs
  while (head < queue.length && seen.size < MAX_BLOBS) {
    const id = queue[head++];
    if (seen.has(id)) continue;
    seen.add(id);
    const data = get.get(id)?.data;
    if (!(data instanceof Uint8Array)) {
      if (typeof data === 'string') {
        const v = parseJson(data);
        if (isObj(v) && typeof v.role === 'string') messages.push(v);
      }
      continue;
    }
    const msg = leafMessage(data);
    if (msg) messages.push(msg);
    else if (msg === null) unknownLeaves++; // JSON, but not a message: never scan it for refs
    else {
      const kids = childRefs(data);
      if (!kids.length && data.length && data[0] === 0x7b) unknownLeaves++;
      for (const k of kids) queue.push(k);
    }
  }
  return { messages, unknownLeaves };
}

// ---------- messages -> events ----------

interface StoreTurn {
  pending: Map<string, { name: string; msgIndex: number }>;
  lastRole?: string;
  lastIndex: number;
}

function addToolCall(run: ParsedRun, id: string, name: string, args: unknown, turn: StoreTurn, msgIndex: number): void {
  const kind = cursorToolKind(name);
  const filePath = cursorFilePath(args);
  pushEvent(run, {
    kind: 'tool_call',
    text: cursorInputSummary(args),
    toolName: name,
    toolCallId: id,
    toolKind: kind,
    filePath,
    fileOp: kind === 'edit' && filePath ? fileOpFor(name) : undefined,
  });
  turn.pending.set(id, { name, msgIndex });
}

function addToolResult(run: ParsedRun, id: string | undefined, name: string | undefined, result: unknown, isError: boolean, turn: StoreTurn): void {
  const r = jsonString(result);
  // AI SDK v5 output: {type: 'text' | 'json' | 'error-text' | 'error-json', value}.
  const outType = isObj(r) ? str(r.type) : undefined;
  if (outType?.startsWith('error')) isError = true;
  const text = isObj(r) && 'value' in r ? textOf(r.value) : textOf(r);
  pushEvent(run, { kind: 'tool_result', text, toolCallId: id, toolName: name, toolKind: cursorToolKind(name), isError: isError || undefined });
  if (id) turn.pending.delete(id);
}

/** One message. Returns false when its role or blocks are not recognised. */
function addMessage(run: ParsedRun, m: Obj, idx: number, turn: StoreTurn): boolean {
  const role = str(m.role);
  const content = m.content;
  const blocks: Obj[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.filter(isObj) : [];
  if (role === 'system') return true; // the agent's own instructions: known, not shown
  if (role === 'user') {
    const raw = blocks.map((b) => str(b.text) ?? '').join('\n');
    const wp = workspacePathFrom(raw);
    if (wp && !run.projectPath) {
      run.projectPath = wp;
      run.projectName = projectNameOf(wp);
    }
    const text = cleanPrompt(raw);
    if (text) {
      pushEvent(run, { kind: 'user', text });
      turn.lastRole = 'user';
      turn.lastIndex = idx;
    }
    return true;
  }
  if (role === 'assistant') {
    let known = 0;
    for (const b of blocks) {
      const t = str(b.type);
      if (t === 'text' && str(b.text)) pushEvent(run, { kind: 'assistant', text: stripRedacted(b.text as string) });
      else if ((t === 'reasoning' || t === 'thinking' || t === 'redacted-reasoning') && (str(b.text) ?? str(b.thinking)))
        pushEvent(run, { kind: 'reasoning', text: (str(b.text) ?? str(b.thinking)) as string });
      else if (t === 'tool-call' || t === 'tool_call' || t === 'tool_use') {
        const id = str(b.toolCallId) ?? str(b.id) ?? `call-${idx}-${known}`;
        addToolCall(run, id, str(b.toolName) ?? str(b.name) ?? 'tool', jsonString(b.args ?? b.input), turn, idx);
      } else if (t !== 'text' && t !== 'reasoning' && t !== 'thinking') {
        run.skipped++;
        continue;
      }
      known++;
    }
    // OpenAI-style function calls.
    if (Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls.filter(isObj)) {
        const fn = isObj(c.function) ? c.function : {};
        addToolCall(run, str(c.id) ?? `call-${idx}-${known}`, str(fn.name) ?? 'tool', jsonString(fn.arguments), turn, idx);
        known++;
      }
    }
    turn.lastRole = 'assistant';
    turn.lastIndex = idx;
    return known > 0 || blocks.length === 0;
  }
  if (role === 'tool') {
    let known = 0;
    for (const b of blocks) {
      if (b.type === 'tool-result' || b.type === 'tool_result') {
        addToolResult(run, str(b.toolCallId) ?? str(b.tool_use_id), str(b.toolName), b.result ?? b.output ?? b.content, b.isError === true || b.is_error === true, turn);
        known++;
      }
    }
    if (!known && str(m.tool_call_id)) {
      addToolResult(run, str(m.tool_call_id), str(m.name), content, false, turn);
      known++;
    }
    turn.lastRole = 'tool';
    turn.lastIndex = idx;
    return known > 0;
  }
  return false;
}

function decodeMeta(v: unknown): Obj {
  const t = (typeof v === 'string' ? v : v instanceof Uint8Array ? (asText(v) ?? '') : '').trim();
  if (t.startsWith('{')) return (parseJson(t) as Obj) ?? {};
  if (/^[0-9a-f]+$/i.test(t)) {
    const j = parseJson(Buffer.from(t, 'hex').toString('utf8'));
    if (isObj(j)) return j;
  }
  return {};
}

export function buildStoreRun(db: Database, ref: SessionRef, metaJson: Obj, fileMtime: number): ParsedRun {
  const run = emptyRun();
  const tables = tableNames(db);
  if (!tables.has('meta') || !tables.has('blobs')) {
    run.readError = NO_RECORDS;
    return run;
  }
  const meta = decodeMeta(one(db, "SELECT value FROM meta WHERE key = '0'")?.value);
  const cwd = str(metaJson.cwd);
  if (cwd) {
    run.projectPath = cwd;
    run.projectName = projectNameOf(cwd);
  }
  run.model = str(meta.lastUsedModel);
  run.startedAt = toMs(metaJson.createdAtMs) ?? toMs(meta.createdAt);
  run.lastEventAt = toMs(metaJson.updatedAtMs) ?? fileMtime;
  // The session's own name first; pushEvent falls back to the first prompt.
  run.title = realName(meta.name) ?? realName(metaJson.title) ?? '';

  const root = str(meta.latestRootBlobId);
  const { messages, unknownLeaves } = root ? readMessages(db, root) : { messages: [], unknownLeaves: 0 };
  run.skipped += unknownLeaves;
  const turn: StoreTurn = { pending: new Map(), lastIndex: -1 };
  let recognised = 0;
  messages.forEach((m, i) => {
    if (addMessage(run, m, i, turn)) recognised++;
    else run.skipped++;
  });

  // No status field in this store: judge from the last message.
  const open = [...turn.pending.entries()].filter(([, p]) => p.msgIndex === turn.lastIndex).pop();
  if (open) {
    run.turn = 'in_progress';
    run.openTool = { name: open[1].name, kind: cursorToolKind(open[1].name), since: run.lastEventAt ?? fileMtime };
  } else if (turn.lastRole === 'assistant') run.turn = 'completed';
  else if (turn.lastRole === 'user' || turn.lastRole === 'tool') run.turn = 'in_progress';
  else run.turn = 'unknown';
  if (recognised === 0 && (messages.length > 0 || unknownLeaves > 0 || !root)) run.readError = NO_RECORDS;
  return run;
}

export async function parseStore(ref: SessionRef, prev: ParseState | undefined, ctx: ParseContext): Promise<ParseState> {
  const dir = ref.path.replace(/[\\/][^\\/]+$/, '');
  const metaPath = join(dir, 'meta.json');
  const [stamp, metaStat] = await Promise.all([dbStamp(ref.path), stat(metaPath).catch(() => null)]);
  const key = `${stamp.key}|${metaStat?.mtimeMs ?? 0}`;
  if (prev && prev.extra.stamp === key) return prev;
  let metaJson: Obj = {};
  try {
    const j = JSON.parse(await readFile(metaPath, 'utf8'));
    if (isObj(j)) metaJson = j;
  } catch {
    /* meta.json is optional */
  }
  // Session databases are small: load, read and free at once instead of caching.
  const st = freshState();
  st.run = await readOnce(ref.path, (db) => buildStoreRun(db, ref, metaJson, stamp.mtimeMs), ctx.tempDir);
  st.size = stamp.size + stamp.walSize;
  st.mtimeMs = ref.mtimeMs;
  st.extra = { stamp: key };
  return st;
}
