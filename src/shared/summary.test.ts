import { describe, expect, it } from 'vitest';
import type { RunDetail, RunEvent, RunStatus } from './schema';
import { doingSentence, filesPhrase, localSummary } from './summary';

let seq = 0;
const ev = (e: Partial<RunEvent> & Pick<RunEvent, 'kind'>): RunEvent => ({ seq: seq++, text: '', ...e });

function detail(over: { status?: RunStatus; title?: string; currentTool?: string; events?: RunEvent[]; files?: string[]; edits?: number } = {}): RunDetail {
  const events = over.events ?? [];
  return {
    summary: {
      id: 'claude-code:abc',
      agent: 'claude-code',
      title: over.title ?? 'Add a --due flag to the add command',
      projectName: 'todo-cli',
      startedAt: 0,
      updatedAt: 1,
      status: over.status ?? 'done',
      currentTool: over.currentTool,
      counts: { events: events.length, messages: 0, toolCalls: 0, errors: 0, filesChanged: over.files?.length ?? 0 },
      sourcePath: '/x.jsonl',
    },
    events,
    totalEvents: events.length,
    files: (over.files ?? []).map((path) => ({ path, ops: ['edit'], count: 1 })),
    tools: [],
    changes: [],
    totalChanges: over.edits ?? 0,
  };
}

const bash = () => ev({ kind: 'tool_call', toolName: 'Bash', toolKind: 'run', text: 'npm test' });
const edit = (filePath: string) => ev({ kind: 'tool_call', toolName: 'Edit', toolKind: 'edit', filePath, text: filePath });

describe('localSummary', () => {
  it('describes a running run with its current tool, edits, files and commands', () => {
    const d = detail({
      status: 'running',
      currentTool: 'Edit',
      events: [ev({ kind: 'user', text: 'Add a --due flag' }), bash(), edit('src/commands/add.ts')],
      files: ['src/commands/add.ts', 'src/cli.ts'],
      edits: 3,
    });
    expect(localSummary(d)).toBe(
      'Working on “Add a --due flag to the add command”, now editing add.ts. So far it has made 3 edits to add.ts and cli.ts, and run 1 command.',
    );
  });

  it('uses the past tense and names the last tool for a finished run', () => {
    const d = detail({ status: 'done', events: [edit('a.ts'), bash(), bash()], files: ['a.ts'], edits: 1 });
    expect(localSummary(d)).toBe(
      'Finished “Add a --due flag to the add command”. It made 1 edit to a.ts and ran 2 commands; the last tool it used was Bash.',
    );
  });

  it.each<[RunStatus, string]>([
    ['waiting', 'Waiting for you on “Fix it”.'],
    ['idle', 'Paused after working on “Fix it”.'],
    ['failed', 'Stopped with an error while working on “Fix it”.'],
    ['stuck', 'Seems stuck on “Fix it”: nothing has happened for a while.'],
  ])('%s', (status, first) => {
    expect(localSummary(detail({ status, title: 'Fix it' })).startsWith(first)).toBe(true);
  });

  it('says plainly when nothing happened yet, without counting 0s', () => {
    expect(localSummary(detail({ status: 'running', title: '' }))).toBe('Working on its request. No edits or commands yet.');
    expect(localSummary(detail({ status: 'done', title: '' }))).toBe('Finished. It made no edits and ran no commands.');
  });

  it('counts tool calls when no files changed', () => {
    const d = detail({ status: 'idle', events: [ev({ kind: 'tool_call', toolName: 'Read', toolKind: 'read', text: 'x' })] });
    expect(localSummary(d)).toContain('So far it has made 1 tool call and changed no files; the last tool it used was Read.');
  });

  it('clips a long request and flattens line breaks', () => {
    const s = localSummary(detail({ title: `${'word '.repeat(40)}\nsecond line` }));
    const quote = /“([^”]*)”/.exec(s)![1];
    expect(quote.length).toBeLessThanOrEqual(90);
    expect(quote.endsWith('…')).toBe(true);
    expect(s).not.toContain('\n');
  });

  it('falls back to the tool name for a current tool it has no event for', () => {
    expect(localSummary(detail({ status: 'running', currentTool: 'WebSearch' }))).toContain('now using WebSearch.');
  });

  it('is one sentence for an unreadable run', () => {
    expect(localSummary(detail({ status: 'unreadable' }))).toBe("This run couldn't be read.");
  });
});

describe('doingSentence', () => {
  it('is the first sentence of the summary', () => {
    const d = detail({ status: 'running', currentTool: 'Edit', events: [bash(), edit('src/cli.ts')], edits: 1 });
    expect(doingSentence(d.summary, d.events)).toBe('Working on “Add a --due flag to the add command”, now editing cli.ts.');
    expect(localSummary(d).startsWith(doingSentence(d.summary, d.events))).toBe(true);
  });

  it('works from the summary alone', () => {
    const d = detail({ status: 'running', currentTool: 'Bash' });
    expect(doingSentence(d.summary)).toBe('Working on “Add a --due flag to the add command”, now using Bash.');
    expect(doingSentence(detail({ status: 'running' }).summary)).toBe('Working on “Add a --due flag to the add command”.');
  });
});

describe('filesPhrase', () => {
  it('lists up to three base names, then a count', () => {
    expect(filesPhrase(['a/b.ts'])).toBe('b.ts');
    expect(filesPhrase(['a.ts', 'C:\\x\\b.ts'])).toBe('a.ts and b.ts');
    expect(filesPhrase(['a', 'b', 'c'])).toBe('a, b and c');
    expect(filesPhrase(['a', 'b', 'c', 'd', 'e'])).toBe('a, b and 3 more files');
  });
});
