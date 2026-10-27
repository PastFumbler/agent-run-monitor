// Cline (up to 3.89) and Roo Code task folders: tasks/<id>/ui_messages.json plus
// api_conversation_history.json, task_metadata.json and (Roo >= 3.49) history_item.json.
//
// Provenance (research/vscode-agents.md, 2026-10-27): neither extension is installed on the
// development machine, so nothing here was seen in a real installation. The record shapes were
// checked against source: cline/cline tag v3.89.2 (ExtensionMessage.ts, HistoryItem.ts, disk.ts)
// and RooCodeInc/Roo-Code @ b867ec9 (packages/types message.ts, history.ts) [source].
//
// Format quirks:
// - Both files are whole-file JSON, rewritten after every message (including streaming `partial`
//   updates), so they are re-read when size or mtime changes; nothing is appended.
// - ui_messages.json is the timeline: every record has `ts` and is `say` (a statement) or `ask`
//   (the agent stopped for the user: approval, a question, retry after a failure).
// - In Roo the first `say:"text"` is the user's task; Cline uses `say:"task"`.
// - UI tool records carry no tool-call id. They are matched to the tool_use blocks of the API
//   history in order (and by conversationHistoryIndex when Cline records it), which supplies the
//   id, the result and the error flag. Calls that never reached the UI (validation failures) are
//   emitted from the API history where they fall.
// - `text` is often JSON in a string (tool, api_req_started, followup, use_mcp_server).

import { dirname, join } from 'node:path';
import type { FileOp, ToolKind } from '@shared/schema';
import { emptyRun, type OpenTool, type ParsedRun, type ParseState, type SessionRef, type TurnState } from '../../adapter';
import { baseName, clip, makeTitle, pushEvent, toMs, toolFilePath, toolInputSummary } from '../../events';
import { emptyIndex, indexApiHistory, type ApiIndex, type ApiTool } from './api-history';
import {
  fileOpOf,
  fingerprint,
  isObj,
  kindOf,
  num,
  parseJsonText,
  readJsonQuiet,
  readTranscript,
  str,
  UNRECOGNISED,
  unchanged,
  type Obj,
} from './common';

type TaskAgent = 'cline' | 'roo-code';

/** API tools whose ui counterpart is a message, not a tool card; matched silently. */
const SILENT = /^(attempt_completion|ask_followup_question|ask_question|plan_mode_respond|act_mode_respond|condense|summarize_task|report_bug)$/;
const UI_EDITS = /^(editedExistingFile|appliedDiff|newFileCreated|fileDeleted)$/;

const ERROR_SAYS = new Set(['error', 'diff_error', 'clineignore_error', 'rooignore_error', 'command_permission_denied', 'condense_context_error']);
const QUIET_SAYS = new Set(['checkpoint_created', 'checkpoint_saved', 'checkpoint_restored', 'api_req_finished', 'deleted_api_reqs']);
const SYSTEM_SAYS = new Set([
  'api_req_retried',
  'error_retry',
  'api_req_retry_delayed',
  'api_req_rate_limit_wait',
  'shell_integration_warning',
  'shell_integration_warning_with_suggestion',
  'info',
  'task_progress',
  'hook',
  'hook_status',
  'hook_output',
  'subagent',
  'subagent_status',
  'subagent_usage',
  'condense_context',
  'sliding_window_truncation',
  'user_edit_todos',
  'load_mcp_documentation',
  'generate_explanation',
  'codebase_search_result',
  'subtask_result',
  'mcp_notification',
  'too_many_tools_warning',
  'image',
  'text_with_images',
]);
/** Asks that block on the user (approval or an answer). Roo marks answered ones `isAnswered`. */
const BLOCKING_ASKS = new Set([
  'tool',
  'command',
  'use_mcp_server',
  'browser_action_launch',
  'followup',
  'plan_mode_respond',
  'act_mode_respond',
  'new_task',
  'condense',
  'summarize_task',
  'report_bug',
  'use_subagents',
]);
/** Roo asks that never get `isAnswered`, even once approved. */
const ROO_UNMARKED_ASKS = new Set(['command', 'use_mcp_server', 'browser_action_launch']);
const SYSTEM_ASKS = new Set(['resume_task', 'resume_completed_task', 'auto_approval_max_req_reached', 'new_task', 'condense', 'summarize_task', 'report_bug', 'use_subagents']);

interface Pending {
  id: string;
  name: string;
  kind: ToolKind;
  /** The result was already emitted (from the API history or an earlier output record). */
  closed: boolean;
  /** Matched to an API tool_use: ui output records are then only progress. */
  fromApi: boolean;
}

class TaskWalker {
  readonly run: ParsedRun;
  recognised = 0;
  private open: (OpenTool & { id: string }) | undefined;
  private lastCommand: Pending | undefined;
  private lastMcp: Pending | undefined;
  private lastBrowser: Pending | undefined;
  private userSeen = false;
  private tokensIn = 0;
  private tokensOut = 0;
  private sawUsage = false;
  model: string | undefined;
  /** Every API tool before this index is consumed (keeps pairing linear on long tasks). */
  private low = 0;
  /** API tools with a result timestamp, oldest result first, and how far flushAnsweredBefore got. */
  private readonly byDone: { t: ApiTool; done: number }[];
  private donePtr = 0;

  constructor(
    private readonly agent: TaskAgent,
    private readonly api: ApiIndex,
    projectName: string,
  ) {
    this.run = emptyRun(projectName);
    this.byDone = api.tools
      .map((t) => ({ t, done: api.results.get(t.id)?.ts }))
      .filter((x): x is { t: ApiTool; done: number } => x.done != null)
      .sort((a, b) => a.done - b.done);
  }

  walk(records: Obj[]): void {
    records.forEach((m, i) => this.record(m, i === records.length - 1));
    this.flushApiTools(this.api.tools.length);
    if (this.sawUsage) {
      this.run.inputTokens = this.tokensIn;
      this.run.outputTokens = this.tokensOut;
    }
    if (this.open) this.run.openTool = { name: this.open.name, kind: this.open.kind, since: this.open.since };
  }

  // ------------------------------------------------------------ one ui record

  private record(m: Obj, isLast: boolean): void {
    const ts = toMs(m.ts);
    if (ts) this.flushAnsweredBefore(ts);
    const mi = isObj(m.modelInfo) ? m.modelInfo : undefined;
    if (mi && str(mi.modelId)) this.model = String(mi.modelId);
    const type = m.type;
    const sub = type === 'say' ? m.say : type === 'ask' ? m.ask : undefined;
    if (typeof sub !== 'string') {
      this.run.skipped++;
      return;
    }
    // A partial record that is not the newest was cut off mid-stream; tool cards like that never ran.
    const stale = m.partial === true && !isLast;
    const handled = type === 'say' ? this.say(sub, m, ts, stale) : this.ask(sub, m, ts, stale);
    if (handled) this.recognised++;
    else this.run.skipped++;
  }

  private say(say: string, m: Obj, ts: number | undefined, stale: boolean): boolean {
    const text = typeof m.text === 'string' ? m.text : '';
    switch (say) {
      case 'task':
        this.user(text, ts);
        return true;
      case 'text':
        if (this.agent === 'roo-code' && !this.userSeen) this.user(text, ts);
        else {
          this.reasoningField(m, ts);
          if (text.trim()) pushEvent(this.run, { kind: 'assistant', text, ts });
        }
        return true;
      case 'user_feedback':
      case 'user_feedback_diff':
        this.user(say === 'user_feedback_diff' ? feedbackDiffText(text) : text, ts);
        return true;
      case 'reasoning': {
        const r = text || (typeof m.reasoning === 'string' ? m.reasoning : '');
        if (r.trim()) pushEvent(this.run, { kind: 'reasoning', text: r, ts });
        return true;
      }
      case 'completion_result':
        this.matchApi('completion');
        this.open = undefined;
        pushEvent(this.run, { kind: 'assistant', text: text.replace(/HAS_CHANGES\s*$/, '').trim(), ts });
        return true;
      case 'api_req_started':
        this.apiRequest(text, ts);
        return true;
      case 'tool':
        if (!stale) this.toolCard(text, ts, m);
        return true;
      case 'command':
        if (!stale) this.command(text, ts, m);
        return true;
      case 'command_output':
        this.output(this.lastCommand, text, ts);
        return true;
      case 'use_mcp_server':
      case 'mcp_server_request_started':
        if (!stale) this.mcp(text, ts, m);
        return true;
      case 'mcp_server_response':
        this.output(this.lastMcp, text, ts);
        return true;
      case 'browser_action':
      case 'browser_action_launch':
        if (!stale) this.browser(text, ts, m);
        return true;
      case 'browser_action_result':
        this.output(this.lastBrowser, text, ts);
        return true;
      default:
        break;
    }
    if (ERROR_SAYS.has(say)) {
      if (say === 'diff_error') this.failedEdit(text, ts);
      pushEvent(this.run, { kind: 'error', text: errorText(say, text), ts, isError: true });
      return true;
    }
    if (QUIET_SAYS.has(say)) return true;
    if (SYSTEM_SAYS.has(say)) {
      pushEvent(this.run, { kind: 'system', text: systemText(say, text), ts });
      return true;
    }
    return false;
  }

  private ask(ask: string, m: Obj, ts: number | undefined, stale: boolean): boolean {
    const text = typeof m.text === 'string' ? m.text : '';
    switch (ask) {
      case 'tool':
        if (!stale) this.toolCard(text, ts, m);
        return true;
      case 'command':
        if (!stale) this.command(text, ts, m);
        return true;
      case 'command_output':
        this.output(this.lastCommand, text, ts);
        return true;
      case 'use_mcp_server':
        if (!stale) this.mcp(text, ts, m);
        return true;
      case 'browser_action_launch':
        if (!stale) this.browser(text, ts, m);
        return true;
      case 'followup':
      case 'plan_mode_respond':
      case 'act_mode_respond': {
        this.matchApi(ask);
        const j = parseJsonText(text);
        const q = str(j?.question) ?? str(j?.response) ?? text;
        if (q.trim() && !stale) pushEvent(this.run, { kind: 'assistant', text: q, ts });
        return true;
      }
      case 'completion_result':
        // The turn-end marker; its text is empty unless the agent attached a command.
        if (text.trim()) pushEvent(this.run, { kind: 'assistant', text, ts });
        return true;
      case 'api_req_failed':
        pushEvent(this.run, { kind: 'error', text: text || 'The API request failed', ts, isError: true });
        return true;
      case 'mistake_limit_reached':
        pushEvent(this.run, { kind: 'error', text: text || 'The agent stopped after repeated mistakes', ts, isError: true });
        return true;
      default:
        break;
    }
    if (SYSTEM_ASKS.has(ask)) {
      pushEvent(this.run, { kind: 'system', text: systemText(ask, text), ts });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ helpers per record kind

  private user(text: string, ts: number | undefined): void {
    this.userSeen = true;
    this.open = undefined;
    if (text.trim()) pushEvent(this.run, { kind: 'user', text, ts });
  }

  /** Older records keep the model's reasoning in a `reasoning` field of the text record. */
  private reasoningField(m: Obj, ts: number | undefined): void {
    if (typeof m.reasoning === 'string' && m.reasoning.trim()) pushEvent(this.run, { kind: 'reasoning', text: m.reasoning, ts });
  }

  /** `api_req_started` text is ClineApiReqInfo JSON: token counts, cost and why it stopped. */
  private apiRequest(text: string, ts: number | undefined): void {
    this.open = undefined; // a new request means the previous tool step is over
    const j = parseJsonText(text);
    if (!j) return;
    const tin = num(j.tokensIn);
    const tout = num(j.tokensOut);
    if (tin != null || tout != null) {
      this.sawUsage = true;
      this.tokensIn += tin ?? 0;
      this.tokensOut += tout ?? 0;
    }
    const cancel = str(j.cancelReason);
    if (cancel === 'user_cancelled') pushEvent(this.run, { kind: 'system', text: 'Request cancelled by the user', ts });
    else if (cancel) pushEvent(this.run, { kind: 'error', text: str(j.streamingFailedMessage) ?? `API request failed (${cancel})`, ts, isError: true });
  }

  private toolCard(text: string, ts: number | undefined, m: Obj): void {
    const j = parseJsonText(text) ?? {};
    const uiName = str(j.tool) ?? 'tool';
    const api = this.matchApi('tool', uiName, m);
    if (api && SILENT.test(api.name)) return;
    const kind = kindOf(uiName) !== 'other' ? kindOf(uiName) : kindOf(api?.name);
    const path = str(j.path);
    const isEdit = UI_EDITS.test(uiName) || kind === 'edit';
    const body = isEdit ? str(j.diff) ?? str(j.content) : undefined;
    const summary = path ? (body ? `${path}\n${body}` : path) : toolInputSummary(api?.input ?? j);
    this.call(api?.name ?? uiName, kind, summary, ts, api, isEdit ? path : undefined, fileOpOf(uiName));
  }

  private command(text: string, ts: number | undefined, m: Obj): void {
    // Cline appends REQ_APP when the model asked for approval [source: COMMAND_REQ_APP_STRING].
    const cmd = text.replace(/REQ_APP\s*$/, '').trim();
    const api = this.matchApi('command', undefined, m);
    this.lastCommand = this.call(api?.name ?? 'execute_command', 'run', cmd, ts, api);
  }

  private mcp(text: string, ts: number | undefined, m: Obj): void {
    const j = parseJsonText(text) ?? {};
    const tool = str(j.toolName) ?? str(j.uri) ?? 'mcp';
    const name = str(j.serverName) ? `${j.serverName}/${tool}` : tool;
    const api = this.matchApi('mcp', undefined, m);
    const input = str(j.arguments) ?? str(j.uri) ?? text;
    this.lastMcp = this.call(name, 'other', input, ts, api);
  }

  private browser(text: string, ts: number | undefined, m: Obj): void {
    const j = parseJsonText(text);
    const input = j ? [str(j.action), str(j.url) ?? str(j.text) ?? (Array.isArray(j.coordinate) ? j.coordinate.join(',') : str(j.coordinate))].filter(Boolean).join(' ') : text;
    const api = this.matchApi('browser', undefined, m);
    this.lastBrowser = this.call('browser_action', 'web', input, ts, api);
  }

  /** Output records (command_output, mcp_server_response, browser_action_result). */
  private output(p: Pending | undefined, text: string, ts: number | undefined): void {
    if (p && !p.closed && !p.fromApi) {
      // No API result to pair with: the UI output is the result.
      p.closed = true;
      pushEvent(this.run, { kind: 'tool_result', text, ts, toolCallId: p.id, toolName: p.name, toolKind: p.kind, isError: false });
      if (this.open?.id === p.id) this.open = undefined;
      return;
    }
    if (p?.closed) return; // already shown from the API history, which has the full output
    if (text.trim()) pushEvent(this.run, { kind: 'system', text: `Output so far:\n${text}`, ts });
  }

  /** Cline's diff_error: the edit failed. Show the failed call from the API history, if any. */
  private failedEdit(path: string, ts: number | undefined): void {
    const api = this.matchApi('edit');
    if (api) this.call(api.name, 'edit', path || toolInputSummary(api.input), ts, api, undefined);
  }

  /** Emits a tool_call and, when the API history has it, its result. */
  private call(
    name: string,
    kind: ToolKind,
    text: string,
    ts: number | undefined,
    api: ApiTool | undefined,
    filePath?: string,
    fileOp?: FileOp,
  ): Pending {
    const id = api?.id ?? `ui:${ts ?? 0}:${this.run.tally.toolCalls}`;
    const result = api ? this.api.results.get(api.id) : undefined;
    // A failed edit changed nothing, so it does not count as a file change.
    const changed = kind === 'edit' && filePath && !result?.isError;
    pushEvent(this.run, {
      kind: 'tool_call',
      text,
      ts,
      toolName: name,
      toolCallId: id,
      toolKind: kind,
      ...(changed ? { filePath, fileOp: fileOp ?? 'edit' } : {}),
    });
    if (result) {
      pushEvent(this.run, { kind: 'tool_result', text: result.text, ts: result.ts ?? ts, toolCallId: id, toolName: name, toolKind: kind, isError: result.isError });
      if (this.open?.id) this.open = undefined;
    } else {
      this.open = { id, name, kind, since: ts ?? 0 };
    }
    return { id, name, kind, closed: !!result, fromApi: !!api };
  }

  // ------------------------------------------------------------ ui <-> API pairing

  /**
   * Finds the API tool_use a ui record stands for: the first unused compatible one after the
   * record's conversationHistoryIndex. API calls skipped over never reached the UI (validation
   * failures, disallowed tools) and are emitted first, where they happened.
   */
  private matchApi(cat: string, uiName?: string, m?: Obj): ApiTool | undefined {
    const after = m ? num(m.conversationHistoryIndex) : undefined;
    const tools = this.api.tools;
    let j = -1;
    for (let i = this.low; i < tools.length; i++) {
      const t = tools[i];
      if (!t.consumed && (after == null || t.msgIndex > after) && compatible(cat, uiName, t.name)) {
        j = i;
        break;
      }
    }
    if (j < 0) return undefined;
    this.flushApiTools(j);
    tools[j].consumed = true;
    this.advanceLow();
    return tools[j];
  }

  /**
   * API calls no ui card claimed although their result was written before `ts` (validation
   * failures, disallowed tools): a card is always shown before its tool runs, so none will come.
   */
  private flushAnsweredBefore(ts: number): void {
    while (this.donePtr < this.byDone.length && this.byDone[this.donePtr].done < ts) {
      const t = this.byDone[this.donePtr++].t;
      if (!t.consumed) this.emitApiTool(t);
    }
    this.advanceLow();
  }

  /** Emits unused API calls before index `end` straight from the API history. */
  private flushApiTools(end: number): void {
    for (let i = this.low; i < end && i < this.api.tools.length; i++) {
      const t = this.api.tools[i];
      if (!t.consumed) this.emitApiTool(t);
    }
    this.advanceLow();
  }

  private emitApiTool(t: ApiTool): void {
    t.consumed = true;
    if (SILENT.test(t.name)) return;
    const kind = kindOf(t.name);
    const path = kind === 'edit' ? toolFilePath(t.input) : undefined;
    this.call(t.name, kind, toolInputSummary(t.input), t.ts, t, path, fileOpOf(t.name));
  }

  private advanceLow(): void {
    const tools = this.api.tools;
    while (this.low < tools.length && tools[this.low].consumed) this.low++;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function compatible(cat: string, uiName: string | undefined, api: string): boolean {
  switch (cat) {
    case 'completion':
      return api === 'attempt_completion';
    case 'followup':
      return api === 'ask_followup_question' || api === 'ask_question';
    case 'plan_mode_respond':
    case 'act_mode_respond':
      return api === cat;
    case 'command':
      return kindOf(api) === 'run';
    case 'mcp':
      return /mcp/i.test(api);
    case 'browser':
      return /browser/i.test(api);
    case 'edit':
      return kindOf(api) === 'edit';
    case 'tool': {
      if (!uiName) return false;
      if (UI_EDITS.test(uiName)) return kindOf(api) === 'edit';
      const a = norm(api);
      const u = norm(uiName);
      return a === u || u.startsWith(a) || a.startsWith(u);
    }
    default:
      return false;
  }
}

function feedbackDiffText(text: string): string {
  const j = parseJsonText(text);
  return j && str(j.path) ? `Edited the proposed change to ${j.path}` : text;
}

function errorText(say: string, text: string): string {
  if (say === 'diff_error') return `Edit failed: ${text || 'the change did not apply'}`;
  if (say === 'clineignore_error' || say === 'rooignore_error') return `Blocked by ignore file: ${text}`;
  if (say === 'command_permission_denied') return `Command not permitted: ${text}`;
  return text || 'Error';
}

function systemText(sub: string, text: string): string {
  const label: Record<string, string> = {
    resume_task: 'Task reopened (not resumed)',
    resume_completed_task: 'Completed task reopened',
    auto_approval_max_req_reached: 'Auto-approve request limit reached',
    api_req_retried: 'Retrying the API request',
    error_retry: 'Retrying after an error',
    api_req_retry_delayed: 'API request retry scheduled',
    api_req_rate_limit_wait: 'Waiting for the rate limit',
  };
  const head = label[sub] ?? sub.replace(/_/g, ' ');
  const body = text && !text.trim().startsWith('{') ? clip(text, 2000) : '';
  return body ? `${head}: ${body}` : head;
}

// ---------------------------------------------------------------- turn state

function turnOf(agent: TaskAgent, records: Obj[]): { turn: TurnState; detail?: string } {
  if (!records.length) return { turn: 'unknown' };
  if (records[records.length - 1].partial === true) return { turn: 'in_progress' };
  // Checkpoint bookkeeping says nothing about the turn: judge the record before it. A checkpoint
  // after an approval ask means the tool was approved and ran, so that ask no longer waits.
  let k = records.length - 1;
  while (k > 0 && records[k].type === 'say' && QUIET_SAYS.has(String(records[k].say))) k--;
  const m = records[k];
  const afterQuiet = k < records.length - 1;
  const text = typeof m.text === 'string' ? m.text : '';
  if (m.type === 'ask') {
    const ask = String(m.ask);
    if (ask === 'completion_result' || ask === 'resume_completed_task') return { turn: 'completed' };
    if (afterQuiet && BLOCKING_ASKS.has(ask)) return { turn: 'in_progress' };
    if (ask === 'api_req_failed') return { turn: 'error', detail: `API request failed: ${firstLine(text) || 'unknown error'}` };
    if (ask === 'mistake_limit_reached') return { turn: 'error', detail: 'Stopped after repeated mistakes; waiting for you to continue or stop' };
    if (ask === 'resume_task') return { turn: 'aborted', detail: 'Interrupted; reopen the task to resume it' };
    if (ask === 'auto_approval_max_req_reached') return { turn: 'waiting_input', detail: 'Auto-approve limit reached; waiting for you to continue' };
    if (BLOCKING_ASKS.has(ask)) {
      // Roo writes asks for auto-approved tools too, and marks them answered.
      if (agent === 'roo-code' && m.isAnswered === true) return { turn: 'in_progress' };
      const detail = waitingDetail(ask, text);
      // Roo sets isAnswered only on tool and followup asks [source: Task.ts handleWebviewAskResponse],
      // so an auto-approved command / MCP / browser ask looks the same as one awaiting approval.
      if (agent === 'roo-code' && ROO_UNMARKED_ASKS.has(ask)) return { turn: 'waiting_input', detail: `${detail} (or running it, if auto-approved)` };
      return { turn: 'waiting_input', detail };
    }
    return { turn: 'in_progress' };
  }
  if (m.say === 'completion_result') return { turn: 'completed' };
  if (m.say === 'api_req_started') {
    const j = parseJsonText(text);
    const cancel = str(j?.cancelReason);
    if (cancel === 'user_cancelled') return { turn: 'aborted', detail: 'Cancelled' };
    if (cancel) return { turn: 'error', detail: str(j?.streamingFailedMessage) ?? `API request failed (${cancel})` };
  }
  return { turn: 'in_progress' };
}

function waitingDetail(ask: string, text: string): string {
  const j = parseJsonText(text);
  switch (ask) {
    case 'tool': {
      const tool = str(j?.tool) ?? '';
      const path = str(j?.path) ?? '';
      const verb = /newFileCreated/.test(tool) ? 'create' : /fileDeleted/.test(tool) ? 'delete' : UI_EDITS.test(tool) ? 'edit' : /read/i.test(tool) ? 'read' : 'use a tool on';
      return `Waiting for approval to ${verb} ${path}`.trim();
    }
    case 'command':
      return `Waiting for approval to run: ${firstLine(text.replace(/REQ_APP\s*$/, ''))}`;
    case 'use_mcp_server':
      return `Waiting for approval to use ${str(j?.serverName) ?? 'an MCP server'}${str(j?.toolName) ? ` (${j?.toolName})` : ''}`;
    case 'browser_action_launch':
      return `Waiting for approval to open a browser${text ? `: ${firstLine(text)}` : ''}`;
    case 'followup':
      return `Asked you: ${firstLine(str(j?.question) ?? text)}`;
    case 'plan_mode_respond':
      return 'Waiting for your reply to the plan';
    default:
      return 'Waiting for your input';
  }
}

function firstLine(s: string): string {
  const l = s.split(/\r?\n/).find((x) => x.trim()) ?? '';
  return l.length > 160 ? `${l.slice(0, 157)}…` : l.trim();
}

// ---------------------------------------------------------------- parse entry point

export async function parseTask(agent: TaskAgent, ref: SessionRef, prev: ParseState | undefined): Promise<ParseState> {
  const dir = dirname(ref.path);
  const apiPath = join(dir, 'api_conversation_history.json');
  const historyPath = join(dir, 'history_item.json');
  const siblings: Record<string, number> = { api: await fingerprint(apiPath) };
  if (agent === 'roo-code') siblings.history = await fingerprint(historyPath);
  if (unchanged(ref, prev, siblings)) return prev!;

  let ui: Awaited<ReturnType<typeof readTranscript>>;
  try {
    ui = await readTranscript(ref.path);
  } catch (e) {
    // Caught mid-rewrite (or between Roo's two renames): keep the last good parse and retry later.
    if (prev && !prev.run.readError) return prev;
    throw e;
  }

  let api = emptyIndex();
  try {
    api = indexApiHistory((await readTranscript(apiPath)).value);
  } catch {
    // Missing or torn API history: the UI timeline alone still tells the story, without ids.
  }
  const history = agent === 'roo-code' ? await readJsonQuiet(historyPath, 1024 * 1024) : undefined;
  const h = isObj(history) ? history : undefined;

  const hint = ref.hint ?? {};
  const projectPath = str(h?.workspace) ?? hint.projectPath ?? api.projectPath;
  const w = new TaskWalker(agent, api, baseName(projectPath) || 'Unknown project');
  const run = w.run;
  if (projectPath) run.projectPath = projectPath;
  const task = str(h?.task) ?? hint.title;
  if (task) run.title = makeTitle(task);

  if (!Array.isArray(ui.value)) {
    run.readError = UNRECOGNISED;
  } else {
    const records = ui.value.filter(isObj);
    run.skipped += ui.value.length - records.length;
    w.walk(records);
    if (ui.value.length > 0 && w.recognised === 0) run.readError = UNRECOGNISED;
    const t = turnOf(agent, records);
    run.turn = t.turn;
    if (t.detail) run.turnDetail = t.detail;
  }
  if (ui.salvaged) run.skipped++; // the record cut off at the end of the file

  run.model = w.model ?? api.model ?? hint.model ?? (agent === 'cline' ? await metadataModel(join(dir, 'task_metadata.json')) : undefined);
  const parent = str(h?.parentTaskId);
  if (parent) run.parentPath = join(dirname(dir), parent, 'ui_messages.json');

  return { offset: 0, size: ref.size, mtimeMs: ref.mtimeMs, run, extra: { siblings } };
}

/** task_metadata.json model_usage[]: the model used for the latest request (Cline only). */
async function metadataModel(path: string): Promise<string | undefined> {
  const meta = await readJsonQuiet(path, 4 * 1024 * 1024);
  const usage = isObj(meta) && Array.isArray(meta.model_usage) ? meta.model_usage.filter(isObj) : [];
  return usage.length ? str(usage[usage.length - 1].model_id) : undefined;
}
