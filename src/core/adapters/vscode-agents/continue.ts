// Continue (VS Code / JetBrains extension and the `cn` CLI): ~/.continue/sessions/<uuid>.json,
// one whole-file JSON Session per chat, plus a sessions.json list.
//
// Provenance (research/vscode-agents.md, 2026-10-27): checked against continuedev/continue @
// 5522c6f (extension 1.3.40; the repo is now archived): core/index.d.ts (Session, ChatMessage,
// ToolCallState), core/util/history.ts, gui/src/redux/thunks/callToolById.ts [source].
// Continue is not installed on the development machine, so no real session was seen.
//
// Quirks:
// - Session files carry no timestamps at all. Start time comes from sessions.json `dateCreated`
//   (a ms number stored as a string); everything else falls back to the file's mtime.
// - Files are rewritten non-atomically after each successful stream; a failed stream is not
//   saved, so errors usually leave no trace.
// - workspaceDirectory is a VS Code URI (file:///c%3A/...) from the extension, a plain path from the CLI.
// - Tool approval state lives in history[].toolCallStates[].status: `generated` = awaiting approval.

import type { ParsedRun, ParseState, SessionRef, TurnState } from '../../adapter';
import { emptyRun } from '../../adapter';
import { baseName, makeTitle, pushEvent, toMs, toolInputSummary } from '../../events';
import { blockText, fileOpOf, isObj, kindOf, num, readTranscript, str, UNRECOGNISED, unchanged, uriToPath, type Obj } from './common';

const DEFAULT_TITLES = new Set(['New Session', 'Untitled Session']);
const EDIT_TOOLS = /^(edit_existing_file|single_find_and_replace|multi_edit|create_new_file)$/;

export async function parseContinue(ref: SessionRef, prev: ParseState | undefined): Promise<ParseState> {
  if (unchanged(ref, prev)) return prev!;
  let doc: unknown;
  try {
    doc = (await readTranscript(ref.path)).value;
  } catch (e) {
    if (prev && !prev.run.readError) return prev; // caught mid-rewrite: retry later
    throw e;
  }
  const hint = ref.hint ?? {};
  const s = isObj(doc) ? doc : undefined;
  const ws = str(s?.workspaceDirectory);
  const projectPath = ws ? uriToPath(ws) : hint.projectPath;
  const run = emptyRun(baseName(projectPath) || 'Unknown project');
  if (projectPath) run.projectPath = projectPath;
  const st: ParseState = { offset: 0, size: ref.size, mtimeMs: ref.mtimeMs, run, extra: {} };
  const created = toMs(Number(hint.dateCreated));
  if (created) run.startedAt = created;

  const history = s && Array.isArray(s.history) ? s.history : undefined;
  if (!history) {
    run.readError = UNRECOGNISED;
    return st;
  }
  const title = str(s?.title) ?? hint.title;
  if (title && !DEFAULT_TITLES.has(title)) run.title = makeTitle(title);

  const items = history.filter(isObj);
  run.skipped += history.length - items.length;
  const recognised = walk(run, items);
  if (history.length > 0 && recognised === 0) run.readError = UNRECOGNISED;

  run.model = str(s?.chatModelTitle) ?? promptLogModel(items);
  usage(run, s!, items);
  setTurn(run, items, ref.mtimeMs);
  return st;
}

function walk(run: ParsedRun, items: Obj[]): number {
  const states = new Map<string, Obj>();
  for (const h of items) for (const t of toolStates(h)) if (typeof t.toolCallId === 'string') states.set(t.toolCallId, t);
  let recognised = 0;
  for (const h of items) {
    const m = isObj(h.message) ? h.message : undefined;
    if (!m) {
      run.skipped++;
      continue;
    }
    // Reasoning the GUI collected separately from the message (startAt/endAt are the only times saved).
    const r = isObj(h.reasoning) ? h.reasoning : undefined;
    const ts = toMs(r?.startAt);
    if (r && typeof r.text === 'string' && r.text.trim()) pushEvent(run, { kind: 'reasoning', text: r.text, ts });
    if (message(run, m, states, ts)) recognised++;
    else run.skipped++;
  }
  return recognised;
}

function message(run: ParsedRun, m: Obj, states: Map<string, Obj>, ts: number | undefined): boolean {
  const text = blockText(m.content);
  switch (m.role) {
    case 'user':
      if (text.trim()) pushEvent(run, { kind: 'user', text, ts });
      return true;
    case 'thinking':
      if (text.trim()) pushEvent(run, { kind: 'reasoning', text, ts });
      else if (m.redactedThinking) pushEvent(run, { kind: 'reasoning', text: '(reasoning hidden by the provider)', ts });
      return true;
    case 'system':
      if (text.trim()) pushEvent(run, { kind: 'system', text, ts });
      return true;
    case 'assistant':
      if (text.trim()) pushEvent(run, { kind: 'assistant', text, ts });
      for (const c of Array.isArray(m.toolCalls) ? m.toolCalls.filter(isObj) : []) toolCall(run, c, states, ts);
      return true;
    case 'tool': {
      const id = str(m.toolCallId);
      const state = id ? states.get(id) : undefined;
      const name = toolName(state);
      pushEvent(run, { kind: 'tool_result', text, ts, toolCallId: id, toolName: name, toolKind: kindOf(name), isError: state?.status === 'errored' });
      return true;
    }
    default:
      return false;
  }
}

function toolCall(run: ParsedRun, c: Obj, states: Map<string, Obj>, ts: number | undefined): void {
  const id = str(c.id);
  const fn = isObj(c.function) ? c.function : {};
  const name = str(fn.name) ?? 'tool';
  const state = id ? states.get(id) : undefined;
  const args = isObj(state?.parsedArgs) ? state!.parsedArgs : parseArgs(fn.arguments);
  const kind = kindOf(name);
  const failed = state?.status === 'errored' || state?.status === 'canceled';
  const path = EDIT_TOOLS.test(name) && !failed ? str(isObj(args) ? args.filepath : undefined) : undefined;
  pushEvent(run, {
    kind: 'tool_call',
    text: argSummary(args ?? fn.arguments),
    ts,
    toolName: name,
    toolCallId: id,
    toolKind: kind,
    ...(path ? { filePath: path, fileOp: fileOpOf(name) } : {}),
  });
}

/** Continue's built-in tools name their arguments filepath, dirPath, command, query, pattern, url. */
function argSummary(args: unknown): string {
  if (isObj(args)) {
    for (const k of ['filepath', 'dirPath', 'command', 'query', 'pattern', 'url']) {
      const v = str(args[k]);
      if (v) return v;
    }
  }
  return toolInputSummary(args);
}

function parseArgs(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function toolStates(h: Obj): Obj[] {
  return Array.isArray(h.toolCallStates) ? h.toolCallStates.filter(isObj) : [];
}

function toolName(state: Obj | undefined): string | undefined {
  const call = isObj(state?.toolCall) ? state!.toolCall : undefined;
  const fn = isObj(call?.function) ? call!.function : undefined;
  return str(fn?.name);
}

function promptLogModel(items: Obj[]): string | undefined {
  for (const h of items) {
    const logs = Array.isArray(h.promptLogs) ? h.promptLogs.filter(isObj) : [];
    for (const l of logs) if (str(l.modelTitle)) return String(l.modelTitle);
  }
  return undefined;
}

function usage(run: ParsedRun, s: Obj, items: Obj[]): void {
  const u = isObj(s.usage) ? s.usage : undefined;
  if (u && (num(u.promptTokens) != null || num(u.completionTokens) != null)) {
    run.inputTokens = num(u.promptTokens) ?? 0;
    run.outputTokens = num(u.completionTokens) ?? 0;
    return;
  }
  let tin = 0;
  let tout = 0;
  let saw = false;
  for (const h of items) {
    const mu = isObj(h.message) && isObj(h.message.usage) ? h.message.usage : undefined;
    if (!mu) continue;
    saw = true;
    tin += num(mu.promptTokens) ?? 0;
    tout += num(mu.completionTokens) ?? 0;
  }
  if (saw) {
    run.inputTokens = tin;
    run.outputTokens = tout;
  }
}

// ---------------------------------------------------------------- turn state

/** Continue keeps no status; judge from the last history item [research §4.4]. */
function setTurn(run: ParsedRun, items: Obj[], mtimeMs: number): void {
  const last = items[items.length - 1];
  const m = last && isObj(last.message) ? last.message : undefined;
  let turn: TurnState = 'unknown';
  if (m?.role === 'assistant') {
    const states = toolStates(last);
    const pending = states.find((t) => t.status === 'generated');
    const busy = states.find((t) => t.status === 'calling' || t.status === 'generating');
    const errored = states.find((t) => t.status === 'errored');
    const canceled = states.find((t) => t.status === 'canceled');
    if (pending) {
      turn = 'waiting_input';
      run.turnDetail = `Waiting for approval to run ${toolName(pending) ?? 'a tool'}${argHint(pending)}`;
      run.openTool = { name: toolName(pending) ?? 'tool', kind: kindOf(toolName(pending)), since: mtimeMs };
    } else if (busy) {
      turn = 'in_progress';
      run.openTool = { name: toolName(busy) ?? 'tool', kind: kindOf(toolName(busy)), since: mtimeMs };
    } else if (errored) {
      turn = 'error';
      run.turnDetail = `${toolName(errored) ?? 'A tool'} failed`;
    } else if (canceled) {
      // The user rejected (or stopped) the call and nothing followed: the turn ended there.
      turn = 'aborted';
      run.turnDetail = `${toolName(canceled) ?? 'A tool call'} was cancelled`;
    } else if (states.length || (Array.isArray(m.toolCalls) && m.toolCalls.length)) {
      turn = 'in_progress'; // tools ran; the model has not answered yet
    } else {
      turn = 'completed';
    }
  } else if (m?.role === 'user' || m?.role === 'tool' || m?.role === 'thinking') {
    turn = 'in_progress';
  }
  run.turn = turn;
}

function argHint(state: Obj): string {
  const a = isObj(state.parsedArgs) ? state.parsedArgs : undefined;
  const v = str(a?.command) ?? str(a?.filepath);
  return v ? `: ${v.length > 120 ? `${v.slice(0, 117)}…` : v}` : '';
}
