// Gemini CLI session logs. Since 2026-04 (PR #23749) a session is a JSONL file of snapshots and
// patches, not a plain event log: message objects are re-appended in full whenever they change
// (last write wins, first position kept), `$rewindTo` drops a message and everything after it,
// `$patch` rewrites content / tool results / order, and `$set` updates metadata. So we REDUCE
// the log to the current message list (kept between parses as plain data) and rebuild the run
// from it. The older single-JSON `session-*.json` ({..., messages: []}) reduces the same way,
// as does legacy Qwen Code (assistant messages typed "qwen" instead of "gemini").
// Provenance: google-gemini/gemini-cli source (chatRecordingService.ts, chatRecordingTypes.ts),
// read by the research pass; not checked against a real installation.

import type { ParsedRun, SessionRef } from '../../adapter';
import { emptyRun } from '../../adapter';
import { baseName, isObj, makeTitle, pushEvent, toolFilePath, toolInputSummary, toMs } from '../../events';
import { addUsageSince } from '../../usage';
import {
  fileDiffOf,
  geminiUsage,
  noteFileChange,
  isMetaPrompt,
  isQuestionTool,
  kindOf,
  opForTool,
  partsOf,
  partsText,
  responseOf,
  resultText,
  slim,
  str,
  thoughtTexts,
  type Part,
} from './common';

type Msg = Record<string, unknown> & { id: string };

/** The reduced session, carried between parses in ParseState.extra (plain data only). */
export interface GeminiState {
  meta: Record<string, unknown>;
  /** Message ids in display order. */
  order: string[];
  byId: Record<string, Msg>;
  /** Records the reducer did not recognise. */
  skipped: number;
  recognised: number;
}

export function newGeminiState(): GeminiState {
  return { meta: {}, order: [], byId: {}, skipped: 0, recognised: 0 };
}

/** Applies one JSONL record. Type guards in the CLI's own order (chatRecordingService.ts). */
export function applyGeminiRecord(st: GeminiState, r: unknown): void {
  if (!isObj(r)) {
    st.skipped++;
    return;
  }
  if (typeof r.$rewindTo === 'string') rewindTo(st, r.$rewindTo);
  else if (isObj(r.$patch)) applyPatch(st, r.$patch);
  else if (typeof r.id === 'string') upsert(st, slim(r) as Msg);
  else if (isObj(r.$set)) applySet(st, r.$set);
  else if (typeof r.sessionId === 'string' && typeof r.projectHash === 'string') Object.assign(st.meta, slim(r));
  else {
    st.skipped++;
    return;
  }
  st.recognised++;
}

/** Loads a legacy whole-file session (`session-*.json`). */
export function loadLegacyDocument(doc: unknown): GeminiState {
  const st = newGeminiState();
  if (!isObj(doc) || !Array.isArray(doc.messages)) {
    st.skipped++;
    return st;
  }
  const { messages, ...meta } = doc;
  st.meta = slim(meta) as Record<string, unknown>;
  st.recognised++;
  for (const m of messages as unknown[]) {
    if (isObj(m) && typeof m.id === 'string') upsert(st, slim(m) as Msg);
    else st.skipped++;
  }
  return st;
}

function upsert(st: GeminiState, m: Msg): void {
  if (m.id === '__proto__') return; // never a real id; assigning it would replace byId's prototype
  if (!Object.hasOwn(st.byId, m.id)) st.order.push(m.id);
  st.byId[m.id] = m;
}

function rewindTo(st: GeminiState, id: string): void {
  const i = st.order.indexOf(id);
  // The CLI drops everything when the id is unknown.
  const cut = i < 0 ? 0 : i;
  for (const gone of st.order.slice(cut)) delete st.byId[gone];
  st.order.length = cut;
}

function applyPatch(st: GeminiState, p: Record<string, unknown>): void {
  const updates = [p, ...(Array.isArray(p.updates) ? p.updates : [])];
  for (const u of updates) {
    if (!isObj(u) || typeof u.id !== 'string') continue;
    const m = Object.hasOwn(st.byId, u.id) ? st.byId[u.id] : undefined;
    if (!m) continue;
    if (u.content !== undefined) m.content = slim(u.content);
    if (Array.isArray(u.toolCalls) && Array.isArray(m.toolCalls)) {
      for (const tp of u.toolCalls) {
        if (!isObj(tp)) continue;
        const i = (m.toolCalls as unknown[]).findIndex((tc) => isObj(tc) && tc.id === tp.id);
        if (i >= 0) (m.toolCalls as unknown[])[i] = { ...(m.toolCalls as Record<string, unknown>[])[i], ...(slim(tp) as object) };
      }
    }
  }
  if (Array.isArray(p.removeIds)) {
    const drop = new Set(p.removeIds.filter((x): x is string => typeof x === 'string'));
    for (const id of drop) delete st.byId[id];
    st.order = st.order.filter((id) => !drop.has(id));
  }
  if (Array.isArray(p.orderIds)) {
    // Ids in orderIds move to the end, in that order.
    const tail = p.orderIds.filter((x): x is string => typeof x === 'string' && Object.hasOwn(st.byId, x));
    const set = new Set(tail);
    st.order = [...st.order.filter((id) => !set.has(id)), ...tail];
  }
}

function applySet(st: GeminiState, set: Record<string, unknown>): void {
  const { messages, ...rest } = set;
  if (Array.isArray(messages)) {
    // Deprecated full checkpoint: replaces the whole message list.
    st.order = [];
    st.byId = {};
    for (const m of messages) if (isObj(m) && typeof m.id === 'string') upsert(st, slim(m) as Msg);
  }
  Object.assign(st.meta, slim(rest));
}

interface OpenCall {
  name: string;
  since: number;
}

/** Rebuilds the run from the reduced state. */
export function buildGeminiRun(st: GeminiState, ref: SessionRef): ParsedRun {
  const run = emptyRun(ref.hint?.project || 'Unknown project');
  const msgs = st.order.filter((id) => Object.hasOwn(st.byId, id)).map((id) => st.byId[id]);
  setProject(run, st, ref);

  // Tool results live on the model message (toolCalls[].result); the user-role functionResponse
  // messages that follow duplicate them and are used only when the toolCalls entry is missing.
  const answered = new Set<string>();
  for (const m of msgs) for (const tc of toolCallsOf(m)) if (typeof tc.id === 'string') answered.add(tc.id);
  const open = new Map<string, OpenCall>();
  let unknownTypes = 0;

  for (const m of msgs) {
    const ts = toMs(m.timestamp);
    switch (m.type) {
      case 'user':
        mapUser(run, m, ts, answered, open);
        break;
      case 'gemini':
      case 'qwen':
        mapModel(run, m, ts, answered, open);
        break;
      case 'error':
        pushEvent(run, { kind: 'error', text: partsText(m.content, '\n') || 'Error', ts, isError: true });
        break;
      case 'info':
      case 'warning':
        pushEvent(run, { kind: 'system', text: partsText(m.content, '\n'), ts });
        break;
      default:
        unknownTypes++;
    }
  }

  run.skipped = st.skipped + unknownTypes;
  setTurn(run, msgs, open);
  setTotals(run, st, msgs);
  if (!run.title) run.title = makeTitle(str(st.meta.summary) ?? '');
  return run;
}

function setProject(run: ParsedRun, st: GeminiState, ref: SessionRef): void {
  const dirs = st.meta.directories;
  const fromDirs = Array.isArray(dirs) && typeof dirs[0] === 'string' ? dirs[0] : undefined;
  // Gemini records carry no cwd: the project folder comes from tmp/<slug>/.project_root
  // (found by discover), else from the subagent `directories` list.
  run.projectPath = ref.hint?.projectPath || fromDirs;
  if (run.projectPath) run.projectName = baseName(run.projectPath);
}

function toolCallsOf(m: Msg): Record<string, unknown>[] {
  return Array.isArray(m.toolCalls) ? m.toolCalls.filter(isObj) : [];
}

function mapUser(run: ParsedRun, m: Msg, ts: number | undefined, answered: Set<string>, open: Map<string, OpenCall>): void {
  const parts = partsOf(m.content);
  const responses = parts.filter((p) => isObj(p.functionResponse));
  if (responses.length && responses.length === parts.length) {
    for (const p of responses) {
      const fr = p.functionResponse as Record<string, unknown>;
      const id = str(fr.id);
      if (id && answered.has(id)) continue;
      const res = responseOf(fr);
      pushEvent(run, { kind: 'tool_result', text: res.text, ts, toolName: str(fr.name), toolCallId: id, toolKind: kindOf(str(fr.name)), isError: res.isError });
      if (id) open.delete(id);
    }
    return;
  }
  const text = partsText(m.displayContent ?? m.content, '\n');
  if (!text.trim()) return;
  const meta = isMetaPrompt(text);
  // A new prompt means calls left without a response (masked, removed, or the CLI died) are over.
  if (!meta) open.clear();
  pushEvent(run, { kind: meta ? 'system' : 'user', text, ts });
}

function mapModel(run: ParsedRun, m: Msg, ts: number | undefined, answered: Set<string>, open: Map<string, OpenCall>): void {
  // The model speaks again only after every call of its previous message was answered, so calls
  // from earlier messages that still look open lost their response record (masking, compression).
  open.clear();
  const mark = run.tally.events;
  if (Array.isArray(m.thoughts)) {
    for (const th of m.thoughts) {
      if (!isObj(th)) continue;
      const text = [str(th.subject), str(th.description)].filter(Boolean).join(': ');
      if (text) pushEvent(run, { kind: 'reasoning', text, ts: toMs(th.timestamp) ?? ts });
    }
  }
  for (const t of thoughtTexts(m.content)) pushEvent(run, { kind: 'reasoning', text: t, ts });
  const text = partsText(m.content);
  if (text.trim()) pushEvent(run, { kind: 'assistant', text, ts });

  const calls = toolCallsOf(m);
  const recorded = new Set(calls.map((c) => c.id));
  // functionCall parts appear in content only after a history sync; pair them by id.
  for (const p of partsOf(m.content)) {
    if (!isObj(p.functionCall)) continue;
    const fc = p.functionCall as Part;
    const id = str(fc.id);
    if (id && recorded.has(id)) continue;
    const name = str(fc.name) ?? 'tool';
    pushToolCall(run, name, id, fc.args, ts);
    if (!id || !answered.has(id)) open.set(id ?? `${name}@${ts}`, { name, since: ts ?? 0 });
  }
  for (const tc of calls) mapToolCall(run, tc, ts);
  if (isObj(m.tokens)) addUsageSince(run, mark, geminiUsage(m.tokens.input, m.tokens.cached, m.tokens.output, m.tokens.thoughts, m.tokens.tool), ts);
}

function pushToolCall(run: ParsedRun, name: string, id: string | undefined, args: unknown, ts: number | undefined): void {
  const kind = kindOf(name);
  // Edit tools get their file_change from the result, so a failed edit counts no file.
  const filePath = kind === 'edit' ? undefined : toolFilePath(args);
  pushEvent(run, { kind: 'tool_call', text: toolInputSummary(args), ts, toolName: name, toolCallId: id, toolKind: kind, filePath });
}

function mapToolCall(run: ParsedRun, tc: Record<string, unknown>, ts: number | undefined): void {
  const name = str(tc.name) ?? 'tool';
  const id = str(tc.id);
  const kind = kindOf(name);
  pushToolCall(run, name, id, tc.args, ts);
  // Only completed calls are recorded; tc.timestamp is the completion time.
  const doneAt = toMs(tc.timestamp) ?? ts;
  const fr = partsOf(tc.result).find((p) => isObj(p.functionResponse))?.functionResponse;
  const res = responseOf(fr);
  const status = str(tc.status);
  const isError = status === 'error' || res.isError;
  let text = resultText(tc.resultDisplay, res);
  if (!text && status === 'cancelled') text = 'Cancelled';
  pushEvent(run, { kind: 'tool_result', text, ts: doneAt, toolName: name, toolCallId: id, toolKind: kind, isError });
  if (kind === 'edit' && status === 'success' && !isError) {
    const diff = fileDiffOf(tc.resultDisplay);
    const filePath = diff?.filePath ?? toolFilePath(tc.args);
    if (filePath) {
      const fileOp = diff?.fileOp ?? opForTool(name);
      pushEvent(run, { kind: 'file_change', text: diff?.diff ?? `${fileOp} ${filePath}`, ts: doneAt, toolName: name, toolCallId: id, filePath, fileOp });
      noteFileChange(run, diff, filePath, fileOp, doneAt, id);
    }
  }
}

/**
 * Gemini writes no "turn finished" or pid record, so the turn is read from the last message:
 * error -> error; "Request cancelled" info -> aborted; a user message -> the model is working;
 * a model message with text -> finished; a model message with empty text and no toolCalls ->
 * a tool is executing or awaiting approval (toolCalls are written only when tools complete).
 * Known blind spot: a model message WITH text whose tool calls are still running looks exactly
 * like a finished answer (the functionCall parts are not recorded), so it reads 'completed'
 * until the toolCalls re-append lands.
 */
function setTurn(run: ParsedRun, msgs: Msg[], open: Map<string, OpenCall>): void {
  const newestOpen = [...open.values()].at(-1);
  if (newestOpen) run.openTool = { name: newestOpen.name, kind: kindOf(newestOpen.name), since: newestOpen.since };

  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const text = partsText(m.content, '\n');
    if (m.type === 'info' || m.type === 'warning') {
      if (/request cancelled|cancelled by user|operation cancelled/i.test(text)) return void setAborted(run, text);
      continue;
    }
    if (m.type === 'error') {
      run.turn = 'error';
      run.turnDetail = text.replace(/^\[|\]$/g, '').trim() || 'API error';
      return;
    }
    if (m.type === 'user') {
      if (allCancelled(m, msgs)) return void setAborted(run, 'Tool call cancelled');
      run.turn = 'in_progress';
      return;
    }
    if (m.type === 'gemini' || m.type === 'qwen') return void setModelTurn(run, m, open);
  }
  run.turn = 'unknown';
}

/**
 * A trailing tool-response message whose calls were all cancelled: the CLI puts the cancelled
 * responses into history but does not send them to the model, so the turn is over.
 */
function allCancelled(m: Msg, msgs: Msg[]): boolean {
  const parts = partsOf(m.content);
  if (!parts.length || !parts.every((p) => isObj(p.functionResponse))) return false;
  const status = new Map<string, unknown>();
  for (const x of msgs) for (const tc of toolCallsOf(x)) if (typeof tc.id === 'string') status.set(tc.id, tc.status);
  return parts.every((p) => {
    const id = str((p.functionResponse as Part).id);
    return !!id && status.get(id) === 'cancelled';
  });
}

function setAborted(run: ParsedRun, text: string): void {
  run.turn = 'aborted';
  run.turnDetail = text.trim() || 'Cancelled';
  run.openTool = undefined;
}

function setModelTurn(run: ParsedRun, m: Msg, open: Map<string, OpenCall>): void {
  const calls = toolCallsOf(m);
  if (open.size) {
    run.turn = run.openTool && isQuestionTool(run.openTool.name) ? 'waiting_input' : 'in_progress';
    if (run.turn === 'waiting_input') run.turnDetail = 'Waiting for your answer';
    return;
  }
  if (calls.length) {
    if (calls.some((c) => c.status === 'cancelled')) return void setAborted(run, 'Tool call cancelled');
    run.turn = 'in_progress'; // tools done; the follow-up request to the model is in flight
    return;
  }
  if (partsText(m.content).trim()) {
    run.turn = 'completed';
    return;
  }
  run.turn = 'in_progress';
  run.openTool = { name: 'a tool', kind: 'other', since: toMs(m.timestamp) ?? 0 };
  run.turnDetail = 'Running a tool or waiting for approval';
}

function setTotals(run: ParsedRun, st: GeminiState, msgs: Msg[]): void {
  // Tokens are added per message in mapModel.
  for (const m of msgs) {
    if (m.type !== 'gemini' && m.type !== 'qwen') continue;
    if (str(m.model)) run.model = m.model as string;
  }
  const start = toMs(st.meta.startTime);
  if (start && (!run.startedAt || start < run.startedAt)) run.startedAt = start;
  const last = toMs(st.meta.lastUpdated);
  if (last && (!run.lastEventAt || last > run.lastEventAt)) run.lastEventAt = last;
}
