// Small helpers for token usage (see TokenUsage in schema.ts). Shared by the main process, which
// builds the per-day buckets while parsing, and the renderer, which reads them.

import type { TokenUsage } from './schema';

export const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const satisfies readonly (keyof TokenUsage)[];

/** The local calendar day of an epoch-ms time, as 'YYYY-MM-DD'. Keys RunUsage.byDay. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** True when at least one field is reported (defined). */
export function hasUsage(u: TokenUsage | undefined): u is TokenUsage {
  return !!u && USAGE_FIELDS.some((k) => u[k] !== undefined);
}

/** Sum of the reported fields; undefined when nothing is reported. */
export function totalTokens(u: TokenUsage | undefined): number | undefined {
  if (!hasUsage(u)) return undefined;
  return USAGE_FIELDS.reduce((n, k) => n + (u[k] ?? 0), 0);
}
