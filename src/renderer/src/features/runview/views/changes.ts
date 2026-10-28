// Pure helpers for the Code changed view: the totals line, diff line kinds and stable row keys.
// Line counts the source didn't record stay undefined: they are reported as unknown, never as 0.

import type { CodeChange } from '@shared/schema';

export interface ChangeTotals {
  /** Distinct file paths. */
  files: number;
  edits: number;
  /** Sum of the known counts. */
  added: number;
  removed: number;
  /** Edits with at least one unknown line count. */
  unknown: number;
}

export function changeTotals(changes: readonly CodeChange[]): ChangeTotals {
  const paths = new Set<string>();
  let added = 0;
  let removed = 0;
  let unknown = 0;
  for (const c of changes) {
    paths.add(c.filePath);
    if (c.linesAdded !== undefined) added += c.linesAdded;
    if (c.linesRemoved !== undefined) removed += c.linesRemoved;
    if (c.linesAdded === undefined || c.linesRemoved === undefined) unknown++;
  }
  return { files: paths.size, edits: changes.length, added, removed, unknown };
}

export type DiffLineKind = 'hunk' | 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Splits CodeChange.diff into lines tagged by their leading marker ("@@", "+", "-", anything else). */
export function diffLines(diff: string): DiffLine[] {
  const lines = diff.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((text) => ({
    kind: text.startsWith('@@') ? 'hunk' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : 'ctx',
    text,
  }));
}

/**
 * React keys that stay the same when the tail window drops older edits from the front (so an open
 * diff stays open while a live run grows). Repeats of the same call, file and time get a suffix.
 */
export function changeKeys(changes: readonly CodeChange[]): string[] {
  const seen = new Map<string, number>();
  return changes.map((c) => {
    const base = `${c.toolCallId ?? ''}|${c.filePath}|${c.ts ?? ''}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}|${n}` : base;
  });
}
