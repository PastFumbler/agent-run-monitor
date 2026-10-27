// Turns an adapter's parse state into what the UI sees, and makes parsing crash-proof:
// whatever an adapter throws becomes an "unreadable" run, never an app crash.

import { createHash } from 'node:crypto';
import type {
  FileChangeSummary,
  RunDetail,
  RunEvent,
  RunSummary,
  ToolCallSummary,
} from '@shared/schema';
import { emptyRun, freshState, type ParseContext, type ParseState, type SessionRef, type SourceAdapter } from './adapter';
import { baseName } from './events';
import { maskSecrets } from './masking';
import { judgeStatus } from './status';

export function runId(ref: SessionRef): string {
  const h = createHash('sha1').update(`${ref.path}\u0000${ref.subId ?? ''}`).digest('hex').slice(0, 16);
  return `${ref.agent}:${h}`;
}

/** Plain-words reason for a parse failure, for the "couldn't read this run" card. */
export function describeError(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === 'ENOENT') return 'The file is gone (it was moved or deleted).';
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return 'No permission to read this file.';
  if (err?.code === 'EBUSY') return 'The file is locked by another program; will retry.';
  if (e instanceof SyntaxError) return "The file isn't valid JSON; the agent may have changed its format.";
  const msg = err?.message ? String(err.message) : String(e);
  return `Couldn't read this run: ${msg.slice(0, 200)}`;
}

export async function safeParse(
  adapter: SourceAdapter,
  ref: SessionRef,
  prev: ParseState | undefined,
  ctx: ParseContext,
): Promise<ParseState> {
  try {
    const st = await adapter.parse(ref, prev, ctx);
    if (!st || !st.run || !Array.isArray(st.run.events)) throw new Error('adapter returned no run');
    if (!st.run.projectName) st.run.projectName = 'Unknown project';
    return st;
  } catch (e) {
    const st = freshState();
    st.run = emptyRun(ref.hint?.project ?? baseName(ref.path));
    st.run.readError = describeError(e);
    st.size = ref.size;
    st.mtimeMs = ref.mtimeMs;
    return st;
  }
}

const id = (s: string) => s;

export function toSummary(ref: SessionRef, st: ParseState, now: number, mask: boolean): RunSummary {
  const r = st.run;
  const m = mask ? maskSecrets : id;
  const j = judgeStatus(r, ref.mtimeMs, now);
  const updatedAt = Math.max(r.lastEventAt ?? 0, ref.mtimeMs);
  return {
    id: runId(ref),
    agent: ref.agent,
    title: m(r.title || (r.readError ? "Couldn't read this run" : 'Untitled run')),
    projectName: r.projectName || 'Unknown project',
    projectPath: r.projectPath,
    gitBranch: r.gitBranch,
    model: r.model,
    startedAt: r.startedAt ?? ref.mtimeMs,
    updatedAt,
    status: j.status,
    statusDetail: j.detail ? m(j.detail) : undefined,
    statusInferred: j.inferred,
    counts: {
      events: r.tally.events,
      messages: r.tally.messages,
      toolCalls: r.tally.toolCalls,
      errors: r.tally.errors,
      filesChanged: Object.keys(r.files).length,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    },
    sourcePath: ref.path,
    readError: r.readError,
    currentTool: j.status === 'running' ? r.openTool?.name : undefined,
    parentId: r.parentPath ? runId({ ...ref, path: r.parentPath, subId: r.parentSubId }) : undefined,
  };
}

export function toDetail(ref: SessionRef, st: ParseState, now: number, mask: boolean, limit = 2000): RunDetail {
  const summary = toSummary(ref, st, now, mask);
  const m = mask ? maskSecrets : id;
  const all = st.run.events;
  const startSeq = st.run.dropped;
  const events: RunEvent[] = all.map((e, i) => ({ ...e, seq: startSeq + i, text: m(e.text) }));
  const files: FileChangeSummary[] = Object.entries(st.run.files)
    .map(([path, f]) => ({ path, ops: [...f.ops], count: f.count, lastTs: f.lastTs }))
    .sort((a, b) => b.count - a.count || (b.lastTs ?? 0) - (a.lastTs ?? 0));

  // Pair tool calls with their results by id (or, without ids, with the next result).
  const tools: ToolCallSummary[] = [];
  const byId = new Map<string, ToolCallSummary>();
  let lastOpen: ToolCallSummary | undefined;
  for (const e of events) {
    if (e.kind === 'tool_call') {
      const t: ToolCallSummary = {
        toolCallId: e.toolCallId,
        toolName: e.toolName ?? 'tool',
        toolKind: e.toolKind ?? 'other',
        input: e.text,
        startedAt: e.ts,
        open: true,
      };
      tools.push(t);
      if (e.toolCallId) byId.set(e.toolCallId, t);
      lastOpen = t;
    } else if (e.kind === 'tool_result') {
      const t = (e.toolCallId && byId.get(e.toolCallId)) || (!e.toolCallId ? lastOpen : undefined);
      if (t && t.open) {
        t.open = false;
        t.output = e.text;
        t.isError = e.isError;
        if (e.durationMs != null) t.durationMs = e.durationMs;
        else if (t.startedAt && e.ts) t.durationMs = Math.max(0, e.ts - t.startedAt);
      }
    }
  }
  // Only the run's genuinely open call stays open; older unmatched calls were simply never answered.
  const openId = st.run.openTool ? tools.at(-1) : undefined;
  for (const t of tools) if (t !== openId && t.open && summary.status !== 'running') t.open = false;

  return {
    summary,
    events: events.slice(-limit),
    totalEvents: st.run.tally.events,
    files,
    tools: tools.slice(-limit),
  };
}
