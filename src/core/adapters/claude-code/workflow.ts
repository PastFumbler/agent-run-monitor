// Parses a Claude Code workflow run from `subagents/workflows/wf_<id>/journal.jsonl`.
//
// Journal format (verified on a real install: 57 journals, 870 records; append-only, no timestamps):
//   {"type":"launched"}                                       run (re)launched
//   {"type":"started","key","agentId","label","phase"}        one agent attempt began
//   {"type":"result","key","agentId","result": string|object} it handed in a result
//   {"type":"failed","key","agentId"}                         it failed (no reason given)
// `error` and `skipped` end records are handled because an earlier private monitor did
// (not seen on the install). A key can start again after failing: that is a retry.
// When the run ends Claude Code writes `<sid>/workflows/<runId>.json` (status completed|killed);
// the name and description come from it or from `workflows/scripts/<name>-<runId>.js`.
// The journal has no timestamps, so activity comes from the agent transcripts' mtimes.

import { basename, dirname, join } from 'node:path';
import type { ParsedRun, ParseState, SessionRef } from '../../adapter';
import { freshState } from '../../adapter';
import { baseName, isObj, pushEvent, textOf, toMs } from '../../events';
import { readJsonl } from '../../jsonl';
import { cloneState, headCwd, listDir, readSmallJson, readSmallText, statOrNull } from './io';

const STATE_VERSION = 2;

interface PendingAgent {
  agentId: string;
  key: string;
  label: string;
}

interface WorkflowExtra {
  [k: string]: unknown;
  v: number;
  kind: 'workflow';
  pending: PendingAgent[];
  /** Latest attempt outcome per key: retries overwrite earlier failures. */
  keys: Record<string, 'started' | 'done' | 'failed'>;
  launches: number;
  recognised: number;
  cwd?: string;
  scriptName?: string;
  scriptDescription?: string;
}

export async function parseWorkflow(ref: SessionRef, prev: ParseState | undefined, parentPath: string | undefined): Promise<ParseState> {
  const continuing = !!prev && prev.extra.v === STATE_VERSION && prev.extra.kind === 'workflow' && prev.offset <= ref.size;
  const st = continuing ? cloneState(prev!) : freshState();
  if (!continuing) {
    const extra: WorkflowExtra = { v: STATE_VERSION, kind: 'workflow', pending: [], keys: {}, launches: 0, recognised: 0 };
    st.extra = extra;
    st.run.projectName = ref.hint?.project || 'Unknown project';
    // The journal has no cwd: take the parent session's first one.
    if (parentPath) extra.cwd = await headCwd(parentPath);
  }
  const x = st.extra as WorkflowExtra;
  const run = st.run;
  run.parentPath = parentPath;
  if (x.cwd) {
    run.projectPath = x.cwd;
    run.projectName = baseName(x.cwd) || run.projectName;
  }

  const res = await readJsonl(ref.path, st.offset, (rec) => onRecord(rec, run, x));
  if (res.restarted && continuing) return parseWorkflow(ref, undefined, parentPath);
  st.offset = res.offset;
  st.size = res.size;
  st.mtimeMs = res.mtimeMs;
  run.skipped += res.bad;

  await finalize(ref, run, x, st.offset);
  return st;
}

function onRecord(rec: unknown, run: ParsedRun, x: WorkflowExtra): void {
  if (!isObj(rec) || typeof rec.type !== 'string') {
    run.skipped++;
    return;
  }
  const agentId = typeof rec.agentId === 'string' ? rec.agentId : undefined;
  const key = typeof rec.key === 'string' ? rec.key : agentId ?? '';
  switch (rec.type) {
    case 'launched':
      x.recognised++;
      // Agents still open from the previous launch were superseded by this one.
      for (const p of x.pending) pushEvent(run, { kind: 'tool_result', text: 'Superseded by a relaunch', toolName: p.label, toolCallId: p.agentId, toolKind: 'agent' });
      x.pending = [];
      x.launches++;
      pushEvent(run, { kind: 'system', text: x.launches > 1 ? 'Workflow relaunched' : 'Workflow launched' });
      return;
    case 'started': {
      if (!agentId) break;
      x.recognised++;
      const label = typeof rec.label === 'string' && rec.label ? rec.label : 'agent';
      const phase = typeof rec.phase === 'string' && rec.phase ? ` (${rec.phase})` : '';
      // The same key started again while an earlier attempt is still open: a resumed workflow
      // re-runs the agents it lost without writing a new `launched` record (seen on the real
      // install). The earlier attempt was cut off and will never end.
      const lost = key ? x.pending.filter((p) => p.key === key) : [];
      for (const p of lost) pushEvent(run, { kind: 'tool_result', text: 'Cut off; replaced by a new attempt', toolName: p.label, toolCallId: p.agentId, toolKind: 'agent' });
      if (lost.length) x.pending = x.pending.filter((p) => !lost.includes(p));
      const retry = x.keys[key] === 'failed' ? ', retry' : lost.length ? ', restart' : '';
      pushEvent(run, { kind: 'tool_call', text: `${label}${phase}${retry}`, toolName: label, toolCallId: agentId, toolKind: 'agent' });
      x.pending.push({ agentId, key, label });
      x.keys[key] = 'started';
      return;
    }
    case 'result':
    case 'failed':
    case 'error':
    case 'skipped': {
      if (!agentId) break;
      x.recognised++;
      const failed = rec.type === 'failed' || rec.type === 'error' || (rec.type === 'result' && rec.result == null);
      const p = takePending(x, agentId);
      pushEvent(run, {
        kind: 'tool_result',
        text: endText(rec),
        toolName: p?.label,
        toolCallId: agentId,
        toolKind: 'agent',
        isError: failed,
      });
      x.keys[key] = failed ? 'failed' : 'done';
      return;
    }
    default:
      break;
  }
  run.skipped++;
}

function takePending(x: WorkflowExtra, agentId: string): PendingAgent | undefined {
  const i = x.pending.findIndex((p) => p.agentId === agentId);
  return i >= 0 ? x.pending.splice(i, 1)[0] : undefined;
}

/** One line for an end record: the review verdict when the result has one. */
function endText(rec: Record<string, unknown>): string {
  if (rec.type === 'failed') return 'Failed';
  if (rec.type === 'skipped') return 'Skipped';
  if (rec.type === 'error') return `Failed: ${textOf(rec.error ?? rec.message, 300) || 'error'}`;
  const r = rec.result;
  if (r == null) return 'Failed: no result';
  if (isObj(r) && ('blockers' in r || 'shouldFix' in r)) {
    const n = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0);
    const blockers = n(r.blockers);
    const shouldFix = n(r.shouldFix);
    const verdict = blockers > 0 ? `${blockers} blocker(s)` : shouldFix > 0 ? `${shouldFix} should-fix` : 'Clean';
    const report = typeof r.report === 'string' && r.report ? `: ${r.report}` : '';
    return `${verdict}${report}`;
  }
  return textOf(r, 4000);
}

async function finalize(ref: SessionRef, run: ParsedRun, x: WorkflowExtra, offset: number): Promise<void> {
  const runId = ref.hint?.runId || basename(dirname(ref.path));
  const sessionDir = ref.hint?.sessionDir || dirname(dirname(dirname(dirname(ref.path))));
  const summary = await readSmallJson(join(sessionDir, 'workflows', `${runId}.json`));
  const sum = isObj(summary) ? summary : undefined;
  if (!sum && !x.scriptName) await readScriptMeta(sessionDir, runId, x);

  const name = (typeof sum?.workflowName === 'string' && sum.workflowName) || x.scriptName || runId;
  const desc = (typeof sum?.summary === 'string' && sum.summary) || x.scriptDescription;
  run.title = desc ? `${name}: ${desc}` : `Workflow ${name}`;
  if (typeof sum?.defaultModel === 'string' && sum.defaultModel) run.model = sum.defaultModel;

  const start = toMs(sum?.startTime);
  if (start) run.startedAt = start;
  else if (!run.startedAt) {
    // No summary yet (the run is live) and the journal has no timestamps: its creation time.
    const js = await statOrNull(ref.path);
    if (js && js.birthtimeMs > 0) run.startedAt = js.birthtimeMs;
  }
  const dur = typeof sum?.durationMs === 'number' ? sum.durationMs : undefined;
  if (start && dur != null) run.lastEventAt = Math.max(run.lastEventAt ?? 0, start + dur);

  // Open agents: their transcripts show whether the run is still moving.
  let openSince: number | undefined;
  for (const p of x.pending) {
    const st = await statOrNull(join(dirname(ref.path), `agent-${p.agentId}.jsonl`));
    if (!st) continue;
    run.lastEventAt = Math.max(run.lastEventAt ?? 0, st.mtimeMs);
    const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    if (p === x.pending.at(-1)) openSince = born;
  }

  const failedKeys = Object.values(x.keys).filter((s) => s === 'failed').length;
  const started = Object.keys(x.keys).length;
  const status = typeof sum?.status === 'string' ? sum.status : undefined;
  run.turnDetail = undefined;
  run.openTool = undefined;
  if (status === 'killed') {
    run.turn = 'aborted';
    run.turnDetail = 'The workflow was stopped';
  } else if (!status && x.pending.length) {
    const last = x.pending.at(-1)!;
    run.turn = 'in_progress';
    run.openTool = { name: last.label, kind: 'agent', since: openSince ?? ref.mtimeMs };
  } else if (failedKeys > 0) {
    run.turn = 'error';
    run.turnDetail = `${failedKeys} agent${failedKeys > 1 ? 's' : ''} failed`;
  } else if (status || started > 0) {
    run.turn = 'completed'; // between phases reads idle for a few minutes, then done
  } else {
    run.turn = 'unknown';
  }

  if (offset > 0 && x.recognised === 0) run.readError = 'No records this app recognises; the agent may have changed its format.';
  else delete run.readError;
}

/** `export const meta = { name: '...', description: '...' }` from the workflow script. */
async function readScriptMeta(sessionDir: string, runId: string, x: WorkflowExtra): Promise<void> {
  const dir = join(sessionDir, 'workflows', 'scripts');
  const file = (await listDir(dir)).find((e) => e.isFile() && e.name.endsWith(`-${runId}.js`));
  if (!file) return;
  const text = await readSmallText(join(dir, file.name), 512 * 1024);
  if (!text) return;
  const head = /export\s+const\s+meta\s*=\s*\{([\s\S]{0,4000}?)\n\}/.exec(text)?.[1] ?? text.slice(0, 4000);
  x.scriptName = /\bname\s*:\s*(['"`])([^'"`\n]{1,200})\1/.exec(head)?.[2] ?? file.name.slice(0, -(`-${runId}.js`.length));
  x.scriptDescription = /\bdescription\s*:\s*(['"`])([^'"`\n]{1,400})\1/.exec(head)?.[2];
}

const END_TYPES = new Set(['result', 'failed', 'error', 'skipped']);

/**
 * What the journal says about one workflow agent whose own transcript still reads mid-turn.
 * The transcript cannot tell a cut-off agent from a slow one; the journal next to it can:
 *   - an end record for this agentId: it finished (or failed) as far as the workflow is concerned;
 *   - a relaunch, or a later attempt under the same key: it was cut off and replaced;
 *   - a later attempt with the same label and phase whose transcript was created at least
 *     `quietMs` after this one's last write: a resumed run re-ran it (on the real install resumed
 *     runs restart lost agents under a new key); the margin keeps busy siblings with equal labels apart;
 *   - the run's summary file exists: the workflow ended without it.
 * Undefined when the journal is missing or says nothing more.
 */
export async function workflowAgentVerdict(
  agentPath: string,
  lastWrite: number,
  quietMs: number,
): Promise<{ turn: ParsedRun['turn']; detail: string } | undefined> {
  const dir = dirname(agentPath);
  const id = basename(agentPath).replace(/^agent-/, '').replace(/\.jsonl$/, '');
  const text = await readSmallText(join(dir, 'journal.jsonl'), 8 * 1024 * 1024);
  if (!text) return undefined;
  const recs: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (isObj(r)) recs.push(r);
    } catch {
      // a line still being written
    }
  }
  const end = recs.find((r) => r.agentId === id && typeof r.type === 'string' && END_TYPES.has(r.type));
  if (end) {
    const ok = end.type === 'skipped' || (end.type === 'result' && end.result != null);
    return ok ? { turn: 'completed', detail: 'The workflow recorded its result' } : { turn: 'error', detail: 'The workflow marked this agent as failed' };
  }
  const si = recs.findIndex((r) => r.type === 'started' && r.agentId === id);
  if (si < 0) return undefined;
  const me = recs[si];
  const later = recs.slice(si + 1);
  if (later.some((r) => r.type === 'launched')) return { turn: 'aborted', detail: 'Stopped when the workflow was relaunched' };
  if (typeof me.key === 'string' && later.some((r) => r.type === 'started' && r.key === me.key)) {
    return { turn: 'aborted', detail: 'Cut off; the workflow started a new attempt' };
  }
  for (const r of later) {
    if (r.type !== 'started' || r.label !== me.label || r.phase !== me.phase || typeof r.agentId !== 'string') continue;
    const st = await statOrNull(join(dir, `agent-${r.agentId}.jsonl`));
    const born = st ? (st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs) : 0;
    if (born && born >= lastWrite + quietMs) return { turn: 'aborted', detail: 'Cut off; the workflow started a new attempt' };
  }
  const runId = basename(dir);
  const sessionDir = dirname(dirname(dirname(dir)));
  if (await statOrNull(join(sessionDir, 'workflows', `${runId}.json`))) return { turn: 'aborted', detail: 'The workflow ended before this agent finished' };
  return undefined;
}
