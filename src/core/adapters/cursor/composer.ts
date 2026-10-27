// Cursor IDE "Composer" store: User/globalStorage/state.vscdb (table cursorDiskKV) plus the
// per-folder User/workspaceStorage/<id>/{workspace.json,state.vscdb}.
//
// Provenance (research notes, 2026-10-27; Cursor is closed source and was NOT installed here, so
// nothing below is verified against a real installation):
// - composerData:<id> / bubbleId:<id>:<bubbleId> rows, fullConversationHeadersOnly ordering,
//   bubble type 1 = user / 2 = assistant, thinking.text, toolFormerData {toolCallId, name, params
//   (JSON string), result (JSON string, absent while pending), status}: agreed by several open-source
//   readers (cursor-history, vibe-replay, cppa-cursor-browser, cursaves).
// - Legacy inline `conversation` / `conversationMap`, workspace `composer.composerData.allComposers`
//   (Cursor <= 2.6), global ItemTable `composer.composerHeaders` (3.0+): several sources.
// - composerHeaders SQL table (3.17+), gitWorktree, errorDetails shape, requireUserApproval as a
//   "waiting for approval" signal: single source or inference. Status rules are heuristics.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyRun, freshState, type OpenTool, type ParseContext, type ParseState, type ParsedRun, type SessionRef } from '../../adapter';
import { isObj, pushEvent, textOf, toMs } from '../../events';
import {
  cursorFilePath,
  cursorInputSummary,
  cursorToolKind,
  fileOpFor,
  jsonString,
  projectNameOf,
  resolveIn,
  stripRedacted,
  uriToPath,
} from './common';
import { DbTooLargeError, all, dbStamp, one, openSnapshot, parseJson, readOnce, tableNames, type Database, type DbStamp } from './sqlite';

export const NO_RECORDS = "No records this app recognises; the agent may have changed its format.";

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// ---------- workspace storage ----------

interface WorkspaceInfo {
  folder?: string;
  /** Pre-3.0 composers listed in this workspace (their project is this folder). */
  composerIds: string[];
  /** Pre-composer chat panel tabs (2023-2024). */
  tabs: { tabId: string; title?: string; lastSendTime?: number }[];
}

const wsCache = new Map<string, { key: string; info: Omit<WorkspaceInfo, 'folder'> }>();

function readWorkspaceDb(db: Database): Omit<WorkspaceInfo, 'folder'> {
  const info: Omit<WorkspaceInfo, 'folder'> = { composerIds: [], tabs: [] };
  if (!tableNames(db).has('ItemTable')) return info;
  const get = (key: string) => parseJson(one(db, 'SELECT value FROM ItemTable WHERE key = ?', [key])?.value);
  const cd = get('composer.composerData');
  if (isObj(cd) && Array.isArray(cd.allComposers)) {
    for (const c of cd.allComposers) if (isObj(c) && str(c.composerId)) info.composerIds.push(c.composerId as string);
  }
  const chat = get('workbench.panel.aichat.view.aichat.chatdata');
  if (isObj(chat) && Array.isArray(chat.tabs)) {
    for (const t of chat.tabs) {
      if (isObj(t) && str(t.tabId) && Array.isArray(t.bubbles) && t.bubbles.length)
        info.tabs.push({ tabId: t.tabId as string, title: str(t.chatTitle), lastSendTime: toMs(t.lastSendTime) });
    }
  }
  return info;
}

async function workspaceInfo(dir: string, since: number): Promise<WorkspaceInfo | undefined> {
  let folder: string | undefined;
  try {
    const w = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8'));
    folder = uriToPath(w?.folder ?? w?.workspace);
  } catch {
    /* no workspace.json: an empty window */
  }
  const dbPath = join(dir, 'state.vscdb');
  let stamp: DbStamp;
  try {
    stamp = await dbStamp(dbPath);
  } catch {
    return folder ? { folder, composerIds: [], tabs: [] } : undefined;
  }
  if (since > 0 && stamp.mtimeMs < since) return { folder, composerIds: [], tabs: [] };
  const hit = wsCache.get(dbPath);
  if (hit && hit.key === stamp.key) return { folder, ...hit.info };
  try {
    const info = await readOnce(dbPath, readWorkspaceDb);
    wsCache.set(dbPath, { key: stamp.key, info });
    return { folder, ...info };
  } catch {
    return { folder, composerIds: [], tabs: [] }; // unreadable workspace DB: still use its folder
  }
}

// ---------- global composer index ----------

interface ComposerEntry {
  id: string;
  title?: string;
  projectPath?: string;
  workspaceId?: string;
  updatedAt?: number;
  isSubagent?: boolean;
}

interface Header {
  name?: string;
  workspaceId?: string;
  projectPath?: string;
  createdAt?: number;
  updatedAt?: number;
  isSubagent?: boolean;
}

function headerFrom(h: Obj, extra: Obj = {}): Header {
  const wi = isObj(h.workspaceIdentifier) ? h.workspaceIdentifier : undefined;
  return {
    name: str(h.name),
    workspaceId: str(extra.workspaceId) ?? str(wi?.id),
    projectPath: uriToPath(wi?.uri),
    createdAt: toMs(extra.createdAt ?? h.createdAt),
    updatedAt: toMs(extra.lastUpdatedAt ?? h.lastUpdatedAt),
    isSubagent: Boolean(extra.isSubagent ?? h.isSubagent),
  };
}

/** Session headers from the 3.0+ ItemTable index and the 3.17+ composerHeaders table. */
function readHeaders(db: Database, tables: Set<string>): Map<string, Header> {
  const headers = new Map<string, Header>();
  if (tables.has('ItemTable')) {
    const v = parseJson(one(db, "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'")?.value);
    if (isObj(v) && Array.isArray(v.allComposers))
      for (const h of v.allComposers) if (isObj(h) && str(h.composerId)) headers.set(h.composerId as string, headerFrom(h));
  }
  if (tables.has('composerHeaders')) {
    for (const r of all(db, 'SELECT * FROM composerHeaders')) {
      const id = str(r.composerId);
      if (!id) continue;
      const value = parseJson(r.value);
      const h = headerFrom(isObj(value) ? value : {}, r as Obj);
      const old = headers.get(id);
      headers.set(id, { ...old, ...Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)) });
    }
  }
  return headers;
}

/** Cursor's placeholder names for a chat that has not been named yet (a guess): use the prompt instead. */
export function realName(name: unknown): string | undefined {
  const n = str(name)?.trim();
  return n && !/^(new (chat|agent|composer|tab)|untitled)$/i.test(n) ? n : undefined;
}

function listComposers(db: Database): { entries: ComposerEntry[]; headers: Map<string, Header> } {
  const tables = tableNames(db);
  const headers = readHeaders(db, tables);
  if (!tables.has('cursorDiskKV')) return { entries: [], headers };
  // Range scan on the key index (LIKE would scan the whole, possibly huge, table). Only the summary
  // fields are pulled out, in SQLite, so long legacy inline conversations are never copied into JS.
  // CAST: a BLOB would otherwise be read as JSONB; json_valid keeps one corrupt row from failing all.
  const rows = all(
    db,
    `SELECT key,
       CASE WHEN json_valid(t) THEN json_extract(t, '$.name') END AS name,
       CASE WHEN json_valid(t) THEN json_extract(t, '$.lastUpdatedAt') END AS lastUpdatedAt,
       CASE WHEN json_valid(t) THEN json_extract(t, '$.createdAt') END AS createdAt,
       CASE WHEN json_valid(t) THEN json_extract(t, '$.gitWorktree.worktreePath') END AS wt
     FROM (SELECT key, CAST(value AS TEXT) AS t FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;')`,
  );
  const entries: ComposerEntry[] = [];
  for (const r of rows) {
    const id = String(r.key).slice('composerData:'.length);
    if (!id) continue;
    const h = headers.get(id) ?? {};
    entries.push({
      id,
      title: realName(r.name) ?? realName(h.name),
      projectPath: str(r.wt) ?? h.projectPath,
      workspaceId: h.workspaceId,
      updatedAt: toMs(r.lastUpdatedAt) ?? h.updatedAt ?? toMs(r.createdAt) ?? h.createdAt,
      isSubagent: h.isSubagent,
    });
  }
  return { entries, headers };
}

const globalCache = new Map<string, { key: string; entries?: ComposerEntry[]; error?: unknown }>();

async function globalComposers(dbPath: string, stamp: DbStamp): Promise<ComposerEntry[]> {
  const hit = globalCache.get(dbPath);
  if (hit && hit.key === stamp.key) {
    if (hit.entries) return hit.entries;
    throw hit.error; // same unreadable bytes as last time: don't load them again on every poll
  }
  try {
    const snap = await openSnapshot(dbPath);
    const { entries } = listComposers(snap.db);
    globalCache.set(dbPath, { key: snap.stamp.key, entries });
    return entries;
  } catch (e) {
    globalCache.set(dbPath, { key: stamp.key, error: e });
    throw e;
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Lists the composers in one Cursor `User` folder, one SessionRef per composer (subId = composerId),
 * plus legacy chat-panel tabs. `seen` collects every composer id so other stores can skip duplicates.
 */
export async function discoverUserDir(userDir: string, since: number, seen: Set<string>): Promise<SessionRef[]> {
  const refs: SessionRef[] = [];
  const wsFolders = new Map<string, string>();
  const composerFolder = new Map<string, string>();
  const wsRoot = join(userDir, 'workspaceStorage');
  for (const id of await subdirs(wsRoot)) {
    const info = await workspaceInfo(join(wsRoot, id), since);
    if (!info) continue;
    if (info.folder) wsFolders.set(id, info.folder);
    for (const cid of info.composerIds) if (info.folder) composerFolder.set(cid, info.folder);
    const dbPath = join(wsRoot, id, 'state.vscdb');
    for (const t of info.tabs) {
      const ts = t.lastSendTime ?? 0;
      if (since > 0 && ts && ts < since) continue;
      const st = await stat(dbPath).catch(() => null);
      if (!st) continue;
      refs.push({
        agent: 'cursor',
        path: dbPath,
        subId: `aichat:${t.tabId}`,
        mtimeMs: ts || st.mtimeMs,
        size: st.size,
        hint: compact({ kind: 'aichat', projectPath: info.folder, title: t.title }),
      });
    }
  }

  const dbPath = join(userDir, 'globalStorage', 'state.vscdb');
  let stamp: DbStamp;
  try {
    stamp = await dbStamp(dbPath);
  } catch {
    return refs; // no global DB (not installed, or permissions)
  }
  let entries: ComposerEntry[];
  try {
    entries = await globalComposers(dbPath, stamp);
  } catch (e) {
    // Too large or unreadable: one placeholder run that explains why.
    if (since > 0 && stamp.mtimeMs < since) return refs;
    refs.push({
      agent: 'cursor',
      path: dbPath,
      mtimeMs: stamp.mtimeMs,
      size: stamp.size + stamp.walSize,
      hint: { kind: 'db-error', error: e instanceof Error ? e.message : String(e), tooLarge: e instanceof DbTooLargeError ? '1' : '' },
    });
    return refs;
  }
  for (const c of entries) {
    seen.add(c.id);
    const mtimeMs = c.updatedAt ?? stamp.mtimeMs;
    if (since > 0 && mtimeMs < since) continue;
    const projectPath = c.projectPath ?? (c.workspaceId ? wsFolders.get(c.workspaceId) : undefined) ?? composerFolder.get(c.id);
    refs.push({
      agent: 'cursor',
      path: dbPath,
      subId: c.id,
      mtimeMs,
      size: stamp.size + stamp.walSize,
      hint: compact({ kind: 'composer', projectPath, project: projectPath ? projectNameOf(projectPath) : undefined, title: c.title, subagent: c.isSubagent ? '1' : undefined }),
    });
  }
  return refs;
}

function compact(o: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Record<string, string>;
}

// ---------- parse: composer ----------

/** Plain text from a Lexical editor state (user bubbles keep it in `richText`, a JSON string). */
function richTextToPlain(rich: unknown): string {
  const root = jsonString(rich);
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!isObj(n)) return;
    if (typeof n.text === 'string') out.push(n.text);
    if (Array.isArray(n.children)) {
      n.children.forEach(walk);
      if (n.type === 'paragraph') out.push('\n');
    }
    if (isObj(n.root)) walk(n.root);
  };
  walk(root);
  return out.join('').trim();
}

/** Bubble time: ISO createdAt (newer bubbles), else the client timing fields in epoch ms. */
function bubbleTs(b: Obj): number | undefined {
  const created = toMs(b.createdAt);
  if (created) return created;
  const t = isObj(b.timingInfo) ? b.timingInfo : {};
  for (const k of ['clientRpcSendTime', 'clientSettleTime', 'clientEndTime', 'clientStartTime']) {
    const v = num(t[k]);
    if (v && v > 1e12) return v;
  }
  return undefined;
}

const DONE_STATUSES = new Set(['completed', 'success', 'error', 'failed', 'cancelled', 'canceled', 'rejected', 'aborted']);

function pickText(res: unknown, keys: string[]): string | undefined {
  if (!isObj(res)) return undefined;
  for (const k of keys) {
    const v = res[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

interface Pending extends OpenTool {
  approval: boolean;
  detail?: string;
}

interface TurnInfo {
  lastType?: 'user' | 'assistant';
  pending?: Pending;
  error?: { aborted: boolean; text: string };
}

/** One toolFormerData: a tool call and, once it finished, its result, in the same bubble. */
function addTool(run: ParsedRun, tf: Obj, ts: number | undefined, fallbackId: string, projectPath: string | undefined, turn: TurnInfo): boolean {
  const name = str(tf.name);
  if (!name) return false;
  const params = jsonString(tf.params ?? tf.rawArgs);
  const callId = str(tf.toolCallId) ?? fallbackId;
  const kind = cursorToolKind(name);
  const status = str(tf.status)?.toLowerCase();
  const add = isObj(tf.additionalData) ? tf.additionalData : {};
  const decision = str(tf.userDecision) ?? str(add.userDecision);
  const isError = status === 'error' || status === 'failed' || add.status === 'error';
  const cancelled = status === 'cancelled' || status === 'canceled' || status === 'aborted' || decision === 'rejected';
  // A rejected call never runs, so it gets no result: it is finished all the same.
  const finished = tf.result != null || (status !== undefined && DONE_STATUSES.has(status)) || decision === 'rejected';
  const raw = cursorFilePath(params);
  const filePath = raw ? resolveIn(projectPath, raw) : undefined;
  // A failed, cancelled or rejected edit did not change the file: keep it out of the files table.
  const counts = kind === 'edit' && !isError && !cancelled;
  pushEvent(run, {
    kind: 'tool_call',
    ts,
    text: cursorInputSummary(params),
    toolName: name,
    toolCallId: callId,
    toolKind: kind,
    filePath: kind === 'edit' && !counts ? undefined : filePath,
    fileOp: counts ? fileOpFor(name) : undefined,
  });
  if (finished) {
    const res = jsonString(tf.result);
    let text: string;
    if (cancelled) text = decision === 'rejected' ? 'Rejected by you' : 'Cancelled';
    else if (isError) {
      text =
        [pickText(res, ['error', 'message']), pickText(res, ['stderr', 'output', 'resultForModel'])].filter(Boolean).join('\n') ||
        textOf(res) ||
        'Tool failed';
    } else text = pickText(res, ['resultForModel', 'output', 'contents', 'content', 'stdout', 'text', 'message']) ?? textOf(res);
    pushEvent(run, { kind: 'tool_result', ts, text, toolName: name, toolCallId: callId, toolKind: kind, isError: isError || undefined });
    turn.pending = undefined;
  } else {
    const p = isObj(params) ? params : {};
    const approval = p.requireUserApproval === true;
    const cmd = str(p.command);
    turn.pending = {
      name,
      kind,
      since: ts ?? 0,
      approval,
      detail: approval ? (cmd ? `Waiting for your approval to run: ${cmd}` : `Waiting for your approval: ${name}`) : undefined,
    };
  }
  return true;
}

/** The error a request ended with. ERROR_USER_ABORTED_REQUEST means the user pressed stop. */
function addError(run: ParsedRun, ed: Obj, ts: number | undefined, turn: TurnInfo): void {
  const inner = jsonString(ed.error);
  const code = isObj(inner) ? str(inner.error) : str(inner);
  const title = (isObj(inner) && isObj(inner.details) ? str(inner.details.title) : undefined) ?? str(ed.message) ?? code ?? 'Request failed';
  if (code === 'ERROR_USER_ABORTED_REQUEST') {
    pushEvent(run, { kind: 'system', ts, text: `Stopped: ${title}` });
    turn.error = { aborted: true, text: title };
  } else {
    pushEvent(run, { kind: 'error', ts, text: code && code !== title ? `${title} (${code})` : title, isError: true });
    turn.error = { aborted: false, text: title };
  }
}

function bubbleRole(b: Obj): 'user' | 'assistant' | undefined {
  if (b.type === 1 || b.type === 'user') return 'user';
  if (b.type === 2 || b.type === 'ai' || b.type === 'assistant') return 'assistant';
  return undefined;
}

/** Adds one bubble's events. Returns false for a bubble shape this adapter does not know. */
function addBubble(run: ParsedRun, b: Obj, ts: number | undefined, idx: number, projectPath: string | undefined, turn: TurnInfo): boolean {
  const role = bubbleRole(b);
  if (!role) return false;
  turn.lastType = role;
  turn.error = undefined;
  if (role === 'user') {
    turn.pending = undefined;
    const text = str(b.text) ?? richTextToPlain(b.richText);
    if (text.trim()) pushEvent(run, { kind: 'user', ts, text });
    return true;
  }
  const thinking = isObj(b.thinking) ? str(b.thinking.text) : undefined;
  if (thinking) pushEvent(run, { kind: 'reasoning', ts, text: thinking });
  if (Array.isArray(b.allThinkingBlocks)) {
    for (const t of b.allThinkingBlocks) {
      const tt = isObj(t) ? str(t.text) ?? str(t.thinking) : undefined;
      if (tt && tt !== thinking) pushEvent(run, { kind: 'reasoning', ts, text: tt });
    }
  }
  const text = str(b.text) ? stripRedacted(b.text as string) : '';
  if (text) pushEvent(run, { kind: 'assistant', ts, text });
  const hasTool = isObj(b.toolFormerData) && addTool(run, b.toolFormerData, ts, `${str(b.bubbleId) ?? idx}:tool`, projectPath, turn);
  // Any later bubble that is not itself a pending tool closes the previous pending one.
  if (!hasTool && (text || thinking)) turn.pending = undefined;
  if (isObj(b.errorDetails)) addError(run, b.errorDetails, ts, turn);
  return true;
}

/** Token totals: per-bubble counts are mostly zero in real data, so fall back to context usage. */
function tokens(run: ParsedRun, cd: Obj, bubbles: Obj[]): void {
  let input = 0;
  let output = 0;
  for (const b of bubbles) {
    const tc = isObj(b.tokenCount) ? b.tokenCount : isObj(b.usage) ? { inputTokens: b.usage.input_tokens, outputTokens: b.usage.output_tokens } : {};
    input += num(tc.inputTokens) ?? 0;
    output += num(tc.outputTokens) ?? 0;
  }
  if (input || output) {
    run.inputTokens = input;
    run.outputTokens = output;
  } else if (num(cd.contextTokensUsed)) {
    run.inputTokens = cd.contextTokensUsed as number; // context in use, the best figure Cursor keeps
  }
}

function modelOf(cd: Obj, bubbles: Obj[]): string | undefined {
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const m = isObj(bubbles[i].modelInfo) ? str((bubbles[i].modelInfo as Obj).modelName) : undefined;
    if (m && m !== 'default') return m;
  }
  const m = isObj(cd.modelConfig) ? str(cd.modelConfig.modelName) : undefined;
  return m === 'default' ? 'auto' : m;
}

/** Bubbles in conversation order: headers + bubbleId rows (v3+), else the legacy inline list. */
function loadBubbles(db: Database, id: string, cd: Obj): { bubbles: Obj[]; missing: number } {
  if (Array.isArray(cd.fullConversationHeadersOnly)) {
    const st = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
    const bubbles: Obj[] = [];
    let missing = 0;
    for (const h of cd.fullConversationHeadersOnly) {
      const bid = isObj(h) ? str(h.bubbleId) : undefined;
      if (!bid) {
        missing++;
        continue;
      }
      const row = st.get(`bubbleId:${id}:${bid}`);
      const b = parseJson(row?.value ?? undefined);
      if (!isObj(b)) {
        missing++; // deleted or corrupt bubble row
        continue;
      }
      if (b.type === undefined && isObj(h)) b.type = h.type;
      bubbles.push(b);
    }
    return { bubbles, missing };
  }
  if (Array.isArray(cd.conversation)) return { bubbles: cd.conversation.filter(isObj), missing: cd.conversation.filter((x) => !isObj(x)).length };
  if (isObj(cd.conversationMap)) return { bubbles: Object.values(cd.conversationMap).filter(isObj), missing: 0 };
  return { bubbles: [], missing: 0 };
}

function setTurn(run: ParsedRun, cd: Obj, turn: TurnInfo): void {
  if (turn.error) {
    run.turn = turn.error.aborted ? 'aborted' : 'error';
    run.turnDetail = turn.error.aborted ? 'Stopped by you' : turn.error.text;
  } else if (turn.pending) {
    run.openTool = { name: turn.pending.name, kind: turn.pending.kind, since: turn.pending.since || run.lastEventAt || 0 };
    run.turn = turn.pending.approval ? 'waiting_input' : 'in_progress';
    if (turn.pending.detail) run.turnDetail = turn.pending.detail;
  } else if (turn.lastType === 'user') run.turn = 'in_progress';
  else if (turn.lastType === 'assistant') {
    // composerData.status values other than none/completed are unverified; treat "busy" words as busy.
    run.turn = /generat|stream|running|thinking/i.test(str(cd.status) ?? '') ? 'in_progress' : 'completed';
  } else run.turn = 'unknown';
}

export function buildComposerRun(db: Database, ref: SessionRef): ParsedRun {
  const id = ref.subId ?? '';
  const hint = ref.hint ?? {};
  const row = one(db, 'SELECT value FROM cursorDiskKV WHERE key = ?', [`composerData:${id}`]);
  if (!row) throw new Error('This chat is no longer in Cursor\'s database (it was deleted or cleaned up).');
  const parsed = parseJson(row.value);
  if (!isObj(parsed)) {
    const run = emptyRun(hint.project);
    run.title = hint.title ?? '';
    run.readError = "This chat's record isn't valid JSON; Cursor may have changed its format.";
    return run;
  }
  const cd = parsed;
  const wt = isObj(cd.gitWorktree) ? cd.gitWorktree : {};
  const projectPath = str(wt.worktreePath) ?? hint.projectPath;
  const run = emptyRun(projectPath ? projectNameOf(projectPath) : hint.project ?? 'Unknown project');
  run.projectPath = projectPath;
  run.gitBranch = str(wt.branchName);
  run.startedAt = toMs(cd.createdAt);
  // Cursor's own chat name first (as its sidebar shows it); pushEvent falls back to the first prompt.
  run.title = realName(cd.name) ?? hint.title ?? '';

  const { bubbles, missing } = loadBubbles(db, id, cd);
  run.skipped += missing;
  const turn: TurnInfo = {};
  let lastTs = toMs(cd.createdAt);
  let recognised = 0;
  bubbles.forEach((b, i) => {
    const ts = bubbleTs(b) ?? lastTs; // old bubbles have no time: carry the previous one forward
    lastTs = ts;
    if (addBubble(run, b, ts, i, projectPath, turn)) recognised++;
    else run.skipped++;
  });
  const updated = toMs(cd.lastUpdatedAt);
  if (updated && (!run.lastEventAt || updated > run.lastEventAt)) run.lastEventAt = updated;
  run.model = modelOf(cd, bubbles);
  tokens(run, cd, bubbles);
  setTurn(run, cd, turn);
  if (recognised === 0 && bubbles.length + missing > 0) run.readError = NO_RECORDS;
  return run;
}

// ---------- parse: legacy chat panel tab ----------

export function buildAiChatRun(db: Database, ref: SessionRef): ParsedRun {
  const hint = ref.hint ?? {};
  const run = emptyRun(hint.projectPath ? projectNameOf(hint.projectPath) : 'Unknown project');
  run.projectPath = hint.projectPath;
  const tabId = (ref.subId ?? '').replace(/^aichat:/, '');
  const chat = parseJson(one(db, "SELECT value FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'")?.value);
  const tab = isObj(chat) && Array.isArray(chat.tabs) ? chat.tabs.find((t) => isObj(t) && t.tabId === tabId) : undefined;
  if (!isObj(tab)) throw new Error('This chat is no longer in Cursor\'s database.');
  run.title = realName(tab.chatTitle) ?? realName(hint.title) ?? '';
  const ts = toMs(tab.lastSendTime);
  let recognised = 0;
  for (const b of Array.isArray(tab.bubbles) ? tab.bubbles : []) {
    const role = isObj(b) ? bubbleRole(b) : undefined;
    const text = isObj(b) ? str(b.text) ?? '' : '';
    if (!role) {
      run.skipped++;
      continue;
    }
    recognised++;
    if (text) pushEvent(run, { kind: role, ts, text });
  }
  const meta = isObj(tab.metadata) && Array.isArray(tab.metadata.modelsUsed) ? tab.metadata.modelsUsed : [];
  run.model = str(meta[meta.length - 1]);
  run.turn = recognised ? 'completed' : 'unknown';
  if (!recognised && run.skipped) run.readError = NO_RECORDS;
  return run;
}

// ---------- parse entry ----------

/** Whole-database format: re-read only when the db or its -wal changed since the last parse. */
export async function parseFromDb(
  ref: SessionRef,
  prev: ParseState | undefined,
  ctx: ParseContext,
  build: (db: Database, ref: SessionRef) => ParsedRun,
): Promise<ParseState> {
  const stamp = await dbStamp(ref.path);
  if (prev && prev.extra.stamp === stamp.key) return prev;
  const snap = await openSnapshot(ref.path, ctx.tempDir);
  const st = freshState();
  st.run = build(snap.db, ref); // synchronous use of the snapshot (see openSnapshot)
  st.size = snap.stamp.size + snap.stamp.walSize;
  st.mtimeMs = ref.mtimeMs;
  st.extra = { stamp: snap.stamp.key };
  return st;
}
