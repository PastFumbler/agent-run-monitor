import { describe, expect, it } from 'vitest';
import type { CodeChange } from '@shared/schema';
import { changeKeys, changeTotals, diffLines } from './changes';

const ch = (c: Partial<CodeChange>): CodeChange => ({ filePath: 'src/a.ts', op: 'edit', ...c });

describe('changeTotals', () => {
  it('counts distinct files and sums the known line counts', () => {
    const t = changeTotals([
      ch({ linesAdded: 3, linesRemoved: 1 }),
      ch({ linesAdded: 2, linesRemoved: 0 }),
      ch({ filePath: 'src/b.ts', op: 'create', linesAdded: 10, linesRemoved: 0 }),
    ]);
    expect(t).toEqual({ files: 2, edits: 3, added: 15, removed: 1, unknown: 0 });
  });

  it('never counts an unknown line count as 0: it reports how many edits are unknown', () => {
    const t = changeTotals([ch({}), ch({ linesAdded: 4 }), ch({ linesAdded: 1, linesRemoved: 2 })]);
    expect(t).toEqual({ files: 1, edits: 3, added: 5, removed: 2, unknown: 2 });
  });

  it('is all zeros for no changes', () => {
    expect(changeTotals([])).toEqual({ files: 0, edits: 0, added: 0, removed: 0, unknown: 0 });
  });
});

describe('diffLines', () => {
  it('tags hunk headers, added, removed and context lines', () => {
    expect(diffLines('@@ -1,2 +1,2 @@\n keep\n-old\n+new\n')).toEqual([
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'ctx', text: ' keep' },
      { kind: 'del', text: '-old' },
      { kind: 'add', text: '+new' },
    ]);
  });

  it('keeps blank lines inside the diff and handles a bare "@@"', () => {
    expect(diffLines('@@\n+a\n\n+b').map((l) => l.kind)).toEqual(['hunk', 'add', 'ctx', 'add']);
  });
});

describe('changeKeys', () => {
  it('is unique and stable when older edits drop off the front', () => {
    const list = [ch({ ts: 1, toolCallId: 't1' }), ch({ ts: 2, toolCallId: 't2' }), ch({ ts: 2, toolCallId: 't2' })];
    const keys = changeKeys(list);
    expect(new Set(keys).size).toBe(3);
    expect(changeKeys(list.slice(1))).toEqual(keys.slice(1));
  });
});
