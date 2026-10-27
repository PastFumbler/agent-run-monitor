import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import type { Env, ParseContext, ParseState, SessionRef } from '../../adapter';
import { safeParse } from '../../build';
import { judgeStatus } from '../../status';
import { adapters, codexAdapter } from './index';
import { findThreadFile, homeAbove } from './paths';
import { patchFiles } from './tools';
import { dayKey } from '@shared/usage';

const FIX = resolve(__dirname, '../../../../test/fixtures/codex');
const LEGACY = 'rollout-2026-10-20T16-03-12-019a01f2-6c3d-7e41-b5a2-3c4d5e6f7a81.jsonl';
const PAGINATED = 'rollout-2026-10-22T11-15-00-019a0a11-2b3c-7d4e-8f50-6a7b8c9d0e1f.jsonl';
const EXTENDED = 'rollout-2026-04-14T20-40-02-019d1e2f-3a4b-7c5d-8e6f-7a8b9c0d1e2f.jsonl';
const BARE = 'rollout-2025-08-21T11-12-40-5973b6c0-94b8-487b-a530-2aeb6098ae0e.jsonl';

const tmpRoot = mkdtempSync(join(tmpdir(), 'arm-codex-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const tmp = (name: string) => {
  const d = join(tmpRoot, String(n++));
  mkdirSync(d, { recursive: true });
  return join(d, name);
};

const env: Env = { platform: 'win32', home: 'C:\\Users\\alex', vars: {} };
const ctx: ParseContext = { env, tempDir: tmpRoot };

function refFor(path: string): SessionRef {
  const st = statSync(path);
  return { agent: 'codex', path, mtimeMs: st.mtimeMs, size: st.size };
}
async function parse(path: string, prev?: ParseState) {
  return codexAdapter.parse(refFor(path), prev, ctx);
}
function kinds(st: ParseState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of st.run.events) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}
function writeLines(path: string, recs: unknown[]) {
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe('codex adapter: roots and discovery', () => {
  it('exports the adapter family', () => {
    expect(adapters.map((a) => a.id)).toEqual(['codex']);
    expect(codexAdapter.confidence).toBe('source');
  });

  it('uses CODEX_HOME or <home>/.codex per OS', () => {
    expect(codexAdapter.defaultRoots(env)).toEqual(['C:\\Users\\alex\\.codex']);
    expect(codexAdapter.defaultRoots({ platform: 'darwin', home: '/Users/alex', vars: {} })).toEqual(['/Users/alex/.codex']);
    expect(codexAdapter.defaultRoots({ platform: 'linux', home: '/home/alex', vars: { XDG_DATA_HOME: '/x' } })).toEqual(['/home/alex/.codex']);
    expect(codexAdapter.defaultRoots({ platform: 'linux', home: '/home/alex', vars: { CODEX_HOME: '/srv/codex' } })).toEqual(['/srv/codex']);
    expect(codexAdapter.defaultRoots({ platform: 'win32', home: 'C:\\Users\\alex', vars: { CODEX_HOME: '  ' } })).toEqual(['C:\\Users\\alex\\.codex']);
  });

  function fakeHome(): string {
    const home = join(tmpRoot, `home${n++}`, '.codex');
    const put = (rel: string, file: string, mtime?: Date) => {
      const dest = join(home, rel);
      mkdirSync(join(dest, '..'), { recursive: true });
      copyFileSync(join(FIX, file), dest);
      if (mtime) utimesSync(dest, mtime, mtime);
      return dest;
    };
    put(`sessions/2026/10/20/${LEGACY}`, LEGACY, new Date('2026-10-20T14:10:00Z'));
    // A revert of the same thread, older than the original: the newest file wins.
    put(`sessions/2026/10/20/${LEGACY.replace('.jsonl', '_019a01f9-0000-7000-8000-000000000001.jsonl')}`, LEGACY, new Date('2026-10-20T14:05:00Z'));
    put(`sessions/2026/10/22/${PAGINATED}`, PAGINATED, new Date('2026-10-22T09:20:00Z'));
    put(`sessions/2026/10/22/${PAGINATED}.zst`, PAGINATED, new Date('2026-10-22T09:30:00Z')); // plain sibling wins
    put(`sessions/2025/08/21/${BARE}`, BARE, new Date('2025-08-21T09:20:00Z'));
    put(`archived_sessions/${EXTENDED}`, EXTENDED, new Date('2026-04-14T18:45:00Z'));
    put('session_index.jsonl', 'session_index.jsonl');
    put('history.jsonl', 'history.jsonl');
    put('sessions/2026/10/22/notes.txt', 'history.jsonl');
    return home;
  }

  it('lists rollouts under sessions/ and archived_sessions/, one per thread', async () => {
    const home = fakeHome();
    const refs = await codexAdapter.discover([home], { env, since: 0, projectRoots: [] });
    const names = refs.map((r) => r.path.split(/[\\/]/).pop()).sort();
    expect(names).toEqual([BARE, EXTENDED, LEGACY, PAGINATED].sort());
    const archived = refs.find((r) => r.path.endsWith(EXTENDED))!;
    expect(archived.hint).toMatchObject({ archived: '1', home, threadId: '019d1e2f-3a4b-7c5d-8e6f-7a8b9c0d1e2f' });
    expect(refs.every((r) => r.agent === 'codex' && r.size > 0)).toBe(true);
  });

  it('honours since and tolerates missing roots', async () => {
    const home = fakeHome();
    const since = Date.parse('2026-10-01T00:00:00Z');
    const refs = await codexAdapter.discover([home, join(tmpRoot, 'nope', '.codex')], { env, since, projectRoots: [] });
    expect(refs.map((r) => r.path.split(/[\\/]/).pop()).sort()).toEqual([LEGACY, PAGINATED].sort());
    expect(await codexAdapter.discover([join(tmpRoot, 'missing')], { env, since: 0, projectRoots: [] })).toEqual([]);
  });

  it('accepts a root that points straight at a sessions folder', async () => {
    const home = fakeHome();
    const refs = await codexAdapter.discover([join(home, 'sessions')], { env, since: 0, projectRoots: [] });
    expect(refs).toHaveLength(3);
    // The home above is still known, so sub-agent runs can find their parent thread.
    expect(refs.every((r) => r.hint?.home === home)).toBe(true);
  });

  it('accepts a date folder inside sessions, archived_sessions, or the folder that holds .codex', async () => {
    const home = fakeHome();
    const disc = (root: string) => codexAdapter.discover([root], { env, since: 0, projectRoots: [] });
    const day = await disc(join(home, 'sessions', '2026', '10', '22'));
    expect(day.map((r) => r.path.split(/[\\/]/).pop())).toEqual([PAGINATED]);
    expect(day[0].hint?.home).toBe(home);
    const year = await disc(join(home, 'sessions', '2026'));
    expect(year.map((r) => r.path.split(/[\\/]/).pop()).sort()).toEqual([LEGACY, PAGINATED].sort());
    const archived = await disc(join(home, 'archived_sessions'));
    expect(archived.map((r) => r.path.split(/[\\/]/).pop())).toEqual([EXTENDED]);
    expect(archived[0].hint).toMatchObject({ home, archived: '1' });
    const userHome = await disc(join(home, '..'));
    expect(userHome).toHaveLength(4);
    // A folder with no rollouts in it finds nothing (the UI then explains which folder to pick).
    expect(await disc(join(home, '..', '..'))).toEqual([]);
  });

  it('homeAbove names the Codex home only for folders inside it', () => {
    const h = join(tmpRoot, 'x', '.codex');
    expect(homeAbove(join(h, 'sessions'))).toBe(h);
    expect(homeAbove(join(h, 'sessions', '2026', '10', '22'))).toBe(h);
    expect(homeAbove(join(h, 'archived_sessions'))).toBe(h);
    expect(homeAbove(join(h, 'archived_sessions', '2026'))).toBeUndefined();
    expect(homeAbove(join(tmpRoot, 'x', 'notes'))).toBeUndefined();
  });

  it('finds a parent thread file from its UUIDv7 id', async () => {
    const home = fakeHome();
    // Fixture ids are synthesized and decode to 2025-10-20, so place a thread in that day's folder.
    const day = join(home, 'sessions', '2025', '10', '20');
    mkdirSync(day, { recursive: true });
    const other = 'rollout-2025-10-20T16-07-35-019a01f2-6c3d-7e41-b5a2-3c4d5e6f7a99.jsonl';
    copyFileSync(join(FIX, LEGACY), join(day, other));
    expect(await findThreadFile(home, '019a01f2-6c3d-7e41-b5a2-3c4d5e6f7a99')).toBe(join(day, other));
    const near = join(home, 'sessions', '2026', '10', '20');
    expect(await findThreadFile(home, '019a01f2-6c3d-7e41-b5a2-3c4d5e6f7a81', near)).toBe(join(near, LEGACY));
    expect(await findThreadFile(home, '019d1e2f-3a4b-7c5d-8e6f-7a8b9c0d1e2f')).toMatch(/archived_sessions/);
    expect(await findThreadFile(home, '019a0000-0000-7000-8000-000000000000')).toBeUndefined();
  });
});

describe('codex adapter: parsing real-format fixtures', () => {
  it('legacy history mode: three turns, tools, patches, interrupt and failed turn', async () => {
    const st = await parse(join(FIX, LEGACY));
    const r = st.run;
    expect(r.readError).toBeUndefined();
    expect(r.title).toBe('Add a --done flag to `todo list` so it only shows finished items.');
    expect(r.projectName).toBe('todo-cli');
    expect(r.projectPath).toBe('C:\\Users\\alex\\code\\todo-cli');
    expect(r.gitBranch).toBe('feature/done-flag');
    expect(r.model).toBe('gpt-5-codex');
    expect(r.startedAt).toBe(Date.parse('2026-10-20T14:03:12.402Z'));
    expect(r.lastEventAt).toBe(Date.parse('2026-10-20T14:06:41.735Z'));
    // Messages appear as response_item and event_msg: each counts once.
    expect(kinds(st)).toEqual({ user: 3, assistant: 2, reasoning: 2, tool_call: 6, tool_result: 6, file_change: 2, system: 1, error: 1 });
    expect(r.tally).toEqual({ events: 23, messages: 5, toolCalls: 6, errors: 3 });
    expect(r.skipped).toBe(0);
    expect(r.files).toEqual({
      'C:\\Users\\alex\\code\\todo-cli\\src\\todo_cli\\cli.py': { ops: ['edit'], count: 2, lastTs: Date.parse('2026-10-20T14:03:26.977Z') },
    });
    // Running totals; input_tokens includes the cached part, which is reported apart.
    expect(r.usage).toMatchObject({ input: 31840 - 26880, cacheRead: 26880, cacheWrite: 0, output: 1490 });
    expect(r.usage!.byDay).toEqual({ [dayKey(Date.parse('2026-10-20T14:05:00Z'))]: { input: 31840 - 26880, cacheRead: 26880, cacheWrite: 0, output: 1490 } });
    // Each applied patch is a change with its unified diff and exact line counts.
    const cli = 'C:\\Users\\alex\\code\\todo-cli\\src\\todo_cli\\cli.py';
    expect(r.changes!.map((c) => [c.filePath, c.op, c.linesAdded, c.linesRemoved, c.toolCallId])).toEqual([
      [cli, 'edit', 2, 1, 'call_D4f5G6h7J8k9L0z1X2c3V4b5'],
      [cli, 'edit', 1, 1, 'call_H8j9K0l1Z2x3C4v5B6n7M8q9'],
    ]);
    expect(r.changes![1].diff).toBe('@@ -12,1 +12,1 @@\n-    items = store.load()\n+    items = [i for i in store.load() if i.done] if args.done else store.load()');
    expect(r.changes![0].ts).toBe(Date.parse('2026-10-20T14:03:19.702Z'));
    expect(r.turn).toBe('error');
    expect(r.turnDetail).toMatch(/overloaded/);
    expect(r.openTool).toBeUndefined();

    // Pairing: every result follows its call by id, and the failing test is an error.
    const calls = r.events.filter((e) => e.kind === 'tool_call');
    const results = r.events.filter((e) => e.kind === 'tool_result');
    expect(results.map((e) => e.toolCallId)).toEqual(calls.map((e) => e.toolCallId));
    expect(calls.map((c) => c.toolName)).toEqual(['exec_command', 'apply_patch', 'exec_command', 'apply_patch', 'exec_command', 'exec_command']);
    expect(calls[0]).toMatchObject({ toolKind: 'run', text: 'Get-Content src/todo_cli/cli.py' });
    expect(calls[1]).toMatchObject({ toolKind: 'edit', filePath: undefined });
    expect(results.map((e) => !!e.isError)).toEqual([false, false, true, false, false, true]);
    expect(results[0].durationMs).toBe(281);
    expect(r.events.find((e) => e.kind === 'system')?.text).toMatch(/interrupted/i);
  });

  it('paginated history mode: item_completed items, FileChange, MCP namespace, token_usage_record', async () => {
    const st = await parse(join(FIX, PAGINATED));
    const r = st.run;
    expect(r.title).toBe('Rename the `todo rm` command to `todo remove` and keep `rm` as an alias.');
    expect(r.projectName).toBe('todo-cli');
    expect(r.gitBranch).toBe('main');
    expect(r.model).toBe('gpt-5-codex');
    expect(kinds(st)).toEqual({ user: 1, reasoning: 1, tool_call: 4, tool_result: 4, file_change: 2, assistant: 1 });
    expect(r.tally.errors).toBe(1);
    expect(Object.keys(r.files).sort()).toEqual([
      'C:\\Users\\alex\\code\\todo-cli\\docs\\commands.md',
      'C:\\Users\\alex\\code\\todo-cli\\src\\todo_cli\\cli.py',
    ]);
    expect(r.files['C:\\Users\\alex\\code\\todo-cli\\docs\\commands.md'].ops).toEqual(['create']);
    const mcp = r.events.find((e) => e.kind === 'tool_call' && e.toolName?.includes('list_tasks'));
    expect(mcp).toMatchObject({ toolName: 'mcp__tracker__list_tasks', toolKind: 'other', text: '{"status":"open"}' });
    const failed = r.events.filter((e) => e.kind === 'tool_result' && e.isError);
    expect(failed.map((e) => e.toolCallId)).toEqual(['call_U5i6O7p8A9s0D1f2G3h4J5k6']);
    expect(r.usage).toMatchObject({ input: 29770 - 25600, cacheRead: 25600, cacheWrite: 0, output: 1150 });
    expect(r.changes!.map((c) => [c.filePath.split('\\').pop(), c.op, c.linesAdded, c.linesRemoved])).toEqual([
      ['commands.md', 'create', 3, 0],
      ['cli.py', 'edit', 1, 1],
    ]);
    expect(r.changes![0].diff).toBe('@@ -0,0 +1,3 @@\n+# Commands\n+\n+- `todo remove` (alias `rm`)');
    expect(r.turn).toBe('completed');
    expect(r.skipped).toBe(0);
  });

  it('extended-history era: exec_command_end, mcp_tool_call_end Err and a recovered error event', async () => {
    const st = await parse(join(FIX, EXTENDED));
    const r = st.run;
    expect(r.title).toBe('Run the tests and tell me what fails.');
    expect(r.gitBranch).toBe('main');
    expect(kinds(st)).toEqual({ user: 1, tool_call: 2, tool_result: 2, error: 1, assistant: 1 });
    expect(r.tally.errors).toBe(3);
    expect(r.events.filter((e) => e.kind === 'tool_call').map((e) => [e.toolName, e.toolKind])).toEqual([
      ['shell_command', 'run'],
      ['tracker__list_tasks', 'other'],
    ]);
    // No cache_write_input_tokens in this era: reported as unknown, not 0.
    expect(r.usage).toMatchObject({ input: 14210 - 11008, cacheRead: 11008, output: 522 });
    expect(r.usage!.cacheWrite).toBeUndefined();
    expect(r.changes ?? []).toEqual([]);
    // The stream error was followed by an answer and task_complete: the turn finished.
    expect(r.turn).toBe('completed');
  });

  it('bare 2025 era: no envelope, record_type state lines, local_shell_call, JSON shell output', async () => {
    const st = await parse(join(FIX, BARE));
    const r = st.run;
    expect(r.readError).toBeUndefined();
    expect(r.title).toBe('What does todo-cli store on disk?');
    expect(r.projectPath).toBe('/home/alex/code/todo-cli');
    expect(r.projectName).toBe('todo-cli');
    expect(r.gitBranch).toBe('main');
    expect(r.model).toBeUndefined();
    expect(r.startedAt).toBe(Date.parse('2025-08-21T09:12:40.517Z'));
    expect(kinds(st)).toEqual({ user: 1, reasoning: 1, tool_call: 2, tool_result: 2, assistant: 1 });
    const calls = r.events.filter((e) => e.kind === 'tool_call');
    expect(calls[0]).toMatchObject({ toolName: 'local_shell', toolKind: 'run', text: 'bash -lc cat src/todo_cli/store.py' });
    const results = r.events.filter((e) => e.kind === 'tool_result');
    expect(results[0]).toMatchObject({ isError: false, text: 'import json\nPATH = "~/.todo.json"\n' });
    expect(results[1].isError).toBe(true);
    // No task_complete before rust-v0.100: a final answer with nothing open ends the turn.
    expect(r.turn).toBe('completed');
    expect(r.skipped).toBe(0);
  });

  it('legacy TypeScript-CLI .json rollouts degrade to a readable run', async () => {
    const p = tmp('rollout-2025-04-20-5973b6c0-94b8-487b-a530-2aeb6098ae0f.json');
    writeFileSync(
      p,
      JSON.stringify({
        session: { id: '5973b6c0-94b8-487b-a530-2aeb6098ae0f', timestamp: '2025-04-20T10:00:00.000Z', instructions: '' },
        items: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the files' }] },
          { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' },
          { type: 'function_call_output', call_id: 'c1', output: '{"output":"a.py\\n","metadata":{"exit_code":0}}' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'One file.' }] },
        ],
      }),
    );
    const st = await parse(p);
    expect(st.run.title).toBe('List the files');
    expect(kinds(st)).toEqual({ user: 1, tool_call: 1, tool_result: 1, assistant: 1 });
    expect(st.run.turn).toBe('completed');
  });

  it.runIf(typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === 'function')('reads zstd-compressed rollouts', async () => {
    const p = tmp(`${PAGINATED}.zst`);
    const comp = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;
    writeFileSync(p, comp(readFileSync(join(FIX, PAGINATED))));
    const st = await parse(p);
    expect(kinds(st)).toEqual(kinds(await parse(join(FIX, PAGINATED))));
    expect(st.run.title).toMatch(/^Rename the/);
    expect(st.run.turn).toBe('completed');
    // Unchanged file: the previous state comes back as is.
    expect(await parse(p, st)).toBe(st);
  });

  it('a damaged .zst rollout reads as unreadable, not a crash', async () => {
    const p = tmp(`${LEGACY}.zst`);
    writeFileSync(p, Buffer.from('definitely not zstd data'));
    const st = await safeParse(codexAdapter, refFor(p), undefined, ctx);
    expect(st.run.readError).toMatch(/^Couldn't read this run/);
    expect(judgeStatus(st.run, Date.now(), Date.now()).status).toBe('unreadable');
  });
});

describe('codex adapter: bad input', () => {
  it('corrupt fixture: skips the garbage line, keeps good records, leaves the cut-off tail', async () => {
    const path = join(FIX, 'codex-corrupt.jsonl');
    const st = await safeParse(codexAdapter, refFor(path), undefined, ctx);
    expect(st.run.readError).toBeUndefined();
    expect(st.run.skipped).toBe(1); // the garbage line
    expect(st.run.title).toBe('Add a --done flag to `todo list` so it only shows finished items.');
    expect(kinds(st)).toMatchObject({ user: 1, reasoning: 1, assistant: 1, tool_call: 1, tool_result: 1 });
    expect(st.offset).toBeLessThan(statSync(path).size); // the unterminated last record waits for more
    expect(st.run.turn).toBe('in_progress');
  });

  it('a file of unknown record types sets readError and does not throw', async () => {
    const p = tmp('rollout-2026-10-25T10-00-00-019a1b00-0000-7000-8000-000000000001.jsonl');
    writeLines(p, [
      { timestamp: '2026-10-25T08:00:00Z', type: 'hologram', payload: { x: 1 } },
      { timestamp: '2026-10-25T08:00:01Z', type: 'quantum_state', payload: {} },
      [1, 2, 3],
    ]);
    const st = await safeParse(codexAdapter, refFor(p), undefined, ctx);
    expect(st.run.readError).toBe('No records this app recognises; the agent may have changed its format.');
    expect(st.run.skipped).toBe(3);
    expect(judgeStatus(st.run, Date.now(), Date.now()).status).toBe('unreadable');
  });

  it('unknown types inside known records are skipped, not fatal', async () => {
    const p = tmp('rollout-2026-10-25T10-00-00-019a1b00-0000-7000-8000-000000000002.jsonl');
    writeLines(p, [
      { timestamp: '2026-10-25T08:00:00Z', type: 'session_meta', payload: { id: 'x', cwd: '/home/alex/code/app', history_mode: 'mystery' } },
      { timestamp: '2026-10-25T08:00:01Z', type: 'event_msg', payload: { type: 'brand_new_event' } },
      { timestamp: '2026-10-25T08:00:02Z', type: 'response_item', payload: { type: 'brand_new_item' } },
      { timestamp: '2026-10-25T08:00:03Z', type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
    ]);
    const st = await safeParse(codexAdapter, refFor(p), undefined, ctx);
    expect(st.run.readError).toBeUndefined();
    expect(st.run.skipped).toBe(2);
    expect(st.run.title).toBe('hello');
    expect(st.run.projectName).toBe('app');
  });
});

describe('codex adapter: turn states', () => {
  const meta = { timestamp: '2026-10-25T08:00:00Z', type: 'session_meta', payload: { id: 'x', cwd: '/home/alex/code/app' } };
  const started = { timestamp: '2026-10-25T08:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } };
  const user = { timestamp: '2026-10-25T08:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'go' } };

  it('older approval requests read as waiting_input until the agent moves on', async () => {
    const p = tmp('rollout-2026-10-25T10-00-00-019a1b00-0000-7000-8000-000000000003.jsonl');
    const call = { timestamp: '2026-10-25T08:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["rm","-rf","build"]}', call_id: 'c1' } };
    const ask = { timestamp: '2026-10-25T08:00:03Z', type: 'event_msg', payload: { type: 'exec_approval_request', call_id: 'c1', command: ['rm', '-rf', 'build'] } };
    writeLines(p, [meta, started, user, call, ask]);
    const st = await parse(p);
    expect(st.run.turn).toBe('waiting_input');
    expect(st.run.turnDetail).toBe('Waiting for approval to run: rm -rf build');
    expect(judgeStatus(st.run, st.run.lastEventAt!, st.run.lastEventAt! + 60_000).status).toBe('waiting');
    appendFileSync(p, JSON.stringify({ timestamp: '2026-10-25T08:00:09Z', type: 'event_msg', payload: { type: 'exec_command_begin', call_id: 'c1' } }) + '\n');
    const st2 = await parse(p, st);
    expect(st2.run.turn).toBe('in_progress');
    expect(st2.run.openTool).toMatchObject({ name: 'shell', kind: 'run', since: Date.parse('2026-10-25T08:00:02Z') });
  });

  it('an open request_user_input call waits for the user', async () => {
    const p = tmp('rollout-2026-10-25T10-00-00-019a1b00-0000-7000-8000-000000000004.jsonl');
    const call = { timestamp: '2026-10-25T08:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', arguments: '{"questions":[]}', call_id: 'q1' } };
    writeLines(p, [meta, started, user, call]);
    const st = await parse(p);
    expect(st.run.turn).toBe('waiting_input');
  });

  it('turn_aborted reads as aborted and clears open calls', async () => {
    const p = tmp('rollout-2026-10-25T10-00-00-019a1b00-0000-7000-8000-000000000005.jsonl');
    const call = { timestamp: '2026-10-25T08:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"sleep 99"}', call_id: 'c9' } };
    const abort = { timestamp: '2026-10-25T08:00:05Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' } };
    writeLines(p, [meta, started, user, call, abort]);
    const st = await parse(p);
    expect(st.run.turn).toBe('aborted');
    expect(st.run.turnDetail).toBe('Interrupted by you');
    expect(st.run.openTool).toBeUndefined();
  });

  it('an error event followed only by a plain task_complete fails the turn (older Codex)', async () => {
    const p = tmp('rollout-2026-04-15T10-00-00-019d1e2f-0000-7000-8000-000000000006.jsonl');
    const err = { timestamp: '2026-10-25T08:00:04Z', type: 'event_msg', payload: { type: 'error', message: 'unexpected status 401 Unauthorized' } };
    const tok = { timestamp: '2026-10-25T08:00:04Z', type: 'event_msg', payload: { type: 'token_count', info: null } };
    const done = { timestamp: '2026-10-25T08:00:05Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: null } };
    writeLines(p, [meta, started, user, err, tok, done]);
    const st = await parse(p);
    expect(st.run.turn).toBe('error');
    expect(st.run.turnDetail).toBe('unexpected status 401 Unauthorized');
    expect(judgeStatus(st.run, st.run.lastEventAt!, st.run.lastEventAt! + 60_000).status).toBe('failed');
    // The same error carried again on task_complete is not shown twice.
    const p2 = tmp('rollout-2026-04-15T10-00-00-019d1e2f-0000-7000-8000-000000000007.jsonl');
    writeLines(p2, [meta, started, user, err, { ...done, payload: { ...done.payload, error: { message: 'unexpected status 401 Unauthorized' } } }]);
    const st2 = await parse(p2);
    expect(st2.run.turn).toBe('error');
    expect(st2.run.events.filter((e) => e.kind === 'error')).toHaveLength(1);
  });

  it('a prompt with an attached image counts once and titles the run by its text', async () => {
    const p = tmp('rollout-2026-10-25T10-00-00-019a1b00-0000-7000-8000-000000000008.jsonl');
    const item = {
      timestamp: '2026-10-25T08:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<image name=[Image #1]>' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          { type: 'input_text', text: '</image>' },
          { type: 'input_text', text: 'Why is this button misaligned?' },
        ],
      },
    };
    const evt = { timestamp: '2026-10-25T08:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'Why is this button misaligned?', local_images: ['C:\\Users\\alex\\shot.png'] } };
    writeLines(p, [meta, started, item, evt]);
    const st = await parse(p);
    expect(st.run.title).toBe('Why is this button misaligned?');
    expect(st.run.events.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual(['Why is this button misaligned?\n[image]']);
  });

  it('tool errors come from the exec header, not from what the command printed', async () => {
    const p = tmp('rollout-2026-10-25T10-00-00-019a1b00-0000-7000-8000-000000000009.jsonl');
    const call = (id: string) => ({ timestamp: '2026-10-25T08:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cat build.log"}', call_id: id } });
    const out = (id: string, output: string) => ({ timestamp: '2026-10-25T08:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: id, output } });
    writeLines(p, [
      meta,
      started,
      user,
      call('a'),
      out('a', 'Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nstep 3: Process exited with code 2\nExit code: 1\n{"exit_code": 7}\naborted by user\n'),
      call('b'),
      out('b', 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nExit code: 1\n'),
      call('c'),
      out('c', 'Chunk ID: 2\nWall time: 0.4 seconds\nProcess exited with code 127\nOutput:\nnot found\n'),
      call('d'),
      out('d', 'Wall time: 4.2 seconds\naborted by user'),
      call('e'),
      out('e', 'Exit code: 2\nWall time: 0.1 seconds\nOutput:\n'),
    ]);
    const results = (await parse(p)).run.events.filter((e) => e.kind === 'tool_result');
    expect(results.map((e) => [e.toolCallId, !!e.isError])).toEqual([
      ['a', false],
      ['b', false],
      ['c', true],
      ['d', true],
      ['e', true],
    ]);
  });

  it('a sub-agent rollout links to its parent file', async () => {
    const home = join(tmpRoot, `sub${n++}`, '.codex');
    const day = join(home, 'sessions', '2026', '10', '20');
    mkdirSync(day, { recursive: true });
    copyFileSync(join(FIX, LEGACY), join(day, LEGACY));
    const child = join(day, 'rollout-2026-10-20T16-10-00-019a01f9-1111-7000-8000-000000000001.jsonl');
    writeLines(child, [
      { timestamp: '2026-10-20T14:10:00Z', type: 'session_meta', payload: { id: '019a01f9-1111-7000-8000-000000000001', cwd: 'C:\\Users\\alex\\code\\todo-cli', source: { subagent: { thread_spawn: { parent_thread_id: '019a01f2-6c3d-7e41-b5a2-3c4d5e6f7a81' } } } } },
      { timestamp: '2026-10-20T14:10:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'Review the diff' } },
    ]);
    const [ref] = (await codexAdapter.discover([home], { env, since: 0, projectRoots: [] })).filter((r) => r.path === child);
    const st = await codexAdapter.parse(ref, undefined, ctx);
    expect(st.run.parentPath).toBe(join(day, LEGACY));
  });
});

describe('codex adapter: incremental parsing', () => {
  for (const file of [LEGACY, PAGINATED, BARE]) {
    it(`continues from the previous offset (${file.slice(8, 18)})`, async () => {
      const full = readFileSync(join(FIX, file));
      const lines = full.toString('utf8').split('\n');
      const half = Math.floor(lines.length / 2);
      const headText = lines.slice(0, half).join('\n') + '\n';
      const partial = lines[half].slice(0, Math.floor(lines[half].length / 2));
      const p = tmp(file);
      writeFileSync(p, headText + partial);
      const first = await parse(p);
      expect(first.offset).toBe(Buffer.byteLength(headText));
      appendFileSync(p, full.subarray(Buffer.byteLength(headText + partial)));
      const second = await parse(p, first);
      const once = await parse(join(FIX, file));
      expect(second.run.events).toEqual(once.run.events);
      expect(second.run.tally).toEqual(once.run.tally);
      expect(second.run.files).toEqual(once.run.files);
      expect([second.run.turn, second.run.title, second.run.usage, second.run.changes, second.run.model]).toEqual([
        once.run.turn,
        once.run.title,
        once.run.usage,
        once.run.changes,
        once.run.model,
      ]);
      expect(second.offset).toBe(full.length);
      // The first state was not changed by the second parse.
      expect(first.run.events.length).toBeLessThan(second.run.events.length);
    });
  }

  it('starts over when the file shrank or was rewritten', async () => {
    const p = tmp(LEGACY);
    copyFileSync(join(FIX, LEGACY), p);
    const first = await parse(p);
    copyFileSync(join(FIX, PAGINATED), p);
    const second = await parse(p, first);
    expect(second.run.title).toMatch(/^Rename the/);
    expect(second.run.tally).toEqual((await parse(join(FIX, PAGINATED))).run.tally);
  });
});

describe('codex adapter: status', () => {
  it('a finished run reads idle, then done; a failed one reads failed', async () => {
    const done = (await parse(join(FIX, PAGINATED))).run;
    const last = done.lastEventAt!;
    expect(judgeStatus(done, last, last + 60_000).status).toBe('idle');
    expect(judgeStatus(done, last, last + 10 * 60_000).status).toBe('done');
    const failed = (await parse(join(FIX, LEGACY))).run;
    expect(judgeStatus(failed, failed.lastEventAt!, failed.lastEventAt! + 60_000)).toMatchObject({ status: 'failed' });
  });

  it('a run cut mid-turn with an open shell call reads running', async () => {
    const lines = readFileSync(join(FIX, LEGACY), 'utf8').split('\n');
    const p = tmp(LEGACY);
    writeFileSync(p, lines.slice(0, 12).join('\n') + '\n'); // ends on the first exec_command call
    const r = (await parse(p)).run;
    expect(r.turn).toBe('in_progress');
    expect(r.openTool).toEqual({ name: 'exec_command', kind: 'run', since: Date.parse('2026-10-20T14:03:16.020Z') });
    // Codex writes no approval prompt to disk: the open call is marked as a guess...
    expect(r.turnInferred).toBe(true);
    expect(judgeStatus(r, r.lastEventAt!, r.lastEventAt! + 30_000)).toEqual({ status: 'running', detail: 'Running exec_command', inferred: true });
    // ...and once the file has been quiet a while it reads as probably waiting for approval.
    expect(judgeStatus(r, r.lastEventAt!, r.lastEventAt! + 2 * 60_000)).toEqual({
      status: 'waiting',
      detail: 'exec_command may need your approval, or it is still running',
      inferred: true,
    });
  });

  it('a recorded approval request is not marked as inferred', async () => {
    const p = tmp('rollout-2026-10-25T10-00-00-019a1b00-0000-7000-8000-000000000009.jsonl');
    writeLines(p, [
      { timestamp: '2026-10-25T08:00:00Z', type: 'session_meta', payload: { id: 'x', cwd: '/home/alex/code/app' } },
      { timestamp: '2026-10-25T08:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { timestamp: '2026-10-25T08:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' } },
      { timestamp: '2026-10-25T08:00:03Z', type: 'event_msg', payload: { type: 'exec_approval_request', call_id: 'c1', command: ['ls'] } },
    ]);
    const r = (await parse(p)).run;
    expect(r.turn).toBe('waiting_input');
    expect(r.turnInferred).toBeUndefined();
    const j = judgeStatus(r, r.lastEventAt!, r.lastEventAt! + 2 * 60_000);
    expect(j.status).toBe('waiting');
    expect(j.inferred).toBeUndefined();
  });
});

describe('codex apply_patch bodies (older files without patch_apply_end)', () => {
  it("reads each file's hunks as its diff, with exact counts", () => {
    const body = [
      '*** Begin Patch',
      '*** Update File: src/app.py',
      '@@ def main():',
      '-    run()',
      '+    run(fast=True)',
      '+    log()',
      '*** Add File: notes.md',
      '+# Notes',
      '+todo',
      '*** Delete File: old.txt',
      '*** Update File: a.py',
      '*** Move to: b.py',
      '@@',
      '-x = 1',
      '+x = 2',
      '*** End Patch',
    ].join('\n');
    const files = patchFiles(body);
    expect(files.map((f) => [f.path, f.op, f.diff?.added, f.diff?.removed, !!f.moved])).toEqual([
      ['src/app.py', 'edit', 2, 1, false],
      ['notes.md', 'create', 2, 0, false],
      ['old.txt', 'delete', undefined, undefined, false],
      ['a.py', 'delete', undefined, undefined, true],
      ['b.py', 'create', 1, 1, false],
    ]);
    expect(files[0].diff?.diff).toBe(['@@ def main():', '-    run()', '+    run(fast=True)', '+    log()'].join('\n'));
    expect(files[1].diff?.diff).toBe(['@@', '+# Notes', '+todo'].join('\n'));
  });
});
