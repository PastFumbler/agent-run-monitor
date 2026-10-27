// Turns the raw event stream into display items: a tool result is folded into its call, so the
// Activity view shows one row per tool use with its outcome.

import type { RunEvent, RunStatus } from '@shared/schema';
import type { CallChipStatus } from '../../vendor/react-bits/CallChip/CallChip';

export interface EventItem {
  key: string;
  event: RunEvent;
  /** For tool calls: the matching result, when it has arrived. */
  result?: RunEvent;
  callStatus?: CallChipStatus;
  /** Reasoning that is the newest event of a running run. */
  working?: boolean;
}

export function buildEventItems(events: RunEvent[], status: RunStatus): EventItem[] {
  const results = new Map<string, RunEvent>();
  const calls = new Set<string>();
  for (const e of events) {
    if (e.kind === 'tool_result' && e.toolCallId) results.set(e.toolCallId, e);
    if (e.kind === 'tool_call' && e.toolCallId) calls.add(e.toolCallId);
  }
  const items: EventItem[] = [];
  const last = events[events.length - 1];
  for (const e of events) {
    if (e.kind === 'tool_result' && e.toolCallId && calls.has(e.toolCallId)) continue;
    const item: EventItem = { key: `${e.seq}`, event: e };
    if (e.kind === 'tool_call') {
      const r = e.toolCallId ? results.get(e.toolCallId) : undefined;
      item.result = r;
      item.callStatus = r ? (r.isError ? 'error' : 'done') : status === 'running' || status === 'waiting' || status === 'stuck' ? 'running' : 'idle';
    }
    if (e.kind === 'reasoning') item.working = status === 'running' && e === last;
    items.push(item);
  }
  return items;
}

export const KIND_LABELS: Record<RunEvent['kind'], string> = {
  user: 'Prompt',
  assistant: 'Agent',
  reasoning: 'Reasoning',
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  file_change: 'File change',
  error: 'Error',
  system: 'System',
};

/** Splits reasoning into short steps for ThoughtLine. */
export function reasoningSteps(text: string, max = 8): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+(?=[A-Z])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= max) return parts;
  return [...parts.slice(0, max - 1), parts.slice(max - 1).join(' ')];
}

export function firstLine(text: string, max = 90): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Guess a tool's kind from its name when only the name is known (run list chips). */
export function guessToolKind(name: string | undefined): 'run' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'other' {
  const n = (name ?? '').toLowerCase();
  if (/bash|shell|terminal|command|exec|run/.test(n)) return 'run';
  if (/edit|write|patch|replace|create|diff/.test(n)) return 'edit';
  if (/web|fetch|browser|url/.test(n)) return 'web';
  if (/read|view|cat|open/.test(n)) return 'read';
  if (/grep|search|glob|find|list|ls/.test(n)) return 'search';
  if (/task|agent/.test(n)) return 'agent';
  return 'other';
}
