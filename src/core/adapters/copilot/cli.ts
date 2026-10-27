// GitHub Copilot CLI (`copilot`).
//
// Provenance (research/copilot.md, 2026-10-27): the event envelope and payloads were read from
// the @github/copilot 1.0.73 bundle that ships inside VS Code's Copilot extension [source], and
// from the public changelog up to 1.0.103. The research machine had ~/.copilot but no
// session-state folder, so no real transcript was seen: confidence is 'source'. Some details are
// only plausible: context.repository/branch on session.start, the inner keys of
// session.shutdown.modelMetrics[*].usage, and the permissionRequest shape. The XDG roots below
// are a guess; the code only references COPILOT_HOME and ~/.copilot.
//
// Layout under <COPILOT_HOME or ~/.copilot>/session-state:
//   <sessionId>/events.jsonl     current transcript, one {type, data, id, timestamp, parentId} per line
//   <sessionId>/workspace.yaml   metadata: cwd, git_root, branch, name/user_named, summary
//   <sessionId>.jsonl            legacy flat transcript (same envelope, read best-effort)
// Ephemeral events (assistant.usage, session.idle, *_delta, ...) are normally not in the file.

import { stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { FileOp, TokenUsage, ToolKind } from '@shared/schema';
import { emptyRun, type DiscoverContext, type Env, type ParsedRun, type ParseState, type SessionRef } from '../../adapter';
import { countDiffLines, diffTexts, newFileDiff, pushChange, samePathTail, splitFileDiffs, type DiffText } from '../../changes';
import { baseName, isObj, makeTitle, pushEvent, textOf, toMs, toolFilePath, toolInputSummary, toolKind } from '../../events';
import { readJsonl } from '../../jsonl';
import { addUsage, setUsageTotal, tokenCount } from '../../usage';
import { canContinue, listDir, parseFlatYaml, readSignature, readSmallText, statOrNull } from './shared';
import { UNRECOGNISED } from './vscode';

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------- locations

export function cliRoots(env: Env): string[] {
  const p = env.platform === 'win32' ? win32 : posix;
  const v = env.vars;
  if (v.COPILOT_HOME) return [p.join(v.COPILOT_HOME, 'session-state')];
  const roots = [p.join(env.home, '.copilot', 'session-state')];
  // Unverified: early CLI docs said XDG_CONFIG_HOME relocates the config folder.
  if (v.XDG_CONFIG_HOME) {
    roots.push(p.join(v.XDG_CONFIG_HOME, '.copilot', 'session-state'));
    roots.push(p.join(v.XDG_CONFIG_HOME, 'copilot', 'session-state'));
  }
  return roots;
}

// ---------------------------------------------------------------- discover

export async function discoverCli(roots: string[], ctx: DiscoverContext): Promise<SessionRef[]> {
  const out: SessionRef[] = [];
  const seen = new Set<string>();
  for (const root of new Set(roots)) {
    for (const ref of await discoverRoot(root, ctx.since)) {
      if (seen.has(ref.path)) continue;
      seen.add(ref.path);
      out.push(ref);
    }
  }
  return out;
}

/** A root may be session-state itself, the COPILOT_HOME above it, or one session folder. */
async function discoverRoot(root: string, since: number): Promise<SessionRef[]> {
  let entries = await listDir(root);
  if (entries.some((e) => e.isDirectory() && e.name === 'session-state')) {
    root = join(root, 'session-state');
    entries = await listDir(root);
  }
  if (entries.some((e) => e.isFile() && e.name === 'events.jsonl')) {
    const ref = await sessionRef(join(root, 'events.jsonl'), baseName(root), since, false);
    return ref ? [ref] : [];
  }
  const refs: SessionRef[] = [];
  for (const e of entries) {
    let ref: SessionRef | null = null;
    if (e.isDirectory()) ref = await sessionRef(join(root, e.name, 'events.jsonl'), e.name, since, false);
    else if (e.isFile() && /\.jsonl$/i.test(e.name)) ref = await sessionRef(join(root, e.name), e.name.replace(/\.jsonl$/i, ''), since, true);
    if (ref) refs.push(ref);
  }
  return refs;
}

async function sessionRef(path: string, id: string, since: number, legacy: boolean): Promise<SessionRef | null> {
  const s = await statOrNull(path);
  // A session folder with no events file is provisional (never used): nothing to show.
  if (!s || s.isDir || s.size === 0) return null;
  if (since > 0 && s.mtimeMs < since) return null;
  const hint: Record<string, string> = { sessionId: id };
  if (legacy) hint.legacy = '1';
  return { agent: 'copilot-cli', path, mtimeMs: s.mtimeMs, size: s.size, hint };
}

function join(a: string, ...rest: string[]): string {
  return (/^[a-zA-Z]:[\\/]|^\\\\/.test(a) ? win32 : posix).join(a, ...rest);
}

// ---------------------------------------------------------------- parse state

interface PendingTool {
  name: string;
  kind: ToolKind;
  input: string;
  args?: unknown;
  ts?: number;
  started: boolean;
}

/** Everything carried between incremental parses. Plain data only. */
interface CliState {
  tools: Record<string, PendingTool>;
  perms: Record<string, string>;
  waits: Record<string, string>;
  inTurn: boolean;
  lastMsgHadTools: boolean;
  outcome: 'completed' | 'error' | 'aborted' | null;
  outcomeDetail?: string;
  shutdown: 'routine' | 'error' | null;
  shutdownDetail?: string;
  model?: string;
  cwd?: string;
  gitRoot?: string;
  branch?: string;
  repository?: string;
  firstPrompt?: string;
  recognised: number;
  lines: number;
}

function initState(): CliState {
  return {
    tools: {},
    perms: {},
    waits: {},
    inTurn: false,
    lastMsgHadTools: false,
    outcome: null,
    shutdown: null,
    recognised: 0,
    lines: 0,
  };
}

export async function parseCli(ref: SessionRef, prev: ParseState | undefined): Promise<ParseState> {
  const s = await stat(ref.path);
  if (prev && prev.extra.kind === 'cli' && prev.size === s.size && prev.mtimeMs === s.mtimeMs) return prev;
  const cont = await canContinue(ref.path, prev, s.size, 'cli');
  // Work on copies: the store keeps showing `prev` while this parse awaits file reads.
  const run = cont ? cloneRun(prev!.run) : emptyRun(ref.hint?.project || 'Unknown project');
  const x = cont ? (structuredClone(prev!.extra.x) as CliState) : initState();
  const res = await readJsonl(ref.path, cont ? prev!.offset : 0, (rec) => apply(run, x, rec));
  run.skipped += res.bad;
  x.lines += res.good + res.bad;
  finish(run, x, await readWorkspace(ref));
  const sig = await readSignature(ref.path, res.offset);
  return { offset: res.offset, size: res.size, mtimeMs: res.mtimeMs, run, extra: { kind: 'cli', sig, x } };
}

/** A copy of a run that shares the (never edited) event objects. */
function cloneRun(r: ParsedRun): ParsedRun {
  const files: ParsedRun['files'] = {};
  for (const [k, f] of Object.entries(r.files)) files[k] = { ...f, ops: [...f.ops] };
  return { ...r, events: r.events.slice(), tally: { ...r.tally }, files, openTool: r.openTool ? { ...r.openTool } : undefined };
}

/** workspace.yaml next to events.jsonl: titles the user set, and project info as a fallback. */
async function readWorkspace(ref: SessionRef): Promise<Record<string, string | boolean | number>> {
  if (ref.hint?.legacy || !/events\.jsonl$/i.test(ref.path)) return {};
  const text = await readSmallText(ref.path.replace(/events\.jsonl$/i, 'workspace.yaml'), 64 * 1024);
  return text ? parseFlatYaml(text) : {};
}

// ---------------------------------------------------------------- records

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const SYSTEM_TYPES: Record<string, string> = {
  'session.compaction_start': 'Compacting the conversation',
  'session.compaction_complete': 'Conversation compacted',
  'session.truncation': 'Conversation truncated',
  'session.snapshot_rewind': 'Rewound to an earlier point',
  'skill.invoked': 'Skill invoked',
  'hook.start': 'Hook started',
  'hook.end': 'Hook finished',
  'subagent.started': 'Sub-agent started',
  'subagent.completed': 'Sub-agent finished',
  'subagent.failed': 'Sub-agent failed',
  'subagent.selected': 'Sub-agent selected',
};

/**
 * Recognised but not shown: streaming pieces and ephemeral events that sometimes get persisted,
 * plus persisted bookkeeping events (mode, plan, permissions, checkpoints). [source: emit() calls]
 */
const QUIET_TYPES = new Set([
  'session.usage_checkpoint',
  'session.usage_info',
  'session.mode_changed',
  'session.plan_changed',
  'session.permissions_changed',
  'session.session_limits_changed',
  'session.auto_mode_resolved',
  'session.autopilot_objective_changed',
  'session.binary_asset',
  'session.canvas.recorded',
  'session.canvas.removed',
  'session.schedule_created',
  'session.schedule_cancelled',
  'session.schedule_rearmed',
  'session.handoff',
  'session.remote_steerable_changed',
  'tool_search.activated',
  'external_tool.requested',
  'external_tool.completed',
  'subagent.deselected',
  'pending_messages.modified',
  'assistant.turn_retry',
  'model.call_failure',
  'tool.execution_partial_result',
  'tool.execution_progress',
  'session.workspace_file_changed',
  'session.idle',
  'session.info',
  'session.title_changed',
  'assistant.message_delta',
  'assistant.reasoning_delta',
  'assistant.usage',
  'model.call_start',
]);

const WAIT_REQUESTS: Record<string, string> = {
  'elicitation.requested': 'Waiting for your answer',
  'exit_plan_mode.requested': 'Waiting for plan approval',
  'user_input.requested': 'Waiting for your input',
};

function apply(run: ParsedRun, x: CliState, rec: unknown): void {
  if (!isObj(rec) || typeof rec.type !== 'string') return void run.skipped++;
  const type = rec.type;
  const d: Obj = isObj(rec.data) ? rec.data : {};
  const ts = toMs(rec.timestamp);
  x.recognised++;
  switch (type) {
    case 'session.start':
    case 'session.resume':
      onStart(run, x, d, type === 'session.resume', ts);
      return;
    case 'session.model_change':
      if (str(d.newModel)) {
        x.model = str(d.newModel);
        pushEvent(run, { kind: 'system', text: `Model changed to ${x.model}`, ts });
      }
      return;
    case 'user.message':
      return onUser(run, x, d, ts);
    case 'assistant.turn_start':
      x.inTurn = true;
      x.lastMsgHadTools = false;
      clearError(x);
      return;
    case 'assistant.message':
      return onAssistant(run, x, d, ts);
    case 'assistant.turn_end':
      // A turn that asked for tools is followed by another turn; only the last one ends the reply.
      // A turn that already ended in an abort or an error keeps that outcome.
      if (x.outcome === null && !x.lastMsgHadTools && !Object.keys(x.tools).length) {
        x.inTurn = false;
        x.outcome = 'completed';
      }
      return;
    case 'tool.execution_start':
    case 'tool.user_requested':
      // tool.user_requested: a shell command the user ran directly (no execution_start follows).
      return onToolStart(run, x, d, ts);
    case 'session.context_changed':
      if (str(d.branch)) x.branch = str(d.branch);
      if (!x.cwd && str(d.cwd)) x.cwd = str(d.cwd);
      return;
    case 'session.task_complete':
      pushEvent(run, { kind: 'system', text: str(d.summary) || 'Task complete', ts });
      return;
    case 'tool.execution_complete':
      return onToolComplete(run, x, d, ts);
    case 'permission.requested':
      return onPermission(run, x, d, ts);
    case 'permission.completed': {
      delete x.perms[str(d.requestId)];
      const kind = isObj(d.result) ? str(d.result.kind) : '';
      pushEvent(run, { kind: 'system', text: `Permission ${kind ? kind.replace(/-/g, ' ') : 'answered'}`, ts });
      return;
    }
    case 'abort':
      pushEvent(run, { kind: 'system', text: `Interrupted${str(d.reason) ? `: ${str(d.reason)}` : ''}`, ts });
      endTurn(x, 'aborted', 'Interrupted');
      return;
    case 'session.error': {
      const msg = [str(d.errorType), str(d.message)].filter(Boolean).join(': ') || 'Session error';
      pushEvent(run, { kind: 'error', text: msg, isError: true, ts });
      // The error that follows a user's abort ("request aborted") is part of the interruption.
      if (x.outcome !== 'aborted') endTurn(x, 'error', str(d.message) || msg);
      return;
    }
    case 'session.warning':
      pushEvent(run, { kind: 'system', text: str(d.message) || 'Warning', ts });
      return;
    case 'session.shutdown':
      return onShutdown(run, x, d, ts);
    case 'system.message':
    case 'system.notification':
      pushEvent(run, { kind: 'system', text: str(d.content) || str(d.message) || textOf(d, 2000), ts });
      return;
  }
  if (WAIT_REQUESTS[type]) {
    x.waits[str(d.requestId) || type] = WAIT_REQUESTS[type];
    pushEvent(run, { kind: 'system', text: WAIT_REQUESTS[type], ts });
    return;
  }
  if (/^(elicitation|exit_plan_mode|user_input)\.completed$/.test(type)) {
    const key = str(d.requestId) || type.replace('.completed', '.requested');
    delete x.waits[key];
    pushEvent(run, { kind: 'system', text: 'Answered', ts });
    return;
  }
  if (SYSTEM_TYPES[type]) {
    const extra = str(d.agentName) || str(d.agentDisplayName) || str(d.name) || str(d.skillName);
    pushEvent(run, { kind: 'system', text: extra ? `${SYSTEM_TYPES[type]}: ${extra}` : SYSTEM_TYPES[type], ts });
    return;
  }
  if (QUIET_TYPES.has(type) || rec.ephemeral === true) return;
  x.recognised--;
  run.skipped++;
}

function onStart(run: ParsedRun, x: CliState, d: Obj, resume: boolean, ts: number | undefined): void {
  if (str(d.selectedModel)) x.model = str(d.selectedModel);
  const c = isObj(d.context) ? d.context : {};
  if (str(c.cwd)) x.cwd = str(c.cwd);
  if (str(c.gitRoot)) x.gitRoot = str(c.gitRoot);
  if (str(c.branch)) x.branch = str(c.branch);
  if (str(c.repository)) x.repository = str(c.repository);
  if (resume) {
    // Shutdowns before a resume no longer describe the session.
    x.shutdown = null;
    x.shutdownDetail = undefined;
    pushEvent(run, { kind: 'system', text: 'Session resumed', ts });
  } else {
    const at = toMs(d.startTime) ?? ts;
    if (at) run.startedAt = Math.min(run.startedAt ?? at, at);
  }
}

function onUser(run: ParsedRun, x: CliState, d: Obj, ts: number | undefined): void {
  const text = str(d.content) || str(d.transformedContent);
  const source = str(d.source);
  // Autopilot continuations and system-sourced messages are not the user's prompt.
  const fromUser = !d.isAutopilotContinuation && !/system|autopilot|hook|skill/i.test(source);
  if (text) pushEvent(run, { kind: fromUser ? 'user' : 'system', text, ts });
  if (fromUser && text && x.firstPrompt === undefined) x.firstPrompt = makeTitle(text);
  x.inTurn = true;
  x.lastMsgHadTools = false;
  x.outcome = null;
  x.outcomeDetail = undefined;
}

function onAssistant(run: ParsedRun, x: CliState, d: Obj, ts: number | undefined): void {
  // Each message records its output tokens only; input comes with the session totals at shutdown.
  let usage: TokenUsage | undefined = tokenCount(d.outputTokens) !== undefined ? { output: tokenCount(d.outputTokens) } : undefined;
  const take = () => {
    const u = usage;
    usage = undefined;
    return u;
  };
  if (str(d.reasoningText).trim()) pushEvent(run, { kind: 'reasoning', text: str(d.reasoningText), ts, usage: take() });
  if (str(d.content).trim()) pushEvent(run, { kind: 'assistant', text: str(d.content), ts, usage: take() });
  if (usage) addUsage(run, usage, ts);
  if (str(d.model) && d.model !== 'resumed') x.model = str(d.model);
  const reqs = Array.isArray(d.toolRequests) ? d.toolRequests.filter(isObj) : [];
  for (const t of reqs) {
    const id = str(t.toolCallId);
    if (!id || x.tools[id]) continue;
    // Held back: tool.execution_start normally follows and becomes the tool_call event.
    x.tools[id] = pendingTool(str(t.name), t.arguments, ts, false);
  }
  x.lastMsgHadTools = reqs.length > 0;
  x.inTurn = true;
  clearError(x);
}

/**
 * Some session.errors are retried (rate limits, expired tokens): when the agent carries on, the
 * error no longer describes the turn. An abort stays an abort.
 */
function clearError(x: CliState): void {
  if (x.outcome === 'error') {
    x.outcome = null;
    x.outcomeDetail = undefined;
  }
}

function pendingTool(name: string, args: unknown, ts: number | undefined, started: boolean): PendingTool {
  const n = name || 'tool';
  return { name: n, kind: cliToolKind(n, args), input: toolInputSummary(args ?? ''), args, ts, started };
}

/** Kinds for CLI tool names the shared rules miss. [source: CLI tool names] */
export function cliToolKind(name: string, args?: unknown): ToolKind {
  const n = name.toLowerCase();
  if (n === 'str_replace_editor') return isObj(args) && args.command === 'view' ? 'read' : 'edit';
  if (n === 'insert') return 'edit';
  if (/^(read|write|stop|list)_(bash|powershell)$/.test(n)) return 'run';
  return toolKind(name);
}

function emitCall(run: ParsedRun, id: string, t: PendingTool): void {
  // Edit tools count their file on success (a file_change event), not on the call.
  const fp = t.kind === 'edit' ? undefined : toolFilePath(t.args);
  pushEvent(run, { kind: 'tool_call', text: t.input || t.name, toolName: t.name, toolCallId: id, toolKind: t.kind, filePath: fp, ts: t.ts });
}

function onToolStart(run: ParsedRun, x: CliState, d: Obj, ts: number | undefined): void {
  const id = str(d.toolCallId);
  const prior = id ? x.tools[id] : undefined;
  if (prior?.started) return;
  const t = pendingTool(str(d.toolName) || prior?.name || '', d.arguments ?? prior?.args, ts, true);
  if (id) x.tools[id] = t;
  emitCall(run, id, t);
  x.inTurn = true;
  clearError(x);
}

function onToolComplete(run: ParsedRun, x: CliState, d: Obj, ts: number | undefined): void {
  const id = str(d.toolCallId);
  const t = id ? x.tools[id] : undefined;
  // No tool.execution_start seen: the assistant's toolRequests stand in for it.
  if (t && !t.started) emitCall(run, id, t);
  const ok = d.success !== false;
  const name = t?.name ?? (str(d.toolName) || 'tool');
  const err = isObj(d.error) ? d.error : undefined;
  const text = ok ? resultText(d.result) : str(err?.message) || str(err?.code) || 'The tool failed';
  pushEvent(run, {
    kind: 'tool_result',
    text,
    toolName: name,
    toolCallId: id || undefined,
    toolKind: t?.kind ?? cliToolKind(name),
    isError: !ok,
    durationMs: t?.ts && ts ? Math.max(0, ts - t.ts) : undefined,
    ts,
  });
  if (ok && t) {
    const files = writtenFiles(t.name, t.args);
    for (const f of files) {
      pushEvent(run, { kind: 'file_change', text: `${t.name} ${f.path}`, filePath: f.path, fileOp: f.op, toolCallId: id || undefined, ts });
    }
    noteChanges(run, files, t.args, d, id || undefined, ts);
  }
  if (id) delete x.tools[id];
}

/**
 * One change per written file. The result's detailedContent holds a git-style diff of what was
 * applied (and toolTelemetry.metrics the line counts); without it the call's arguments
 * (old_str/new_str, file_text) describe the edit. [fixture shape]
 */
function noteChanges(run: ParsedRun, files: { path: string; op: FileOp }[], args: unknown, d: Obj, id: string | undefined, ts: number | undefined): void {
  if (!files.length) return;
  const r = isObj(d.result) ? d.result : {};
  const parts = typeof r.detailedContent === 'string' ? splitFileDiffs(r.detailedContent) : [];
  const tele = isObj(d.toolTelemetry) && isObj(d.toolTelemetry.metrics) ? d.toolTelemetry.metrics : {};
  for (const f of files) {
    const part = files.length === 1 && parts.length === 1 ? parts[0] : parts.find((p) => samePathTail(f.path, p.path));
    let diff: DiffText | undefined = part ? { diff: part.diff, ...countDiffLines(part.diff) } : undefined;
    if (!diff && files.length === 1 && isObj(args)) {
      const before = str(args.old_str);
      const after = str(args.new_str);
      if (typeof args.file_text === 'string') diff = newFileDiff(args.file_text);
      else if (typeof args.old_str === 'string' && typeof args.new_str === 'string') diff = diffTexts(before, after);
    }
    const one = files.length === 1;
    pushChange(run, {
      ts,
      filePath: f.path,
      op: f.op,
      diff: diff?.diff,
      linesAdded: (one ? tokenCount(tele.linesAdded) : undefined) ?? diff?.added,
      linesRemoved: (one ? tokenCount(tele.linesRemoved) : undefined) ?? diff?.removed,
      toolCallId: id,
    });
  }
}

function resultText(r: unknown): string {
  if (!isObj(r)) return typeof r === 'string' ? r : 'Done';
  const c = r.content ?? r.detailedContent;
  return (typeof c === 'string' ? c : textOf(c)) || 'Done';
}

/** File-writing tools (the CLI's rewind set): str_replace_editor, create, edit, insert, apply_patch. [source] */
export function writtenFiles(name: string, args: unknown): { path: string; op: FileOp }[] {
  const n = name.toLowerCase();
  if (n === 'apply_patch') return patchFiles(args);
  if (!isObj(args)) return [];
  const path = toolFilePath(args);
  if (!path) return [];
  if (n === 'str_replace_editor') {
    if (args.command === 'view') return [];
    return [{ path, op: args.command === 'create' ? 'create' : 'edit' }];
  }
  if (n === 'create' || n === 'write_file' || n === 'create_file') return [{ path, op: 'create' }];
  if (n === 'edit' || n === 'insert' || n === 'write') return [{ path, op: 'edit' }];
  return [];
}

/** apply_patch carries a "*** Begin Patch" envelope; file headers name the files. [plausible] */
function patchFiles(args: unknown): { path: string; op: FileOp }[] {
  const text = typeof args === 'string' ? args : isObj(args) ? str(args.input) || str(args.patch) : '';
  const out: { path: string; op: FileOp }[] = [];
  const re = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ path: m[2].trim(), op: m[1] === 'Add' ? 'create' : m[1] === 'Delete' ? 'delete' : 'edit' });
  }
  return out;
}

function onPermission(run: ParsedRun, x: CliState, d: Obj, ts: number | undefined): void {
  const pr = isObj(d.permissionRequest) ? d.permissionRequest : {};
  const what = str(pr.intention) || str(pr.kind) || 'a tool';
  const target = str(pr.fileName) || str(pr.fullCommandText) || str(pr.command) || str(pr.url);
  const detail = `Waiting for permission: ${what}${target ? ` ${target}` : ''}`;
  x.perms[str(d.requestId) || `perm-${Object.keys(x.perms).length}`] = detail;
  pushEvent(run, { kind: 'system', text: detail.replace('Waiting for permission', 'Permission requested'), ts });
}

function endTurn(x: CliState, outcome: 'error' | 'aborted', detail: string): void {
  x.outcome = outcome;
  x.outcomeDetail = detail;
  x.inTurn = false;
  x.tools = {};
  x.perms = {};
  x.waits = {};
}

function onShutdown(run: ParsedRun, x: CliState, d: Obj, ts: number | undefined): void {
  const isError = d.shutdownType === 'error';
  x.shutdown = isError ? 'error' : 'routine';
  x.shutdownDetail = str(d.errorReason) || undefined;
  pushEvent(run, { kind: isError ? 'error' : 'system', text: isError ? `Session ended with an error${x.shutdownDetail ? `: ${x.shutdownDetail}` : ''}` : 'Session ended', isError: isError || undefined, ts });
  // Session totals per model (persisted since 0.0.422). Each shutdown is cumulative: on resume
  // the CLI restores its metrics from the last shutdown event, so the newest one replaces the
  // others instead of adding to them. [source: UsageMetricsTracker.processShutdown]
  // inputTokens includes the cache reads and writes, which are reported apart. The growth over
  // what the messages already reported goes to the shutdown's day.
  const metrics = isObj(d.modelMetrics) ? d.modelMetrics : undefined;
  if (metrics) {
    const sum: Record<'in' | 'out' | 'cr' | 'cw', number | undefined> = { in: undefined, out: undefined, cr: undefined, cw: undefined };
    const add = (k: keyof typeof sum, v: unknown) => {
      const n = tokenCount(v);
      if (n !== undefined) sum[k] = (sum[k] ?? 0) + n;
    };
    for (const m of Object.values(metrics)) {
      const u = isObj(m) && isObj(m.usage) ? m.usage : undefined;
      if (!u) continue;
      add('in', u.inputTokens);
      add('out', u.outputTokens);
      add('cr', u.cacheReadTokens);
      add('cw', u.cacheWriteTokens);
    }
    const input = sum.in === undefined ? undefined : Math.max(0, sum.in - (sum.cr ?? 0) - (sum.cw ?? 0));
    setUsageTotal(run, { input, output: sum.out, cacheRead: sum.cr, cacheWrite: sum.cw }, ts);
  }
  if (str(d.currentModel)) x.model = str(d.currentModel);
  x.inTurn = false;
  x.tools = {};
  x.perms = {};
  x.waits = {};
}

// ---------------------------------------------------------------- summary

function finish(run: ParsedRun, x: CliState, ws: Record<string, string | boolean | number>): void {
  const wsStr = (k: string) => (typeof ws[k] === 'string' ? (ws[k] as string) : undefined);
  run.model = x.model;
  const cwd = x.cwd ?? wsStr('cwd') ?? x.gitRoot ?? wsStr('git_root');
  const repo = x.repository ?? wsStr('repository');
  if (cwd) run.projectPath = cwd;
  run.projectName = baseName(cwd) || (repo ? repo.split('/').pop()! : '') || run.projectName;
  run.gitBranch = x.branch ?? wsStr('branch');
  // A name the user gave the session wins; else the CLI's own summary title; else the first prompt.
  const named = ws.user_named === true ? wsStr('name') : undefined;
  run.title = makeTitle(named || wsStr('summary') || '') || x.firstPrompt || run.title;

  run.openTool = undefined;
  run.turnDetail = undefined;
  const perm = Object.values(x.perms).at(-1);
  const wait = Object.values(x.waits).at(-1);
  const asking = Object.values(x.tools).some((t) => t.started && t.name === 'ask_user');
  if (x.shutdown === 'error') {
    run.turn = 'error';
    run.turnDetail = x.shutdownDetail || 'The session ended with an error';
  } else if (perm || wait || asking) {
    run.turn = 'waiting_input';
    run.turnDetail = perm ?? wait ?? 'Waiting for your answer';
  } else if (x.outcome === 'error') {
    run.turn = 'error';
    run.turnDetail = x.outcomeDetail;
  } else if (x.outcome === 'aborted') {
    run.turn = 'aborted';
    run.turnDetail = x.outcomeDetail;
  } else if (x.shutdown === 'routine') {
    run.turn = 'completed';
  } else if (x.inTurn || Object.keys(x.tools).length) {
    run.turn = 'in_progress';
    run.openTool = newestTool(x);
  } else {
    run.turn = x.outcome === 'completed' ? 'completed' : 'unknown';
  }

  if (x.recognised === 0 && x.lines > 0) run.readError = UNRECOGNISED;
  else delete run.readError;
}

function newestTool(x: CliState): ParsedRun['openTool'] {
  let best: PendingTool | undefined;
  for (const t of Object.values(x.tools)) if (!best || (t.ts ?? 0) >= (best.ts ?? 0)) best = t;
  return best ? { name: best.name, kind: best.kind, since: best.ts ?? 0 } : undefined;
}
