import { describe, expect, it } from 'vitest';
import { emptyRun, freshState, type SessionRef } from './adapter';
import { toDetail } from './build';
import {
  DIFF_BUDGET,
  MAX_CHANGES,
  MAX_DIFF,
  applyPatchFiles,
  countDiffLines,
  diffFromHunks,
  diffFromSearchReplace,
  diffTexts,
  newFileDiff,
  pushChange,
  splitFileDiffs,
} from './changes';

describe('diffTexts', () => {
  it('finds the changed lines with three lines of context and real line numbers', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i'].join('\n');
    const d = diffTexts(before, after, 1);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.diff).toBe(['@@ -1,8 +1,9 @@', ' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g', ' h', '+i'].join('\n'));
  });

  it('splits far-apart changes into separate hunks', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const after = [...lines];
    after[1] = 'changed 2';
    after[27] = 'changed 28';
    const d = diffTexts(lines.join('\n'), after.join('\n'), 1);
    const headers = d.diff.split('\n').filter((l) => l.startsWith('@@'));
    expect(headers).toEqual(['@@ -1,5 +1,5 @@', '@@ -25,6 +25,6 @@']);
    expect([d.added, d.removed]).toEqual([2, 2]);
  });

  it('marks snippet hunks with a bare @@ when the place in the file is unknown', () => {
    const d = diffTexts('x = 1\n', 'x = 2\ny = 3\n');
    expect(d.diff).toBe('@@\n-x = 1\n+x = 2\n+y = 3');
    expect(countDiffLines(d.diff)).toEqual({ added: 2, removed: 1 });
  });

  it('gives an empty diff for identical texts', () => {
    expect(diffTexts('same\n', 'same\n', 1)).toEqual({ diff: '', added: 0, removed: 0 });
  });

  it('falls back to one replace-everything hunk for very different large inputs, with exact counts', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    const d = diffTexts(a, b, 1);
    expect([d.added, d.removed]).toEqual([3000, 3000]);
  });
});

describe('countDiffLines', () => {
  it('reads hunks by their header counts, so "---"/"+++" content lines still count', () => {
    const diff = ['--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', '--- removed dashes', '+++ added pluses', ' ctx'].join('\n');
    expect(countDiffLines(diff)).toEqual({ added: 1, removed: 1 });
  });

  it('counts +/- lines of header-less text, skipping file headers', () => {
    expect(countDiffLines('--- a\n+++ b\n-x\n+y\n+z')).toEqual({ added: 2, removed: 1 });
  });
});

describe('diff shapes from the sources', () => {
  it('reads structuredPatch hunks', () => {
    const d = diffFromHunks([{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' a', '-b', '+B', '+C'] }]);
    expect(d).toEqual({ diff: '@@ -3,2 +3,3 @@\n a\n-b\n+B\n+C', added: 2, removed: 1 });
    expect(diffFromHunks('nope')).toBeUndefined();
  });

  it('turns a new file into added lines', () => {
    expect(newFileDiff('one\ntwo\n')).toEqual({ diff: '@@ -0,0 +1,2 @@\n+one\n+two', added: 2, removed: 0 });
    expect(newFileDiff('')).toEqual({ diff: '', added: 0, removed: 0 });
  });

  it('splits a git diff per file and drops the file headers', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1,0 +1,1 @@',
      '+z',
    ].join('\n');
    expect(splitFileDiffs(text)).toEqual([
      { path: 'src/a.ts', diff: '@@ -1 +1 @@\n-x\n+y' },
      { path: 'b.ts', diff: '@@ -1,0 +1,1 @@\n+z' },
    ]);
    expect(splitFileDiffs('no hunks here')).toEqual([]);
  });

  it('reads SEARCH/REPLACE blocks in the Cline, Roo and Aider spellings', () => {
    const cline = '------- SEARCH\nold\n=======\nnew\n+++++++ REPLACE';
    expect(diffFromSearchReplace(cline)).toEqual({ diff: '@@\n-old\n+new', added: 1, removed: 1 });
    const roo = '<<<<<<< SEARCH\n:start_line:12\n-------\nold\n=======\nnew\nmore\n>>>>>>> REPLACE';
    expect(diffFromSearchReplace(roo)).toEqual({ diff: '@@ -12,1 +12,2 @@\n-old\n+new\n+more', added: 2, removed: 1 });
    expect(diffFromSearchReplace('no blocks')).toBeUndefined();
  });

  it('reads apply_patch bodies per file', () => {
    const files = applyPatchFiles('*** Begin Patch\n*** Update File: a.py\n@@\n-x\n+y\n*** End Patch');
    expect(files).toEqual([{ path: 'a.py', op: 'edit', diff: { diff: '@@\n-x\n+y', added: 1, removed: 1 } }]);
  });
});

describe('pushChange', () => {
  it('takes line counts from the diff and leaves unknown counts undefined', () => {
    const run = emptyRun();
    pushChange(run, { filePath: 'a.ts', diff: '@@ -1 +1,2 @@\n-a\n+b\n+c', ts: 5 });
    pushChange(run, { filePath: 'b.ts', op: 'create' });
    expect(run.changes).toEqual([
      { filePath: 'a.ts', op: 'edit', ts: 5, linesAdded: 2, linesRemoved: 1, diff: '@@ -1 +1,2 @@\n-a\n+b\n+c' },
      { filePath: 'b.ts', op: 'create' },
    ]);
  });

  it('replaces the array instead of editing it (parse states share it)', () => {
    const run = emptyRun();
    pushChange(run, { filePath: 'a.ts' });
    const before = run.changes;
    pushChange(run, { filePath: 'b.ts' });
    expect(before).toHaveLength(1);
    expect(run.changes).toHaveLength(2);
  });

  it('clips a long diff at a line end, marks it truncated and keeps the exact counts', () => {
    const run = emptyRun();
    const lines = Array.from({ length: 20000 }, (_, i) => `+line ${i}`);
    pushChange(run, { filePath: 'big.txt', diff: lines.join('\n') });
    const c = run.changes![0];
    expect(c.truncated).toBe(true);
    expect(c.diff!.length).toBeLessThanOrEqual(MAX_DIFF);
    expect(c.diff!.endsWith('\n')).toBe(false);
    expect(c.linesAdded).toBe(20000);
  });

  it('keeps at most MAX_CHANGES and drops diffs from the oldest past the budget', () => {
    const run = emptyRun();
    const diff = `@@\n+${'x'.repeat(MAX_DIFF - 10)}`;
    const n = Math.ceil(DIFF_BUDGET / MAX_DIFF) + 3;
    for (let i = 0; i < n; i++) pushChange(run, { filePath: `f${i}`, diff });
    const kept = run.changes!.filter((c) => c.diff);
    expect(kept.reduce((s, c) => s + c.diff!.length, 0)).toBeLessThanOrEqual(DIFF_BUDGET);
    expect(run.changes![0]).toMatchObject({ truncated: true, linesAdded: 1 });
    expect(run.changes!.at(-1)!.diff).toBe(diff);
    for (let i = 0; i < MAX_CHANGES; i++) pushChange(run, { filePath: `g${i}` });
    expect(run.changes).toHaveLength(MAX_CHANGES);
    expect(run.droppedChanges).toBe(n);
  });
});

describe('toDetail and code changes', () => {
  // Assembled at runtime so that no realistic-looking secret is ever committed.
  const key = 'sk-' + 'proj-' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z'.repeat(2).slice(0, 48);
  const ref: SessionRef = { agent: 'claude-code', path: '/tmp/run.jsonl', mtimeMs: 1, size: 1 };

  it('masks diffs like event text, and only when masking is on', () => {
    const st = freshState();
    pushChange(st.run, { filePath: '.env', diff: `@@\n-OPENAI_API_KEY=old\n+OPENAI_API_KEY=${key}` });
    const masked = toDetail(ref, st, 2, true);
    expect(masked.changes[0].diff).not.toContain(key);
    expect(masked.changes[0].linesAdded).toBe(1);
    expect(st.run.changes![0].diff).toContain(key); // the parse state is left as read
    expect(toDetail(ref, st, 2, false).changes[0].diff).toContain(key);
  });

  it('reports the total including edits dropped from the front', () => {
    const st = freshState();
    for (let i = 0; i < MAX_CHANGES + 5; i++) pushChange(st.run, { filePath: `f${i}` });
    const d = toDetail(ref, st, 2, false, 10);
    expect(d.changes).toHaveLength(10);
    expect(d.changes.at(-1)!.filePath).toBe(`f${MAX_CHANGES + 4}`);
    expect(d.totalChanges).toBe(MAX_CHANGES + 5);
  });
});
