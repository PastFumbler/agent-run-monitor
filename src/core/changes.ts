// Code-change records: one per edit an agent made to a file, with exact line counts and a
// unified-diff style text when the source records the edit's content. Adapters build them with
// the diff helpers below and add them with pushChange, which keeps memory bounded.

import type { CodeChange, FileOp } from '@shared/schema';
import type { ParsedRun } from './adapter';

/** The newest edits kept per run; older ones are counted, not kept. */
export const MAX_CHANGES = 1000;
/** Longest diff kept per edit (characters). */
export const MAX_DIFF = 64 * 1024;
/** Diff text kept per run; past it the oldest edits lose their diff (their line counts stay). */
export const DIFF_BUDGET = 1024 * 1024;
/** Context lines around each change, as in `diff -u`. */
const CONTEXT = 3;
/** Larger inputs are not diffed line by line (they get one replace-everything hunk). */
const MAX_DIFF_LINES = 20000;
/** Edit distance past which the line diff gives up and falls back to one hunk. */
const MAX_EDIT_DISTANCE = 1000;

export interface DiffText {
  diff: string;
  added: number;
  removed: number;
}

export interface NewChange {
  ts?: number;
  filePath: string;
  op?: FileOp;
  /** Undefined when unknown. Taken from `diff` when that is given and these are not. */
  linesAdded?: number;
  linesRemoved?: number;
  diff?: string;
  toolCallId?: string;
}

/** Adds one edit to the run (replacing run.changes: parse states share the old array). */
export function pushChange(run: ParsedRun, c: NewChange): void {
  if (!c.filePath) return;
  let { linesAdded, linesRemoved, diff } = c;
  if (diff !== undefined && !diff.trim()) diff = undefined;
  if (diff !== undefined && (linesAdded === undefined || linesRemoved === undefined)) {
    const n = countDiffLines(diff);
    linesAdded ??= n.added;
    linesRemoved ??= n.removed;
  }
  const change: CodeChange = { filePath: c.filePath, op: c.op ?? 'edit' };
  if (c.ts) change.ts = c.ts;
  if (linesAdded !== undefined) change.linesAdded = linesAdded;
  if (linesRemoved !== undefined) change.linesRemoved = linesRemoved;
  if (diff !== undefined) {
    if (diff.length > MAX_DIFF) {
      const cut = diff.lastIndexOf('\n', MAX_DIFF);
      change.diff = diff.slice(0, cut > 0 ? cut : MAX_DIFF);
      change.truncated = true;
    } else change.diff = diff;
  }
  if (c.toolCallId) change.toolCallId = c.toolCallId;

  let list = [...(run.changes ?? []), change];
  if (list.length > MAX_CHANGES) {
    const extra = list.length - MAX_CHANGES;
    list = list.slice(extra);
    run.droppedChanges = (run.droppedChanges ?? 0) + extra;
  }
  let chars = 0;
  for (const x of list) chars += x.diff?.length ?? 0;
  for (let i = 0; chars > DIFF_BUDGET && i < list.length - 1; i++) {
    const x = list[i];
    if (x.diff === undefined) continue;
    chars -= x.diff.length;
    const { diff: _dropped, ...rest } = x;
    list[i] = { ...rest, truncated: true };
  }
  run.changes = list;
}

export interface PatchFile {
  path: string;
  op: FileOp;
  /** The file's part of the patch as diff text (capped: it is kept in parse state), with exact counts. */
  diff?: DiffText;
  /** The old path of a moved file: its change is recorded on the new path. */
  moved?: boolean;
}

/**
 * Caps diff text an adapter keeps in parse state (between a call and its result): pushChange
 * still sees it as too long, clips it to MAX_DIFF and marks it truncated. Counts stay exact.
 */
export function capDiff(d: DiffText | undefined): DiffText | undefined {
  if (!d || !d.diff) return undefined;
  return d.diff.length > MAX_DIFF + 1 ? { ...d, diff: d.diff.slice(0, MAX_DIFF + 1) } : d;
}

/**
 * Reads an apply_patch body (Codex format, also used by Copilot CLI and Cline): `*** Add|Update|
 * Delete File:` and `*** Move to:` headers, with each file's hunk lines ("@@", " ", "+", "-")
 * as its diff.
 */
export function applyPatchFiles(input: unknown): PatchFile[] {
  if (typeof input !== 'string') return [];
  const out: PatchFile[] = [];
  let body: string[] | undefined;
  const flush = () => {
    const f = out[out.length - 1];
    if (f && body?.length) {
      const diff = f.op === 'create' && !body.some((l) => l.startsWith('@@')) ? ['@@', ...body].join('\n') : body.join('\n');
      f.diff = capDiff({ diff, ...countDiffLines(diff) });
    }
    body = undefined;
  };
  for (const line of input.split(/\r?\n/)) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      flush();
      out.push({ path: m[2].trim(), op: m[1] === 'Add' ? 'create' : m[1] === 'Delete' ? 'delete' : 'edit' });
      body = [];
      continue;
    }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv && out.length) {
      out[out.length - 1].op = 'delete';
      out[out.length - 1].moved = true;
      out.push({ path: mv[1].trim(), op: 'create' });
      continue;
    }
    if (line.startsWith('*** ')) {
      flush(); // *** End Patch, *** End of File
      continue;
    }
    if (body && /^(@@|[ +-])/.test(line)) body.push(line);
  }
  flush();
  return out;
}

/** Splits text into lines; a final newline does not make an extra empty line. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Added and removed lines in a unified diff (one or many files). Hunks with line counts in
 * their "@@ -a,b +c,d @@" header are read exactly; header-less text counts every "+"/"-" line
 * except "+++ "/"--- " file headers.
 */
export function countDiffLines(diff: string): { added: number; removed: number } {
  const lines = diff.split(/\r?\n/);
  let added = 0;
  let removed = 0;
  if (!lines.some((l) => l.startsWith('@@'))) {
    for (const l of lines) {
      if (l.startsWith('+') && !l.startsWith('+++ ')) added++;
      else if (l.startsWith('-') && !l.startsWith('--- ')) removed++;
    }
    return { added, removed };
  }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('@@')) continue;
    const m = /^@@+ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i]);
    let oldLeft = m ? Number(m[1] ?? 1) : Infinity;
    let newLeft = m ? Number(m[2] ?? 1) : Infinity;
    while (i + 1 < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const l = lines[i + 1];
      const c = l[0];
      if (c === '+') (added++, newLeft--);
      else if (c === '-') (removed++, oldLeft--);
      else if (c === ' ') (oldLeft--, newLeft--);
      else if (c !== '\\') break;
      i++;
    }
  }
  return { added, removed };
}

/**
 * Splits a git-style or unified diff into one entry per file: the new path (without the "b/"
 * prefix, when the headers name it) and that file's hunk text, from its first "@@" on. File
 * headers (diff --git, index, ---, +++) are dropped. Text without hunks gives no entries.
 */
export function splitFileDiffs(text: string): { path?: string; diff: string }[] {
  const out: { path?: string; diff: string }[] = [];
  let path: string | undefined;
  let body: string[] = [];
  const flush = () => {
    while (body.length && !body[body.length - 1].trim()) body.pop();
    if (body.length) out.push({ path, diff: body.join('\n') });
    path = undefined;
    body = [];
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const git = /^diff --git a\/.+? b\/(.+)$/.exec(line);
    if (git) {
      flush();
      path = git[1];
      continue;
    }
    // A "--- x" / "+++ y" pair after a hunk starts the next file of a plain unified diff.
    if (body.length && line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) flush();
    if (!body.length) {
      const plus = /^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/.exec(line);
      if (plus && plus[1] !== '/dev/null') path = plus[1];
      if (line.startsWith('@@')) body.push(line);
      continue;
    }
    body.push(line);
  }
  flush();
  return out;
}

/** True when `full` (an absolute or relative path in either slash style) ends with `tail`. */
export function samePathTail(full: string, tail: string | undefined): boolean {
  if (!tail) return false;
  const f = full.replace(/\\/g, '/').toLowerCase();
  const t = tail.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return f === t || f.endsWith(`/${t}`);
}

type Op = { t: ' ' | '-' | '+'; line: string; a: number; b: number };

/** Line-level edit script (Myers), or undefined when the inputs are too big or too different. */
function editScript(a: string[], b: string[]): Op[] | undefined {
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return undefined;
  const ids = new Map<string, number>();
  const id = (s: string) => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, (v = ids.size));
    return v;
  };
  const A = a.map(id);
  const B = b.map(id);
  const n = A.length;
  const m = B.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[-d-1 .. d+1] as it was before round d: all the backtrack needs.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) (x++, y++);
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return undefined;
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d];
    const at = (kk: number) => pv[kk + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > px && y > py) ops.push({ t: ' ', line: a[--x], a: x, b: --y });
    if (down) ops.push({ t: '+', line: b[--y], a: x, b: y });
    else ops.push({ t: '-', line: a[--x], a: x, b: y });
  }
  while (x > 0 && y > 0) ops.push({ t: ' ', line: a[--x], a: x, b: --y });
  return ops.reverse();
}

/** Fallback script: common first and last lines kept, everything between replaced. */
function replaceScript(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', line: a[i], a: i, b: i });
  for (let i = pre; i < a.length - suf; i++) ops.push({ t: '-', line: a[i], a: i, b: pre });
  for (let j = pre; j < b.length - suf; j++) ops.push({ t: '+', line: b[j], a: a.length - suf, b: j });
  for (let i = 0; i < suf; i++) ops.push({ t: ' ', line: a[a.length - suf + i], a: a.length - suf + i, b: b.length - suf + i });
  return ops;
}

/**
 * A unified diff between two texts. With `startLine` (the 1-based line where `before` starts in
 * its file, 1 for whole files) hunk headers carry line numbers; without it (a snippet whose place
 * in the file is unknown) they are a bare "@@".
 */
export function diffTexts(before: string, after: string, startLine?: number): DiffText {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = editScript(a, b) ?? replaceScript(a, b);
  const out: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i].t === ' ') i++;
    if (i >= ops.length) break;
    // One hunk: from CONTEXT lines before this change to CONTEXT lines after the last change
    // that is no more than 2*CONTEXT unchanged lines from the previous one.
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    let j = i;
    while (j < ops.length) {
      if (ops[j].t !== ' ') {
        end = j;
        j++;
        continue;
      }
      let k = j;
      while (k < ops.length && ops[k].t === ' ') k++;
      if (k >= ops.length || k - j > 2 * CONTEXT) break;
      j = k;
    }
    const stop = Math.min(ops.length, end + 1 + CONTEXT);
    const body: string[] = [];
    let oldN = 0;
    let newN = 0;
    for (let x = start; x < stop; x++) {
      const o = ops[x];
      body.push(o.t + o.line);
      if (o.t !== '+') oldN++;
      if (o.t !== '-') newN++;
      if (o.t === '+') added++;
      if (o.t === '-') removed++;
    }
    if (startLine !== undefined) {
      const first = ops[start];
      const oldStart = oldN ? first.a + startLine : first.a + startLine - 1;
      const newStart = newN ? first.b + startLine : first.b + startLine - 1;
      out.push(`@@ -${oldStart},${oldN} +${newStart},${newN} @@`);
    } else out.push('@@');
    out.push(...body);
    i = stop;
  }
  return { diff: out.join('\n'), added, removed };
}

/** A whole new file: every line added. */
export function newFileDiff(content: string): DiffText {
  const lines = splitLines(content);
  if (!lines.length) return { diff: '', added: 0, removed: 0 };
  return { diff: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n'), added: lines.length, removed: 0 };
}

/** Hunks stored as {oldStart, oldLines, newStart, newLines, lines[]} (Claude Code structuredPatch). */
export function diffFromHunks(hunks: unknown): DiffText | undefined {
  if (!Array.isArray(hunks)) return undefined;
  const out: string[] = [];
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    if (typeof h !== 'object' || h === null) continue;
    const r = h as Record<string, unknown>;
    if (!Array.isArray(r.lines)) continue;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    out.push(`@@ -${num(r.oldStart)},${num(r.oldLines)} +${num(r.newStart)},${num(r.newLines)} @@`);
    for (const l of r.lines) {
      if (typeof l !== 'string') continue;
      out.push(l);
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  }
  return out.length ? { diff: out.join('\n'), added, removed } : undefined;
}

/**
 * SEARCH/REPLACE blocks (Cline, Roo, Aider):
 *   <<<<<<< SEARCH / ------- SEARCH, then old lines, =======, new lines, >>>>>>> REPLACE / +++++++ REPLACE.
 * Roo puts ":start_line:N" (and a "-------" line) before the old lines: the hunks then carry line
 * numbers. Undefined when the text holds no complete block.
 */
export function diffFromSearchReplace(text: string): DiffText | undefined {
  const re = /^(?:<{5,}|-{3,}) ?SEARCH[^\n]*\n([\s\S]*?)^={5,}[^\n]*\n([\s\S]*?)^(?:>{5,}|\+{3,}) ?REPLACE/gm;
  const parts: string[] = [];
  let added = 0;
  let removed = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const head = /^((?::(?:start|end)_line:[ \t]*\d+[ \t]*\r?\n)+)(?:-{3,}[ \t]*\r?\n)?/.exec(m[1]);
    const start = head ? /:start_line:\s*(\d+)/.exec(head[1]) : null;
    const d = diffTexts(head ? m[1].slice(head[0].length) : m[1], m[2], start ? Number(start[1]) : undefined);
    if (!d.diff) continue;
    parts.push(d.diff);
    added += d.added;
    removed += d.removed;
  }
  return parts.length ? { diff: parts.join('\n'), added, removed } : undefined;
}
