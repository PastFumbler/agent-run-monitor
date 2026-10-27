import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env, ParseState, SessionRef, SourceAdapter } from '../../adapter';
import { safeParse, toDetail, toSummary } from '../../build';
import { judgeStatus } from '../../status';
import { adapters, geminiAdapter, NO_RECORDS, qwenAdapter } from './index';

const FIX = fileURLToPath(new URL('../../../../test/fixtures/gemini/', import.meta.url));
const GEMINI_HOME = join(FIX, 'gemini-home');
const QWEN_HOME = join(FIX, 'qwen-home');
const G_CHATS = join(GEMINI_HOME, '.gemini', 'tmp', 'todo-cli', 'chats');
const G_MAIN = join(G_CHATS, 'session-2026-10-20T14-03-5b2c9e1a.jsonl');
const G_SUB = join(G_CHATS, '5b2c9e1a-7d4f-4c1e-9a3b-2f6e8d0c1a57', 'codebase_investigator-9f8e7d6c.jsonl');
const G_LEGACY = join(
  GEMINI_HOME,
  '.gemini',
  'tmp',
  'a14d6866747dfc823c713ea499f7277d333df6762e11eb27727d4ff7f1e87b8d',
  'chats',
  'session-2025-09-02T09-15-a1b2c3d4.json',
);
const Q_PROJECT = join(QWEN_HOME, '.qwen', 'projects', '-home-alex-src-todo-cli');
const Q_MAIN = join(Q_PROJECT, 'chats', '0c9d8e7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f.jsonl');
const Q_SUB = join(Q_PROJECT, 'subagents', '0c9d8e7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f', 'agent-explore-7f3c.jsonl');
const PROJECT = '/home/alex/src/todo-cli';

// Temp-folder I/O can be slow under on-access virus scanning.
vi.setConfig({ testTimeout: 30_000 });

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'arm-gemini-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const env = (home: string, vars: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): Env => ({
  platform,
  home,
  vars,
});
const ctx = () => ({ env: env(tmp), tempDir: tmp });

async function refFor(adapter: SourceAdapter, path: string, hint?: Record<string, string>): Promise<SessionRef> {
  const st = await stat(path);
  return { agent: adapter.id, path, mtimeMs: st.mtimeMs, size: st.size, hint };
}

async function parse(adapter: SourceAdapter, path: string, hint?: Record<string, string>, prev?: ParseState) {
  const ref = await refFor(adapter, path, hint);
  return { ref, st: await safeParse(adapter, ref, prev, ctx()) };
}

function kinds(st: ParseState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of st.run.events) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

let n = 0;
async function tmpFile(name: string, content: string | Buffer): Promise<string> {
  const dir = join(tmp, `f${n++}`);
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, content);
  return p;
}

describe('gemini family: adapters', () => {
  it('exports both adapters with honest confidence', () => {
    expect(adapters.map((a) => a.id)).toEqual(['gemini-cli', 'qwen-code']);
    for (const a of adapters) {
      expect(a.confidence).toBe('source');
      expect(a.note).toMatch(/not a real install/);
    }
  });
});

describe('gemini family: defaultRoots', () => {
  it('Gemini: ~/.gemini per OS, GEMINI_CLI_HOME replaces the home, macOS adds the Seatbelt dir', () => {
    expect(geminiAdapter.defaultRoots(env('/home/alex', {}, 'linux'))).toEqual(['/home/alex/.gemini']);
    expect(geminiAdapter.defaultRoots(env('C:\\Users\\alex', {}, 'win32'))).toEqual(['C:\\Users\\alex\\.gemini']);
    expect(geminiAdapter.defaultRoots(env('/Users/alex', {}, 'darwin'))).toEqual([
      '/Users/alex/.gemini',
      '/Users/alex/.cache/.gemini',
    ]);
    expect(geminiAdapter.defaultRoots(env('/home/alex', { GEMINI_CLI_HOME: '/srv/g' }, 'linux'))).toEqual(['/srv/g/.gemini']);
  });

  it('Qwen: QWEN_HOME (with ~) and QWEN_RUNTIME_DIR', () => {
    expect(qwenAdapter.defaultRoots(env('/home/alex', {}, 'linux'))).toEqual(['/home/alex/.qwen']);
    expect(qwenAdapter.defaultRoots(env('C:\\Users\\alex', {}, 'win32'))).toEqual(['C:\\Users\\alex\\.qwen']);
    expect(qwenAdapter.defaultRoots(env('/Users/alex', { QWEN_HOME: '~/cfg/qwen', QWEN_RUNTIME_DIR: '/var/qwen' }, 'darwin'))).toEqual([
      '/Users/alex/cfg/qwen',
      '/var/qwen',
    ]);
  });
});

describe('gemini family: discover', () => {
  it('finds Gemini sessions, subagents and legacy files, and maps project folders', async () => {
    const home = join(tmp, 'ghome');
    await cp(GEMINI_HOME, home, { recursive: true });
    const roots = geminiAdapter.defaultRoots(env(home));
    const refs = await geminiAdapter.discover(roots, { env: env(home), since: 0, projectRoots: [] });
    const by = (end: string) => refs.find((r) => r.path.endsWith(end))!;
    expect(refs).toHaveLength(4);
    expect(refs.every((r) => r.agent === 'gemini-cli' && r.size > 0)).toBe(true);

    const main = by('session-2026-10-20T14-03-5b2c9e1a.jsonl');
    expect(main.hint).toEqual({ project: 'todo-cli', projectPath: PROJECT });
    // Subagent sessions sit in a folder named after the parent's full session id.
    expect(by('codebase_investigator-9f8e7d6c.jsonl').hint?.parentPath).toBe(main.path);
    // Legacy sha256 folder resolved through projects.json.
    expect(by('session-2025-09-02T09-15-a1b2c3d4.json').hint).toEqual({ project: 'todo-cli', projectPath: PROJECT });
    // Unresolvable hash folder: shortened hash.
    expect(by('session-2025-08-30T10-00-c0ffee01.json').hint).toEqual({ project: 'c0ffee00' });
    // logs.json, .project_root and projects.json are not sessions.
    expect(refs.some((r) => /logs\.json$|project/.test(r.path.split(/[\\/]/).pop()!))).toBe(false);

    // since: an old file drops out.
    await utimes(main.path, new Date('2026-01-01'), new Date('2026-01-01'));
    const recent = await geminiAdapter.discover(roots, { env: env(home), since: Date.parse('2026-06-01'), projectRoots: [] });
    expect(recent.some((r) => r.path === main.path)).toBe(false);
  });

  it('prefers a migrated .jsonl over its legacy .json twin', async () => {
    const chats = join(tmp, 'twin', '.gemini', 'tmp', 'proj', 'chats');
    await mkdir(chats, { recursive: true });
    await writeFile(join(chats, 'session-2026-01-01T00-00-abcdef12.json'), '{}');
    await writeFile(join(chats, 'session-2026-01-01T00-00-abcdef12.jsonl'), '{}\n');
    const refs = await geminiAdapter.discover([join(tmp, 'twin', '.gemini')], { env: env(tmp), since: 0, projectRoots: [] });
    expect(refs.map((r) => r.path.slice(-6))).toEqual(['.jsonl']);
    expect(refs[0].hint).toEqual({ project: 'proj' });
  });

  it('finds Qwen sessions and subagents, skips sidecars, follows runtimeOutputDir', async () => {
    const home = join(tmp, 'qhome');
    await cp(QWEN_HOME, home, { recursive: true });
    const moved = join(tmp, 'qmoved');
    await mkdir(join(moved, 'projects', 'p1', 'chats'), { recursive: true });
    await cp(join(FIX, 'qwen-running.jsonl'), join(moved, 'projects', 'p1', 'chats', '5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716.jsonl'));
    await writeFile(join(home, '.qwen', 'settings.json'), JSON.stringify({ advanced: { runtimeOutputDir: moved } }));

    const roots = qwenAdapter.defaultRoots(env(home));
    const refs = await qwenAdapter.discover(roots, { env: env(home), since: 0, projectRoots: [] });
    expect(refs).toHaveLength(3);
    expect(refs.every((r) => r.agent === 'qwen-code' && r.path.endsWith('.jsonl'))).toBe(true);
    const main = refs.find((r) => r.path.endsWith('0c9d8e7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f.jsonl') && r.path.includes('chats'))!;
    expect(main.hint).toEqual({ project: '-home-alex-src-todo-cli' });
    const sub = refs.find((r) => r.path.endsWith('agent-explore-7f3c.jsonl'))!;
    expect(sub.hint?.parentPath).toBe(main.path);
  });

  it('returns [] for missing roots and never throws', async () => {
    const missing = [join(tmp, 'nope'), join(tmp, 'nope2', 'chats')];
    await expect(geminiAdapter.discover(missing, { env: env(tmp), since: 0, projectRoots: [] })).resolves.toEqual([]);
    await expect(qwenAdapter.discover(missing, { env: env(tmp), since: 0, projectRoots: [] })).resolves.toEqual([]);
  });
});

describe('gemini family: parse Gemini CLI', () => {
  it('reduces the snapshot/patch log of the main session', async () => {
    const { st } = await parse(geminiAdapter, G_MAIN, { project: 'todo-cli', projectPath: PROJECT });
    const r = st.run;
    expect(r.readError).toBeUndefined();
    expect(r.title).toBe('Add a `done` command to todo-cli that marks a task as complete by its id.');
    expect(r.projectName).toBe('todo-cli');
    expect(r.projectPath).toBe(PROJECT);
    expect(r.model).toBe('gemini-2.5-pro');
    expect(r.gitBranch).toBeUndefined(); // Gemini records no branch
    // Re-appended messages count once; the rewound prompt is gone; functionResponse echoes are not user turns.
    expect(kinds(st)).toEqual({ user: 2, reasoning: 3, assistant: 4, tool_call: 5, tool_result: 5, file_change: 2, error: 1 });
    expect(r.events.some((e) => e.text.includes('colour the output'))).toBe(false);
    expect(r.tally).toEqual({ events: 22, messages: 6, toolCalls: 5, errors: 2 });
    expect(r.files).toEqual({
      '/home/alex/src/todo-cli/todo/cli.py': { ops: ['edit'], count: 1, lastTs: Date.parse('2026-10-20T14:03:23.666Z') },
      '/home/alex/src/todo-cli/tests/test_done.py': { ops: ['create'], count: 1, lastTs: Date.parse('2026-10-20T14:03:33.753Z') },
    });
    // Summed over unique messages: the cached part of the input is reported apart; thoughts count as output.
    const cached = 8064 + 9024 + 9024 + 9600 + 9600;
    expect(r.usage).toMatchObject({
      input: 8412 + 9120 + 9518 + 9702 + 9990 + 10204 - cached,
      cacheRead: cached,
      output: 38 + 210 + 27 + 188 + 41 + 61 + 112 + 64 + 96,
    });
    expect(r.usage!.cacheWrite).toBeUndefined(); // Gemini records no cache writes
    expect(r.events.filter((e) => e.usage)).toHaveLength(6); // one per model message
    // Both successful edits, with the FileDiff hunks (file headers dropped).
    expect(r.changes!.map((c) => [c.filePath, c.op, c.linesAdded, c.linesRemoved])).toEqual([
      ['/home/alex/src/todo-cli/todo/cli.py', 'edit', 2, 0],
      ['/home/alex/src/todo-cli/tests/test_done.py', 'create', 7, 0],
    ]);
    expect(r.changes![0].diff!.split('\n')[0]).toBe('@@ -5,4 +5,6 @@');
    expect(r.hasReasoning).toBe(true);
    expect(r.turn).toBe('error');
    expect(r.turnDetail).toBe('API Error: 503 The model is overloaded. Please try again later.');
    expect(r.openTool).toBeUndefined();
    expect(r.startedAt).toBe(Date.parse('2026-10-20T14:03:11.204Z'));
    expect(r.lastEventAt).toBe(Date.parse('2026-10-20T14:04:53.037Z'));
    expect(r.skipped).toBe(0);
  });

  it('pairs tool calls with results by id', async () => {
    const { ref, st } = await parse(geminiAdapter, G_MAIN, { project: 'todo-cli', projectPath: PROJECT });
    const calls = st.run.events.filter((e) => e.kind === 'tool_call');
    const results = st.run.events.filter((e) => e.kind === 'tool_result');
    expect(calls.map((e) => e.toolCallId)).toEqual(results.map((e) => e.toolCallId));
    expect(calls.map((e) => [e.toolName, e.toolKind])).toEqual([
      ['read_file', 'read'],
      ['replace', 'edit'],
      ['read_file', 'read'],
      ['write_file', 'edit'],
      ['run_shell_command', 'run'],
    ]);
    expect(calls[4].text).toBe('python -m pytest -q');
    expect(results.map((e) => !!e.isError)).toEqual([false, false, true, false, false]);
    expect(results[1].text).toContain('+    done = sub.add_parser("done")');

    const detail = toDetail(ref, st, Date.parse('2026-10-21T00:00:00Z'), false);
    expect(detail.tools).toHaveLength(5);
    expect(detail.tools.every((t) => !t.open && t.output !== undefined)).toBe(true);
    expect(detail.tools[0].durationMs).toBe(Date.parse('2026-10-20T14:03:17.220Z') - Date.parse('2026-10-20T14:03:16.907Z'));
    expect(detail.files.map((f) => f.path).sort()).toEqual([
      '/home/alex/src/todo-cli/tests/test_done.py',
      '/home/alex/src/todo-cli/todo/cli.py',
    ]);
  });

  it('parses a subagent session with its parent and directories', async () => {
    const { st } = await parse(geminiAdapter, G_SUB, { project: 'todo-cli', parentPath: G_MAIN });
    const r = st.run;
    expect(r.title).toBe('Find where tasks are persisted in todo-cli.');
    expect(r.projectPath).toBe(PROJECT); // from `directories`
    expect(r.model).toBe('gemini-2.5-flash');
    expect(r.parentPath).toBe(G_MAIN);
    expect(kinds(st)).toEqual({ user: 1, assistant: 1 });
    expect(r.turn).toBe('completed');
    expect(r.usage).toMatchObject({ input: 3011, cacheRead: 0, output: 19 });
  });

  it('parses the legacy single-JSON format', async () => {
    const { st } = await parse(geminiAdapter, G_LEGACY, { project: 'todo-cli', projectPath: PROJECT });
    const r = st.run;
    expect(r.title).toBe('List the files in this project.');
    expect(r.model).toBe('gemini-2.5-pro');
    expect(kinds(st)).toEqual({ user: 1, reasoning: 1, tool_call: 1, tool_result: 1, assistant: 1 });
    const call = r.events.find((e) => e.kind === 'tool_call')!;
    expect([call.toolName, call.toolKind, call.text, call.filePath]).toEqual(['list_directory', 'search', PROJECT, PROJECT]);
    expect(r.events.find((e) => e.kind === 'tool_result')!.text).toBe('Listed 4 item(s).');
    expect(r.turn).toBe('completed');
    expect(r.usage).toMatchObject({ input: 5120 + 5230, cacheRead: 0, output: 12 + 40 + 24 });
  });

  it('reads legacy Qwen messages typed "qwen" in a hash folder', async () => {
    const p = join(GEMINI_HOME, '.gemini', 'tmp', 'c0ffee00000000000000000000000000000000000000000000000000000000ab', 'chats', 'session-2025-08-30T10-00-c0ffee01.json');
    const { st } = await parse(geminiAdapter, p, { project: 'c0ffee00' });
    expect(st.run.projectName).toBe('c0ffee00');
    expect(st.run.model).toBe('qwen3-coder-plus');
    expect(kinds(st)).toEqual({ user: 1, assistant: 1 });
    expect(st.run.turn).toBe('completed');
  });

  it('re-reads a legacy file only when it changed', async () => {
    const p = await tmpFile('session-2025-09-02T09-15-a1b2c3d4.json', await readFile(G_LEGACY));
    const first = await parse(geminiAdapter, p);
    const again = await parse(geminiAdapter, p, undefined, first.st);
    expect(again.st).toBe(first.st);
  });

  it('marks an empty model message with no recorded tool calls as a running tool', async () => {
    const { st } = await parse(geminiAdapter, join(FIX, 'gemini-running.jsonl'));
    expect(st.run.turn).toBe('in_progress');
    expect(st.run.openTool).toEqual({ name: 'a tool', kind: 'other', since: Date.parse('2026-10-22T10:00:04.000Z') });
    expect(st.run.projectName).toBe('Unknown project');
  });
});

describe('gemini family: parse Qwen Code', () => {
  it('parses the main session', async () => {
    const { st } = await parse(qwenAdapter, Q_MAIN, { project: '-home-alex-src-todo-cli' });
    const r = st.run;
    expect(r.readError).toBeUndefined();
    expect(r.title).toBe('Add a `done` command to todo-cli that marks a task as complete by its id.');
    expect(r.projectName).toBe('todo-cli'); // from cwd, not the lossy folder name
    expect(r.projectPath).toBe(PROJECT);
    expect(r.gitBranch).toBe('main');
    expect(r.model).toBe('qwen3-coder-plus');
    expect(kinds(st)).toEqual({ user: 2, reasoning: 1, assistant: 3, tool_call: 3, tool_result: 3, file_change: 1, error: 1 });
    expect(r.tally).toEqual({ events: 14, messages: 5, toolCalls: 3, errors: 2 });
    expect(Object.keys(r.files)).toEqual(['/home/alex/src/todo-cli/todo/cli.py']);
    expect(r.files['/home/alex/src/todo-cli/todo/cli.py'].ops).toEqual(['edit']);
    const cached = 11008 + 11520 + 11776;
    expect(r.usage).toMatchObject({ input: 11234 + 11502 + 11790 + 12010 - cached, cacheRead: cached, output: 61 + 24 + 118 + 52 + 37 });
    expect(r.changes!.map((c) => [c.filePath, c.op, c.linesAdded !== undefined])).toEqual([['/home/alex/src/todo-cli/todo/cli.py', 'edit', true]]);
    expect(r.turn).toBe('error');
    expect(r.turnDetail).toBe('429 Rate limit exceeded, please retry later.');
    expect(r.openTool).toBeUndefined();
    expect(r.skipped).toBe(0);
    expect(r.startedAt).toBe(Date.parse('2026-10-21T08:30:04.011Z'));
  });

  it('pairs tool calls and results by callId', async () => {
    const { st } = await parse(qwenAdapter, Q_MAIN);
    const calls = st.run.events.filter((e) => e.kind === 'tool_call');
    const results = st.run.events.filter((e) => e.kind === 'tool_result');
    expect(calls.map((e) => e.toolCallId)).toEqual([
      'call_7f1e2d3c4b5a69788796a5b4',
      'call_8a2f3e4d5c6b7a8998a7b6c5',
      'call_9b3a4f5e6d7c8b9aa9b8c7d6',
    ]);
    expect(results.map((e) => e.toolCallId)).toEqual(calls.map((e) => e.toolCallId));
    expect(calls.map((e) => e.toolKind)).toEqual(['read', 'edit', 'run']);
    expect(results.map((e) => !!e.isError)).toEqual([false, false, true]);
    expect(results[2].text).toBe('..F\n1 failed, 2 passed in 0.31s');
  });

  it('parses a subagent transcript', async () => {
    const parentPath = Q_MAIN;
    const { st } = await parse(qwenAdapter, Q_SUB, { project: '-home-alex-src-todo-cli', parentPath });
    expect(st.run.title).toBe('Find where tasks are persisted in todo-cli.');
    expect(st.run.parentPath).toBe(parentPath);
    expect(st.run.turn).toBe('completed');
    expect(kinds(st)).toEqual({ user: 1, assistant: 1 });
  });

  it('keeps an unanswered call open and asks for input on ask_user_question', async () => {
    const { st } = await parse(qwenAdapter, join(FIX, 'qwen-running.jsonl'));
    expect(st.run.turn).toBe('in_progress');
    expect(st.run.gitBranch).toBe('feature/done');
    expect(st.run.openTool).toEqual({ name: 'run_shell_command', kind: 'run', since: Date.parse('2026-10-22T11:00:03.000Z') });

    const text = (await readFile(join(FIX, 'qwen-running.jsonl'), 'utf8')).replace(/run_shell_command/g, 'ask_user_question');
    const p = await tmpFile('5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716.jsonl', text);
    const asked = await parse(qwenAdapter, p);
    expect(asked.st.run.turn).toBe('waiting_input');
  });
});

describe('gemini family: bad input', () => {
  it('Gemini corrupt file: skips the garbage line, keeps good records, leaves the cut-off tail', async () => {
    const p = join(FIX, 'gemini-corrupt.jsonl');
    const { st } = await parse(geminiAdapter, p);
    expect(st.run.readError).toBeUndefined();
    expect(st.extra.bad).toBe(1);
    expect(st.run.skipped).toBe(1);
    expect(kinds(st)).toEqual({ user: 1, reasoning: 1, assistant: 1, tool_call: 2, tool_result: 2, file_change: 1 });
    expect(st.run.turn).toBe('in_progress');
    expect(st.offset).toBeLessThan(st.size); // the half-written last line waits for more bytes
  });

  it('Qwen corrupt file: skips the NUL-prefixed line, keeps good records', async () => {
    const { st } = await parse(qwenAdapter, join(FIX, 'qwen-corrupt.jsonl'));
    expect(st.run.readError).toBeUndefined();
    expect(st.extra.bad).toBe(1);
    expect(st.run.skipped).toBe(1);
    expect(kinds(st)).toEqual({ user: 1, reasoning: 1, assistant: 2, tool_call: 3, tool_result: 3, file_change: 1 });
    expect(st.offset).toBeLessThan(st.size);
  });

  it('files with only unknown records get a readError, not a throw', async () => {
    for (const [adapter, file] of [
      [geminiAdapter, 'unknown-records.jsonl'],
      [qwenAdapter, 'unknown-records.jsonl'],
      [qwenAdapter, 'qwen-unknown-records.jsonl'],
    ] as const) {
      const { ref, st } = await parse(adapter, join(FIX, file));
      expect(st.run.readError).toBe(NO_RECORDS);
      expect(st.run.skipped).toBeGreaterThan(0);
      expect(toSummary(ref, st, Date.now(), true).status).toBe('unreadable');
    }
  });

  it('an invalid legacy JSON file becomes an unreadable run', async () => {
    const text = await readFile(G_LEGACY, 'utf8');
    const p = await tmpFile('session-2025-09-02T09-15-a1b2c3d4.json', text.slice(0, 300));
    const { st } = await parse(geminiAdapter, p, { project: 'todo-cli' });
    expect(st.run.readError).toMatch(/valid JSON/);
    expect(st.run.projectName).toBe('todo-cli');
  });

  it('a missing file becomes an unreadable run', async () => {
    const ref: SessionRef = { agent: 'qwen-code', path: join(tmp, 'gone.jsonl'), mtimeMs: 0, size: 0 };
    const st = await safeParse(qwenAdapter, ref, undefined, ctx());
    expect(st.run.readError).toMatch(/gone/);
  });

  it('an empty file is not an error', async () => {
    const p = await tmpFile('00000000-0000-4000-8000-000000000000.jsonl', '');
    const { st } = await parse(qwenAdapter, p);
    expect(st.run.readError).toBeUndefined();
    expect(st.run.turn).toBe('unknown');
  });
});

describe('gemini family: incremental parsing', () => {
  const comparable = (st: ParseState) => ({
    events: st.run.events,
    tally: st.run.tally,
    files: st.run.files,
    turn: st.run.turn,
    turnDetail: st.run.turnDetail,
    title: st.run.title,
    model: st.run.model,
    usage: st.run.usage,
    changes: st.run.changes,
    openTool: st.run.openTool,
    skipped: st.run.skipped,
  });

  for (const [label, adapter, source] of [
    ['Gemini', geminiAdapter, G_MAIN],
    ['Qwen', qwenAdapter, Q_MAIN],
  ] as const) {
    it(`${label}: appending in pieces (split mid-line) equals one full parse`, async () => {
      const full = await readFile(source);
      const p = await tmpFile('6a6a6a6a-0000-4000-8000-000000000000.jsonl', Buffer.alloc(0));
      const cuts = [Math.floor(full.length * 0.3), Math.floor(full.length * 0.55), full.length];
      let prev: ParseState | undefined;
      let at = 0;
      for (const cut of cuts) {
        await appendFile(p, full.subarray(at, cut));
        at = cut;
        prev = (await parse(adapter, p, { project: 'todo-cli', projectPath: PROJECT }, prev)).st;
        expect(prev.run.readError).toBeUndefined();
      }
      const once = await parse(adapter, source, { project: 'todo-cli', projectPath: PROJECT });
      expect(comparable(prev!)).toEqual(comparable(once.st));
      expect(prev!.offset).toBe(full.length);

      // Unchanged file: the previous state comes back as is.
      const same = await parse(adapter, p, { project: 'todo-cli', projectPath: PROJECT }, prev);
      expect(same.st).toBe(prev);
    });

    it(`${label}: a file that shrank is re-read from the start`, async () => {
      const full = await readFile(source);
      const p = await tmpFile('7b7b7b7b-0000-4000-8000-000000000000.jsonl', full);
      const big = (await parse(adapter, p)).st;
      const lines = full.toString('utf8').split('\n');
      const short = `${lines.slice(0, 4).join('\n')}\n`;
      await writeFile(p, short);
      const after = (await parse(adapter, p, undefined, big)).st;
      const fresh = (await parse(adapter, p)).st;
      expect(comparable(after)).toEqual(comparable(fresh));
      expect(after.run.tally.events).toBeLessThan(big.run.tally.events);
    });
  }

  it('does not mutate the previous state', async () => {
    const full = await readFile(Q_MAIN);
    const p = await tmpFile('8c8c8c8c-0000-4000-8000-000000000000.jsonl', full.subarray(0, Math.floor(full.length / 2)));
    const first = (await parse(qwenAdapter, p)).st;
    const snapshot = structuredClone(first);
    await appendFile(p, full.subarray(Math.floor(full.length / 2)));
    await parse(qwenAdapter, p, undefined, first);
    expect(first).toEqual(snapshot);
  });
});

describe('gemini family: status', () => {
  const MIN = 60_000;

  it('in-progress fixtures read running', async () => {
    for (const [adapter, file, tool] of [
      [geminiAdapter, 'gemini-running.jsonl', 'a tool'],
      [qwenAdapter, 'qwen-running.jsonl', 'run_shell_command'],
    ] as const) {
      const { ref, st } = await parse(adapter, join(FIX, file));
      const last = st.run.lastEventAt!;
      expect(judgeStatus(st.run, last, last + 30_000).status).toBe('running');
      const s = toSummary({ ...ref, mtimeMs: last }, st, last + 30_000, false);
      expect(s.status).toBe('running');
      expect(s.currentTool).toBe(tool);
    }
  });

  it('finished fixtures read idle, then done', async () => {
    for (const [adapter, path] of [
      [geminiAdapter, G_LEGACY],
      [geminiAdapter, G_SUB],
      [qwenAdapter, Q_SUB],
    ] as const) {
      const { st } = await parse(adapter, path);
      const last = st.run.lastEventAt!;
      expect(judgeStatus(st.run, last, last + MIN).status).toBe('idle');
      expect(judgeStatus(st.run, last, last + 10 * MIN).status).toBe('done');
    }
  });

  it('a turn that ended in an API error reads failed', async () => {
    for (const [adapter, path] of [
      [geminiAdapter, G_MAIN],
      [qwenAdapter, Q_MAIN],
    ] as const) {
      const { st } = await parse(adapter, path);
      const j = judgeStatus(st.run, st.run.lastEventAt!, st.run.lastEventAt! + MIN);
      expect(j.status).toBe('failed');
      expect(j.detail).toMatch(/503|429/);
    }
  });
});

describe('gemini family: review fixes', () => {
  const MIN = 60_000;
  const T = (s: number) => new Date(Date.parse('2026-10-23T09:00:00.000Z') + s * 1000).toISOString();
  const at = (s: number) => Date.parse(T(s));
  const jsonl = (recs: unknown[]) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`;
  const gMeta = { sessionId: '9a9a9a9a-0000-4000-8000-000000000000', projectHash: 'x', startTime: T(0), lastUpdated: T(0) };
  const gUser = (id: string, s: number, text: string) => ({ id, timestamp: T(s), type: 'user', content: [{ text }] });
  const qRec = (n: number, s: number, rest: Record<string, unknown>) => ({
    uuid: `q${n}`,
    parentUuid: n > 1 ? `q${n - 1}` : null,
    sessionId: '9b9b9b9b-0000-4000-8000-000000000000',
    timestamp: T(s),
    cwd: '/home/alex/src/todo-cli',
    version: '0.26.1',
    ...rest,
  });
  const qUser = (n: number, s: number, text: string) =>
    qRec(n, s, { type: 'user', provenance: 'real_user', message: { role: 'user', parts: [{ text }] } });
  const qCall = (n: number, s: number, id: string | undefined, name: string, args: unknown = {}) =>
    qRec(n, s, { type: 'assistant', model: 'qwen3-coder-plus', message: { role: 'model', parts: [{ functionCall: { id, name, args } }] } });
  const qText = (n: number, s: number, text: string) =>
    qRec(n, s, { type: 'assistant', model: 'qwen3-coder-plus', message: { role: 'model', parts: [{ text }] } });
  const qResult = (n: number, s: number, id: string | undefined, name: string, status: string) =>
    qRec(n, s, {
      type: 'tool_result',
      message: { role: 'user', parts: [{ functionResponse: { id, name, response: { output: 'ok' } } }] },
      toolCallResult: { callId: id, status },
    });
  const qTelemetry = (n: number, s: number, name: string, extra: Record<string, unknown> = {}) =>
    qRec(n, s, { type: 'system', subtype: 'ui_telemetry', systemPayload: { uiEvent: { 'event.name': name, ...extra } } });

  it('Gemini: a cancelled tool answered by a trailing functionResponse ends the turn (aborted, not running)', async () => {
    const resp = { functionResponse: { id: 'c1', name: 'run_shell_command', response: { error: 'cancelled' } } };
    const p = await tmpFile(
      'session-2026-10-23T09-00-9a9a9a9a.jsonl',
      jsonl([
        gMeta,
        gUser('u1', 1, 'Delete the build folder.'),
        {
          id: 'g1',
          timestamp: T(2),
          type: 'gemini',
          content: '',
          model: 'gemini-2.5-pro',
          toolCalls: [{ id: 'c1', name: 'run_shell_command', args: { command: 'rm -rf build' }, status: 'cancelled', timestamp: T(9), result: [resp] }],
        },
        { id: 'u2', timestamp: T(9), type: 'user', content: [resp] },
      ]),
    );
    const { st } = await parse(geminiAdapter, p);
    expect(st.run.turn).toBe('aborted');
    expect(st.run.openTool).toBeUndefined();
    expect(judgeStatus(st.run, at(9), at(9) + MIN).status).toBe('idle');
    expect(judgeStatus(st.run, at(9), at(9) + 10 * MIN).status).toBe('done');
  });

  it('Gemini: "Request cancelled." after a prompt reads interrupted, not failed', async () => {
    const p = await tmpFile(
      'session-2026-10-23T09-00-9a9a9a9b.jsonl',
      jsonl([gMeta, gUser('u1', 1, 'Explain main.py'), { id: 'i1', timestamp: T(4), type: 'info', content: 'Request cancelled.' }]),
    );
    const { st } = await parse(geminiAdapter, p);
    expect(st.run.turn).toBe('aborted');
    expect(judgeStatus(st.run, at(4), at(4) + MIN).status).toBe('idle');
  });

  it('Gemini: a functionCall part that lost its response does not stay open after the model moves on', async () => {
    // History sync writes content as Part[] with functionCall parts; masking may drop the response.
    const call = { functionCall: { id: 'c9', name: 'read_file', args: { file_path: 'README.md' } } };
    const p = await tmpFile(
      'session-2026-10-23T09-00-9a9a9a9c.jsonl',
      jsonl([
        gMeta,
        gUser('u1', 1, 'Read the readme.'),
        { id: 'g1', timestamp: T(2), type: 'gemini', content: [call] },
        { id: 'g2', timestamp: T(5), type: 'gemini', content: 'The readme describes a todo app.' },
      ]),
    );
    const { st } = await parse(geminiAdapter, p);
    expect(st.run.turn).toBe('completed');
    expect(st.run.openTool).toBeUndefined();

    // ...but a call in the LAST model message with no response is open.
    const q = await tmpFile(
      'session-2026-10-23T09-00-9a9a9a9d.jsonl',
      jsonl([gMeta, gUser('u1', 1, 'Read the readme.'), { id: 'g1', timestamp: T(2), type: 'gemini', content: [call] }]),
    );
    const open = await parse(geminiAdapter, q);
    expect(open.st.run.turn).toBe('in_progress');
    expect(open.st.run.openTool).toMatchObject({ name: 'read_file', kind: 'read' });
  });

  it('Gemini: odd message ids (constructor, __proto__) do not corrupt the reducer', async () => {
    const p = await tmpFile(
      'session-2026-10-23T09-00-9a9a9a9e.jsonl',
      jsonl([
        gMeta,
        gUser('constructor', 1, 'First prompt.'),
        gUser('__proto__', 2, 'Ignored.'),
        { id: 'g1', timestamp: T(3), type: 'gemini', content: 'Done.' },
      ]),
    );
    const { st } = await parse(geminiAdapter, p);
    expect(st.run.title).toBe('First prompt.');
    expect(st.run.events.map((e) => e.kind)).toEqual(['user', 'assistant']);
    expect(st.run.turn).toBe('completed');
  });

  it('Gemini: the reduced state kept between parses drops whole-file snapshots and clips tool args', async () => {
    const big = 'x'.repeat(200_000);
    const file = '/home/alex/src/todo-cli/data.txt';
    const p = await tmpFile(
      'session-2026-10-23T09-00-9a9a9a9f.jsonl',
      jsonl([
        gMeta,
        gUser('u1', 1, 'Write the data file.'),
        {
          id: 'g1',
          timestamp: T(2),
          type: 'gemini',
          content: '',
          toolCalls: [
            {
              id: 'w1',
              name: 'write_file',
              args: { file_path: file, content: big },
              status: 'success',
              timestamp: T(3),
              resultDisplay: { fileDiff: '+x', fileName: 'data.txt', filePath: file, originalContent: big, newContent: big },
            },
          ],
        },
      ]),
    );
    const { st } = await parse(geminiAdapter, p);
    expect(JSON.stringify(st.extra).length).toBeLessThan(10_000);
    expect(st.run.files[file].ops).toEqual(['edit']);
    expect(st.run.events.find((e) => e.kind === 'tool_call')!.text).toBe(file);
  });

  it('Qwen: an API error that a retry got past does not fail the turn; a final one does', async () => {
    const recs = [
      qUser(1, 1, 'Summarise the repo.'),
      qTelemetry(2, 3, 'qwen-code.api_error', { error_message: '429 Too Many Requests' }),
      qTelemetry(3, 8, 'qwen-code.api_response', { status_code: 200 }),
    ];
    const p = await tmpFile('9b9b9b9b-0000-4000-8000-000000000001.jsonl', jsonl(recs));
    const { st } = await parse(qwenAdapter, p);
    expect(st.run.turn).toBe('in_progress');
    expect(st.run.tally.errors).toBe(1); // the failed attempt is still shown

    const more = [qText(4, 9, 'It is a todo app.'), qUser(5, 20, 'More detail.'), qTelemetry(6, 21, 'qwen-code.api_error', { error_message: '500 boom' })];
    const q = await tmpFile('9b9b9b9b-0000-4000-8000-000000000002.jsonl', jsonl([...recs, ...more]));
    const failed = await parse(qwenAdapter, q);
    expect(failed.st.run.turn).toBe('error');
    const j = judgeStatus(failed.st.run, at(21), at(21) + MIN);
    expect([j.status, j.detail]).toEqual(['failed', 'API error: 500 boom']);
  });

  it('Qwen: calls left open by a crashed process are dropped by the next prompt or reply', async () => {
    const p = await tmpFile(
      '9b9b9b9b-0000-4000-8000-000000000003.jsonl',
      jsonl([
        qUser(1, 1, 'Run the tests.'),
        qCall(2, 2, 'call_dead', 'run_shell_command', { command: 'pytest' }),
        // the CLI died here; the session was resumed later
        qUser(3, 600, 'Just tell me what the tests cover.'),
        qText(4, 605, 'They cover add, list and done.'),
      ]),
    );
    const { st } = await parse(qwenAdapter, p);
    expect(st.run.turn).toBe('completed');
    expect(st.run.openTool).toBeUndefined();
  });

  it('Qwen: a cancelled tool reads interrupted, and a later model call clears it', async () => {
    const base = [
      qUser(1, 1, 'Delete build/.'),
      qCall(2, 2, 'c1', 'run_shell_command', { command: 'rm -rf build' }),
      qResult(3, 5, 'c1', 'run_shell_command', 'cancelled'),
    ];
    const p = await tmpFile('9b9b9b9b-0000-4000-8000-000000000004.jsonl', jsonl(base));
    const { st } = await parse(qwenAdapter, p);
    expect(st.run.turn).toBe('aborted');
    expect(judgeStatus(st.run, at(5), at(5) + MIN).status).toBe('idle');

    const later = [qCall(4, 6, 'c2', 'list_directory', { path: 'build' }), qResult(5, 7, 'c2', 'list_directory', 'success')];
    const q = await tmpFile('9b9b9b9b-0000-4000-8000-000000000005.jsonl', jsonl([...base, ...later]));
    const again = await parse(qwenAdapter, q);
    expect(again.st.run.turn).toBe('in_progress'); // results went back to the model
  });

  it('Qwen: a tool_result without ids pairs with the open call of the same tool', async () => {
    const file = '/home/alex/src/todo-cli/cli.py';
    const p = await tmpFile(
      '9b9b9b9b-0000-4000-8000-000000000006.jsonl',
      jsonl([
        qUser(1, 1, 'Fix the typo in cli.py.'),
        qCall(2, 2, undefined, 'edit', { file_path: file, old_string: 'teh', new_string: 'the' }),
        qResult(3, 4, undefined, 'edit', 'success'),
      ]),
    );
    const { st } = await parse(qwenAdapter, p);
    expect(st.run.openTool).toBeUndefined();
    const [call, result] = st.run.events.filter((e) => e.kind === 'tool_call' || e.kind === 'tool_result');
    expect(result.toolCallId).toBe(call.toolCallId);
    expect(Object.keys(st.run.files)).toEqual([file]);
  });
});
