// Token usage accounting for adapters. Usage is only what the source records: a field the source
// does not report stays undefined, and nothing is estimated. Both helpers replace run.usage
// rather than editing it, because incremental parse states share it with earlier states.

import type { RunUsage, TokenUsage } from '@shared/schema';
import { USAGE_FIELDS, dayKey, hasUsage } from '@shared/usage';
import type { ParsedRun } from './adapter';

/** A finite, non-negative token count, else undefined. */
export function tokenCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Drops fields that are undefined, so `{input: undefined}` does not read as reported. */
export function cleanUsage(u: TokenUsage): TokenUsage | undefined {
  const out: TokenUsage = {};
  for (const k of USAGE_FIELDS) {
    const n = tokenCount(u[k]);
    if (n !== undefined) out[k] = n;
  }
  return hasUsage(out) ? out : undefined;
}

function plus(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  const out: TokenUsage = { ...a };
  for (const k of USAGE_FIELDS) if (b[k] !== undefined) out[k] = (out[k] ?? 0) + b[k]!;
  return out;
}

/**
 * Adds tokens reported by one message or record. `ts` (epoch ms) puts them in that local day's
 * bucket as well; without it they count in the totals only.
 */
export function addUsage(run: ParsedRun, delta: TokenUsage, ts?: number): void {
  const d = cleanUsage(delta);
  if (!d) return;
  const next: RunUsage = { ...plus(run.usage, d) };
  const byDay = run.usage?.byDay;
  if (ts && USAGE_FIELDS.some((k) => (d[k] ?? 0) > 0)) {
    const key = dayKey(ts);
    next.byDay = { ...byDay, [key]: plus(byDay?.[key], d) };
  } else if (byDay) next.byDay = byDay;
  run.usage = next;
}

/**
 * For usage recorded once per request or reply, after its events were pushed: adds it like
 * addUsage and puts it on the first of those events (`since` is run.tally.events before them)
 * that is not the user's prompt, when it is still in memory.
 */
export function addUsageSince(run: ParsedRun, since: number, delta: TokenUsage, ts?: number): void {
  const d = cleanUsage(delta);
  if (!d) return;
  addUsage(run, d, ts);
  const first = run.events.length - (run.tally.events - since);
  let at = -1;
  for (let i = Math.max(0, first); i < run.events.length; i++) {
    if (run.events[i].kind === 'user') continue;
    at = i;
    break;
  }
  // Replaced, not edited: earlier parse states may share the event object.
  if (at >= 0 && !run.events[at].usage) run.events[at] = { ...run.events[at], usage: d };
}

/**
 * For sources that record running totals (each record holds the session total so far): the
 * growth since the last total goes to `ts`'s day. A total that went down (a reset) replaces the
 * totals and leaves the days as they were.
 */
export function setUsageTotal(run: ParsedRun, total: TokenUsage, ts?: number): void {
  const t = cleanUsage(total);
  if (!t) return;
  const cur = run.usage;
  const delta: TokenUsage = {};
  let reset = false;
  for (const k of USAGE_FIELDS) {
    if (t[k] === undefined) continue;
    const d = t[k]! - (cur?.[k] ?? 0);
    if (d < 0) reset = true;
    delta[k] = d;
  }
  if (!reset) return addUsage(run, delta, ts);
  const next: RunUsage = { ...cur, ...t };
  if (cur?.byDay) next.byDay = cur.byDay;
  run.usage = next;
}
