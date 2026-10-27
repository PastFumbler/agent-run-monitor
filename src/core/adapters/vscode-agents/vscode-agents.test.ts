import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DiscoverContext, Env, ParseContext, ParseState, SessionRef, SourceAdapter } from '../../adapter';
import { safeParse, toDetail } from '../../build';
import { judgeStatus } from '../../status';
import { salvageArray, UNRECOGNISED, uriToPath } from './common';
import { adapters, clineAdapter as cline, continueAdapter as cont, rooCodeAdapter as roo } from './index';

const FIX = resolve(__dirname, '../../../../test/fixtures/vscode-agents');
const CLINE_EXT_DIR = join(FIX, 'cline-legacy', 'globalStorage', 'saoudrizwan.claude-dev');
const CLINE_DATA = join(FIX, 'cline-sdk', '.cline', 'data');
const ROO_EXT_DIR = join(FIX, 'roo', 'globalStorage', 'rooveterinaryinc.roo-cline');
const CONT_SESSIONS = join(FIX, 'continue', '.continue', 'sessions');
const CONT_CORRUPT = join(FIX, 'continue-corrupt', '.continue', 'sessions');

const CLINE_DONE = '1792900000000';
const CLINE_WAITING = '1792900600000';
const CLINE_CORRUPT = '1792900900000';
const SDK_FAILED = '1792907200000_k3x9q';
const SDK_RUNNING = '1792907500000_p0w7e';
const ROO_DONE = '019a1f2e-3d4c-7b5a-9e8f-7a6b5c4d3e2f';
const ROO_INFLIGHT = '019a1f40-1b2c-7d3e-8f4a-5b6c7d8e9f01';
const CONT_WAITING = '5b3f0c1e-8a2d-4c6b-9e7f-1a2b3c4d5e6f';
const CONT_CHAT = 'c2a3b4d5-e6f7-4809-9a1b-2c3d4e5f6a7b';
const CONT_CLI = '0e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b';
const CONT_TRUNCATED = '9c8d7e6f-5a4b-4c3d-8e2f-1a0b9c8d7e6f';

const temps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'arm-vsa-'));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const env: Env = { platform: process.platform, home: tmpdir(), vars: {} };
const dctx = (since = 0): DiscoverContext => ({ env, since, projectRoots: [] });
const pctx = (): ParseContext => ({ env, tempDir: tmp() });

async function refsOf(adapter: SourceAdapter, roots: string[]): Promise<SessionRef[]> {
  return adapter.discover(roots, dctx());
}

async function refByPath(adapter: SourceAdapter, roots: string[], fragment: string): Promise<SessionRef> {
  const ref = (await refsOf(adapter, roots)).find((r) => r.path.includes(fragment));
  if (!ref) throw new Error(`no ref for ${fragment}`);
  return ref;
}

async function parse(adapter: SourceAdapter, ref: SessionRef, prev?: ParseState): Promise<ParseState> {
  return safeParse(adapter, ref, prev, pctx());
}

function freshRef(ref: SessionRef): SessionRef {
  const s = statSync(ref.path);
  return { ...ref, mtimeMs: s.mtimeMs, size: s.size };
}

function kinds(st: ParseState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of st.run.events) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

/** Every tool_call has exactly one tool_result with the same id, and vice versa. */
function expectPaired(st: ParseState): void {
  const calls = st.run.events.filter((e) => e.kind === 'tool_call').map((e) => e.toolCallId);
  const results = st.run.events.filter((e) => e.kind === 'tool_result').map((e) => e.toolCallId);
  expect(calls.every(Boolean)).toBe(true);
  expect([...results].sort()).toEqual([...calls].sort());
}

// ------------------------------------------------------------------ roots

describe('defaultRoots', () => {
  const win: Env = { platform: 'win32', home: 'C:\\Users\\alex', vars: { APPDATA: 'C:\\Users\\alex\\AppData\\Roaming' } };
  const mac: Env = { platform: 'darwin', home: '/Users/alex', vars: {} };
  const linux: Env = { platform: 'linux', home: '/home/alex', vars: {} };

  it('lists every editor host for Cline and Roo, per OS', () => {
    const w = cline.defaultRoots(win);
    for (const host of ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf']) {
      expect(w).toContain(`C:\\Users\\alex\\AppData\\Roaming\\${host}\\User\\globalStorage\\saoudrizwan.claude-dev`);
    }
    expect(w).toContain('C:\\Users\\alex\\.cline\\data');
    expect(roo.defaultRoots(win)).toContain('C:\\Users\\alex\\AppData\\Roaming\\Cursor\\User\\globalStorage\\rooveterinaryinc.roo-cline');
    expect(cline.defaultRoots(mac)).toContain('/Users/alex/Library/Application Support/Windsurf/User/globalStorage/saoudrizwan.claude-dev');
    expect(roo.defaultRoots(linux)).toContain('/home/alex/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline');
    expect(roo.defaultRoots(linux)).toContain('/home/alex/.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline');
    const xdg = roo.defaultRoots({ ...linux, vars: { XDG_CONFIG_HOME: '/home/alex/cfg' } });
    expect(xdg).toContain('/home/alex/cfg/VSCodium/User/globalStorage/rooveterinaryinc.roo-cline');
  });

  it('honours APPDATA falling back to the home folder, and the Cline overrides', () => {
    const noAppData = cline.defaultRoots({ platform: 'win32', home: 'C:\\Users\\alex', vars: {} });
    expect(noAppData).toContain('C:\\Users\\alex\\AppData\\Roaming\\Code\\User\\globalStorage\\saoudrizwan.claude-dev');
    expect(cline.defaultRoots({ ...linux, vars: { CLINE_DIR: '/opt/cline' } })).toContain('/opt/cline/data');
    const data = cline.defaultRoots({ ...linux, vars: { CLINE_DIR: '/opt/cline', CLINE_DATA_DIR: '/srv/cline-data', CLINE_SESSION_DATA_DIR: '/srv/sessions' } });
    expect(data).toContain('/srv/cline-data');
    expect(data).toContain('/srv/sessions');
    expect(data).not.toContain('/opt/cline/data');
  });

  it('puts Continue under ~/.continue/sessions unless CONTINUE_GLOBAL_DIR says otherwise', () => {
    expect(cont.defaultRoots(win)).toEqual(['C:\\Users\\alex\\.continue\\sessions']);
    expect(cont.defaultRoots(mac)).toEqual(['/Users/alex/.continue/sessions']);
    expect(cont.defaultRoots({ ...linux, vars: { CONTINUE_GLOBAL_DIR: '/data/continue' } })).toEqual(['/data/continue/sessions']);
  });

  it('exports one adapter per agent id, all source-checked', () => {
    expect(adapters.map((a) => a.id)).toEqual(['cline', 'roo-code', 'continue']);
    for (const a of adapters) {
      expect(a.confidence).toBe('source');
      expect(a.note.length).toBeGreaterThan(20);
    }
  });
});

// ------------------------------------------------------------------ discovery

describe('discover', () => {
  /** A fake home with the fixtures where the default roots point. */
  function fakeHome(): { home: Env; root: string } {
    const root = tmp();
    const home: Env = { platform: process.platform, home: root, vars: { APPDATA: join(root, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(root, '.config') } };
    const pick = (roots: string[], host: string) => roots.find((r) => r.includes(`${host}${process.platform === 'win32' ? '\\' : '/'}User`))!;
    cpSync(CLINE_EXT_DIR, pick(cline.defaultRoots(home), 'Code'), { recursive: true });
    cpSync(CLINE_EXT_DIR, pick(cline.defaultRoots(home), 'Cursor'), { recursive: true });
    cpSync(join(FIX, 'cline-sdk', '.cline'), join(root, '.cline'), { recursive: true });
    const rooRoot = pick(roo.defaultRoots(home), 'Windsurf');
    cpSync(ROO_EXT_DIR, rooRoot, { recursive: true });
    // Roo's proper-lockfile lock is a directory; it is never a task.
    mkdirSync(join(rooRoot, 'tasks', ROO_INFLIGHT, 'ui_messages.json.lock'), { recursive: true });
    mkdirSync(join(rooRoot, 'tasks', '.tmp-dir'), { recursive: true });
    cpSync(join(FIX, 'continue', '.continue'), join(root, '.continue'), { recursive: true });
    return { home, root };
  }

  it('finds Cline tasks in every editor and 4.x sessions under ~/.cline', async () => {
    const { home } = fakeHome();
    const refs = await cline.discover(cline.defaultRoots(home), { env: home, since: 0, projectRoots: [] });
    const legacy = refs.filter((r) => r.hint?.kind === 'legacy');
    const sdk = refs.filter((r) => r.hint?.kind === 'sdk');
    expect(legacy).toHaveLength(6); // 3 tasks x (Code, Cursor)
    expect(sdk.map((r) => r.hint?.sessionId).sort()).toEqual([SDK_FAILED, SDK_RUNNING]);
    expect(sdk.every((r) => r.path.endsWith('.messages.json'))).toBe(true);
    expect(legacy.every((r) => r.path.endsWith('ui_messages.json'))).toBe(true);
    const done = legacy.find((r) => r.hint?.taskId === CLINE_DONE)!;
    expect(done.hint).toMatchObject({ project: 'todo-cli', projectPath: 'C:\\Users\\alex\\todo-cli', model: 'claude-sonnet-4-5' });
    expect(done.hint?.title).toMatch(/^Add a --priority option/);
  });

  it('finds Roo tasks, skipping _index.json, temp files and lock folders', async () => {
    const { home } = fakeHome();
    const refs = await roo.discover(roo.defaultRoots(home), { env: home, since: 0, projectRoots: [] });
    expect(refs.map((r) => r.hint?.taskId).sort()).toEqual([ROO_DONE, ROO_INFLIGHT]);
    expect(refs.every((r) => r.agent === 'roo-code')).toBe(true);
  });

  it('finds Continue sessions and reads sessions.json for start time and title', async () => {
    const { home } = fakeHome();
    const refs = await cont.discover(cont.defaultRoots(home), { env: home, since: 0, projectRoots: [] });
    expect(refs.map((r) => r.hint?.sessionId).sort()).toEqual([CONT_CLI, CONT_WAITING, CONT_TRUNCATED, CONT_CHAT].sort());
    const w = refs.find((r) => r.hint?.sessionId === CONT_WAITING)!;
    expect(w.hint).toMatchObject({ dateCreated: '1792910800000', projectPath: 'C:\\Users\\alex\\todo-cli', title: 'Reject empty todo titles' });
    // The parent ~/.continue folder works as a root too.
    expect(await cont.discover([join(home.home, '.continue')], dctx())).toHaveLength(4);
  });

  it('honours since, and a resumed legacy task is listed once (the 4.x session wins)', async () => {
    const { home, root } = fakeHome();
    const old = new Date('2020-01-01T00:00:00Z');
    const codeRoot = cline.defaultRoots(home).find((r) => r.includes(`Code${process.platform === 'win32' ? '\\' : '/'}User`))!;
    utimesSync(join(codeRoot, 'tasks', CLINE_DONE, 'ui_messages.json'), old, old);
    const recent = await cline.discover([codeRoot], { env: home, since: Date.parse('2024-01-01'), projectRoots: [] });
    expect(recent.map((r) => r.hint?.taskId).sort()).toEqual([CLINE_WAITING, CLINE_CORRUPT]);

    cpSync(join(codeRoot, 'tasks', CLINE_WAITING), join(codeRoot, 'tasks', SDK_FAILED), { recursive: true });
    const refs = await cline.discover([codeRoot, join(root, '.cline', 'data')], dctx());
    expect(refs.filter((r) => r.path.includes(SDK_FAILED))).toHaveLength(1);
    expect(refs.find((r) => r.path.includes(SDK_FAILED))?.hint?.kind).toBe('sdk');
  });

  it('returns nothing for missing roots and never throws', async () => {
    const missing = join(tmp(), 'nope');
    for (const a of adapters) expect(await a.discover([missing], dctx())).toEqual([]);
    expect(await cline.discover([], dctx())).toEqual([]);
  });
});

// ------------------------------------------------------------------ Cline 3.x tasks

describe('cline legacy tasks', () => {
  it('parses a completed task: title, project, model, tools paired, edits, tokens', async () => {
    const ref = await refByPath(cline, [CLINE_EXT_DIR], CLINE_DONE);
    const st = await parse(cline, ref);
    const r = st.run;
    expect(r.readError).toBeUndefined();
    expect(r.title).toBe('Add a --priority option to the `todo add` command and show it in `todo list`.');
    expect(r.projectName).toBe('todo-cli');
    expect(r.projectPath).toBe('C:\\Users\\alex\\todo-cli');
    expect(r.model).toBe('claude-sonnet-4-5');
    expect(r.inputTokens).toBe(81940);
    expect(r.outputTokens).toBe(1700);
    expect(r.turn).toBe('completed');
    expect(r.openTool).toBeUndefined();
    expect(r.startedAt).toBe(1792900000000);
    expect(kinds(st)).toEqual({ user: 2, reasoning: 1, assistant: 2, tool_call: 6, tool_result: 6, error: 1 });
    expectPaired(st);
    // The failed first edit (diff_error) is an error, not a file change; the two applied edits are.
    expect(r.files).toEqual({ 'todo_cli/cli.py': { ops: ['edit'], count: 2, lastTs: 1792900022300 } });
    const failed = r.events.find((e) => e.toolCallId === 'toolu_01EditCli000000000000002' && e.kind === 'tool_result');
    expect(failed?.isError).toBe(true);
    expect(r.events.find((e) => e.kind === 'error')?.text).toBe('Edit failed: todo_cli/cli.py');
    // Results lose Cline's "[tool for 'x'] Result:" prefix; HAS_CHANGES is stripped.
    expect(r.events.find((e) => e.kind === 'tool_result')?.text.startsWith('import click')).toBe(true);
    expect(r.events.at(-1)?.text).toBe('Added a --priority option to `todo add` and prefixed `todo list` rows with [priority]. All 3 tests pass.');
    const cmd = r.events.find((e) => e.kind === 'tool_call' && e.toolName === 'execute_command');
    expect(cmd).toMatchObject({ toolKind: 'run', text: 'python -m pytest -q', toolCallId: 'toolu_01RunTests00000000000004' });
    expect(r.events.find((e) => e.toolName === 'read_file')?.toolKind).toBe('read');
  });

  it('reads a task waiting for approval of a new file', async () => {
    const ref = await refByPath(cline, [CLINE_EXT_DIR], CLINE_WAITING);
    const st = await parse(cline, ref);
    expect(st.run.turn).toBe('waiting_input');
    expect(st.run.turnDetail).toBe('Waiting for approval to create todo_cli/export.py');
    expect(st.run.openTool).toEqual({ name: 'write_to_file', kind: 'edit', since: 1792900603100 });
    expect(st.run.files['todo_cli/export.py']?.ops).toEqual(['create']);
    expect(kinds(st)).toEqual({ user: 1, assistant: 1, tool_call: 1 });
  });

  it('salvages a task file caught mid-rewrite (corrupt fixture) without throwing', async () => {
    const ref = await refByPath(cline, [CLINE_EXT_DIR], CLINE_CORRUPT);
    const st = await parse(cline, ref);
    expect(st.run.readError).toBeUndefined();
    expect(st.run.skipped).toBeGreaterThanOrEqual(1);
    expect(st.run.title).toBe('Rename the `done` command to `complete`.');
    expect(kinds(st)).toEqual({ user: 1 });
    expect(st.run.turn).toBe('in_progress');
  });
});

// ------------------------------------------------------------------ Roo Code

describe('roo code tasks', () => {
  it('parses a completed task, including calls that never reached the UI', async () => {
    const ref = await refByPath(roo, [ROO_EXT_DIR], ROO_DONE);
    const st = await parse(roo, ref);
    const r = st.run;
    expect(r.title).toBe('Add a `todo clear --done` command that deletes completed items.');
    expect(r.projectPath).toBe('C:\\Users\\alex\\todo-cli');
    expect(r.projectName).toBe('todo-cli');
    expect(r.model).toBeUndefined(); // Roo records a profile name, not a model
    expect(r.inputTokens).toBe(38200);
    expect(r.outputTokens).toBe(535);
    expect(r.turn).toBe('completed');
    expect(kinds(st)).toEqual({ user: 1, reasoning: 1, assistant: 2, tool_call: 4, tool_result: 4, error: 1 });
    expectPaired(st);
    expect(r.files).toEqual({ 'todo_cli/cli.py': { ops: ['edit'], count: 1, lastTs: 1792903602600 } });
    // generate_image (is_error) and read_file (JSON status:error) both count as failed results.
    const errs = r.events.filter((e) => e.kind === 'tool_result' && e.isError).map((e) => e.toolName);
    expect(errs).toEqual(['generate_image', 'read_file']);
    expect(r.tally.errors).toBe(3);
    // The disallowed call shows up right after the call it came with, before the next step.
    const order = r.events.filter((e) => e.kind === 'tool_call').map((e) => e.toolName);
    expect(order).toEqual(['apply_diff', 'execute_command', 'generate_image', 'read_file']);
  });

  it('salvages the in-flight task and reads it as running', async () => {
    const ref = await refByPath(roo, [ROO_EXT_DIR], ROO_INFLIGHT);
    const st = await parse(roo, ref);
    expect(st.run.readError).toBeUndefined();
    expect(st.run.title).toBe('Show overdue todos in red.');
    expect(st.run.skipped).toBe(1);
    expect(st.run.turn).toBe('in_progress');
    expect(judgeStatus(st.run, 0, st.run.lastEventAt! + 30_000).status).toBe('running');
  });

  it('links a subtask to its parent task', async () => {
    const dir = join(tmp(), 'tasks');
    const task = join(dir, 'child-task');
    cpSync(join(ROO_EXT_DIR, 'tasks', ROO_DONE), task, { recursive: true });
    const h = JSON.parse(readFileSync(join(task, 'history_item.json'), 'utf8'));
    writeFileSync(join(task, 'history_item.json'), JSON.stringify({ ...h, parentTaskId: ROO_DONE }));
    const [ref] = await roo.discover([dir], dctx());
    const st = await parse(roo, ref);
    expect(st.run.parentPath).toBe(join(dir, ROO_DONE, 'ui_messages.json'));
  });

  it('treats an answered (auto-approved) tool ask as still running, an unanswered one as waiting', async () => {
    const dir = join(tmp(), 'tasks', 't1');
    mkdirSync(dir, { recursive: true });
    const base = [
      { ts: 1792905000000, type: 'say', say: 'text', text: 'Fix the tests.' },
      { ts: 1792905000100, type: 'ask', ask: 'tool', text: '{"tool":"appliedDiff","path":"a.py","diff":"x"}', isAnswered: true },
    ];
    writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify(base));
    const [ref] = await roo.discover([join(dir, '..')], dctx());
    expect((await parse(roo, ref)).run.turn).toBe('in_progress');
    writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify([base[0], { ...base[1], isAnswered: false }]));
    const st = await parse(roo, freshRef(ref));
    expect(st.run.turn).toBe('waiting_input');
    expect(st.run.turnDetail).toBe('Waiting for approval to edit a.py');
  });

  it('says a Roo command ask may already be running, since Roo never marks those answered', async () => {
    const dir = join(tmp(), 'tasks', 't2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'ui_messages.json'),
      JSON.stringify([
        { ts: 1792905000000, type: 'say', say: 'text', text: 'Fix the tests.' },
        { ts: 1792905000100, type: 'ask', ask: 'command', text: 'pytest -q' },
      ]),
    );
    const [ref] = await roo.discover([join(dir, '..')], dctx());
    const st = await parse(roo, ref);
    expect(st.run.turn).toBe('waiting_input');
    expect(st.run.turnDetail).toBe('Waiting for approval to run: pytest -q (or running it, if auto-approved)');
  });
});

// ------------------------------------------------------------------ Cline 4.x (SDK)

describe('cline 4.x sessions', () => {
  it('parses a failed session: manifest fields, tools paired, patch and editor edits', async () => {
    const ref = await refByPath(cline, [CLINE_DATA], SDK_FAILED);
    const st = await parse(cline, ref);
    const r = st.run;
    expect(r.title).toBe('Add a `--json` flag to `todo list` that prints the items as JSON.');
    expect(r.projectPath).toBe('C:\\Users\\alex\\todo-cli');
    expect(r.projectName).toBe('todo-cli');
    expect(r.model).toBe('claude-sonnet-4-5');
    expect(r.startedAt).toBe(Date.parse('2026-10-25T05:46:40.000Z'));
    expect(r.inputTokens).toBe(39700);
    expect(r.outputTokens).toBe(640);
    expect(kinds(st)).toEqual({ user: 2, reasoning: 1, assistant: 2, tool_call: 4, tool_result: 4, error: 1 });
    expectPaired(st);
    // <user_input> wrappers are stripped.
    expect(r.events.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual([
      'Add a `--json` flag to `todo list` that prints the items as JSON.',
      'Also add a test for it.',
    ]);
    expect(r.files).toEqual({ 'C:\\Users\\alex\\todo-cli\\todo_cli\\cli.py': { ops: ['edit'], count: 2, lastTs: 1792907209900 } });
    expect(r.events.find((e) => e.toolName === 'run_commands' && e.kind === 'tool_result')?.isError).toBe(true);
    expect(r.events.find((e) => e.toolName === 'run_commands')?.toolKind).toBe('run');
    expect(r.turn).toBe('error');
    expect(r.turnDetail).toBe('429 Too Many Requests: rate limit exceeded');
    expect(judgeStatus(r, ref.mtimeMs, r.lastEventAt! + 60_000).status).toBe('failed');
  });

  it('salvages a running session whose messages file was cut off (corrupt fixture)', async () => {
    const ref = await refByPath(cline, [CLINE_DATA], SDK_RUNNING);
    const st = await parse(cline, ref);
    expect(st.run.readError).toBeUndefined();
    expect(st.run.skipped).toBeGreaterThanOrEqual(1);
    expect(st.run.title).toBe('Add due dates to todos.');
    expect(st.run.turn).toBe('in_progress');
    expect(judgeStatus(st.run, 0, st.run.lastEventAt! + 30_000).status).toBe('running');
  });

  it('marks an unanswered tool call as the open tool', async () => {
    const dir = join(tmp(), 'sessions', '1792909000000_abcde');
    mkdirSync(dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(CLINE_DATA, 'sessions', SDK_RUNNING, `${SDK_RUNNING}.json`), 'utf8'));
    writeFileSync(join(dir, '1792909000000_abcde.json'), JSON.stringify({ ...manifest, session_id: '1792909000000_abcde' }));
    writeFileSync(
      join(dir, '1792909000000_abcde.messages.json'),
      JSON.stringify({
        version: 1,
        messages: [
          { role: 'user', content: [{ type: 'text', text: '<user_input mode="act">Run the tests</user_input>' }], ts: 1792909000100 },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'run_commands', input: { commands: ['pytest -q'] } }], ts: 1792909001000 },
        ],
      }),
    );
    const [ref] = await cline.discover([join(dir, '..')], dctx());
    const st = await parse(cline, ref);
    expect(st.run.openTool).toEqual({ name: 'run_commands', kind: 'run', since: 1792909001000 });
    expect(st.run.events.find((e) => e.kind === 'tool_call')?.text).toBe('pytest -q');
    expect(judgeStatus(st.run, 0, 1792909001000 + 60_000)).toEqual({ status: 'running', detail: 'Running run_commands' });
  });
});

// ------------------------------------------------------------------ Continue

describe('continue sessions', () => {
  it('parses an agent session waiting for tool approval', async () => {
    const ref = await refByPath(cont, [CONT_SESSIONS], CONT_WAITING);
    const st = await parse(cont, ref);
    const r = st.run;
    expect(r.title).toBe('Reject empty todo titles');
    expect(r.projectPath).toBe('C:\\Users\\alex\\todo-cli');
    expect(r.projectName).toBe('todo-cli');
    expect(r.model).toBe('Claude Sonnet 4.5');
    expect(r.startedAt).toBe(1792910800000);
    expect(r.inputTokens).toBe(22800);
    expect(r.outputTokens).toBe(272);
    expect(kinds(st)).toEqual({ user: 1, reasoning: 1, assistant: 2, tool_call: 4, tool_result: 3 });
    expect(r.files).toEqual({ 'todo_cli/cli.py': { ops: ['edit'], count: 1 } });
    expect(r.events.find((e) => e.toolCallId === 'toolu_ct1' && e.kind === 'tool_result')?.isError).toBe(true);
    expect(r.turn).toBe('waiting_input');
    expect(r.turnDetail).toBe('Waiting for approval to run run_terminal_command: python -m pytest -q');
    expect(r.openTool?.name).toBe('run_terminal_command');
    expect(judgeStatus(r, ref.mtimeMs, ref.mtimeMs + 10_000).status).toBe('waiting');
    // Pairing: the last call is the only one without a result.
    const detail = toDetail(ref, st, ref.mtimeMs + 10_000, false);
    expect(detail.tools.map((t) => [t.toolName, t.output !== undefined])).toEqual([
      ['read_file', true],
      ['single_find_and_replace', true],
      ['run_terminal_command', true],
      ['run_terminal_command', false],
    ]);
  });

  it('parses a finished chat session and a CLI session with a default title', async () => {
    const chat = await parse(cont, await refByPath(cont, [CONT_SESSIONS], CONT_CHAT));
    expect(chat.run.title).toBe('How does the store persist todos');
    expect(chat.run.turn).toBe('completed');
    expect(kinds(chat)).toEqual({ user: 1, assistant: 1 });
    expect(chat.run.inputTokens).toBe(900);

    const cliRef = await refByPath(cont, [CONT_SESSIONS], CONT_CLI);
    const cli = await parse(cont, cliRef);
    expect(cli.run.title).toBe('list the files in todo_cli'); // "Untitled Session" falls back to the prompt
    expect(cli.run.projectPath).toBe('C:\\Users\\alex\\todo-cli');
    expect(cli.run.turn).toBe('completed');
    expectPaired(cli);
    expect(cli.run.events.find((e) => e.kind === 'tool_call')).toMatchObject({ toolName: 'ls', toolKind: 'search', text: 'todo_cli' });
    // No per-message times: status comes from the file's mtime.
    expect(judgeStatus(cli.run, cliRef.mtimeMs, cliRef.mtimeMs + 60_000).status).toBe('idle');
    expect(judgeStatus(cli.run, cliRef.mtimeMs, cliRef.mtimeMs + 10 * 60_000).status).toBe('done');
  });

  it('reports truncated and garbage session files as unreadable without throwing', async () => {
    const truncated = await parse(cont, await refByPath(cont, [CONT_SESSIONS], CONT_TRUNCATED));
    expect(truncated.run.readError).toMatch(/valid JSON/);
    const refs = await refsOf(cont, [CONT_CORRUPT]);
    expect(refs).toHaveLength(1); // a cut-off sessions.json costs only the hints
    const garbage = await parse(cont, refs[0]);
    expect(garbage.run.readError).toBeTruthy();
    expect(judgeStatus(garbage.run, refs[0].mtimeMs, Date.now()).status).toBe('unreadable');
  });
});

// ------------------------------------------------------------------ format changes and re-reads

describe('unknown formats', () => {
  it('sets readError when a task has only unknown record types', async () => {
    const dir = join(tmp(), 'tasks', '1792999999999');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify([{ ts: 1, type: 'whisper', text: 'x' }, { ts: 2, type: 'say', say: 'hologram' }, 'loose']));
    for (const a of [cline, roo]) {
      const [ref] = await a.discover([join(dir, '..')], dctx());
      const st = await parse(a, ref);
      expect(st.run.readError).toBe(UNRECOGNISED);
      expect(st.run.skipped).toBe(3);
    }
  });

  it('sets readError when the task file is not an array', async () => {
    const dir = join(tmp(), 'tasks', '1792999999998');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify({ messages: [] }));
    const [ref] = await cline.discover([join(dir, '..')], dctx());
    expect((await parse(cline, ref)).run.readError).toBe(UNRECOGNISED);
  });

  it('skips unknown records among known ones', async () => {
    const dir = join(tmp(), 'tasks', '1792999999997');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'ui_messages.json'),
      JSON.stringify([
        { ts: 1792999999997, type: 'say', say: 'task', text: 'Do it' },
        { ts: 1792999999998, type: 'say', say: 'future_feature', text: '?' },
        { ts: 1792999999999, type: 'say', say: 'completion_result', text: 'Done' },
      ]),
    );
    const [ref] = await cline.discover([join(dir, '..')], dctx());
    const st = await parse(cline, ref);
    expect(st.run.readError).toBeUndefined();
    expect(st.run.skipped).toBe(1);
    expect(kinds(st)).toEqual({ user: 1, assistant: 1 });
    expect(st.run.turn).toBe('completed');
  });

  it('sets readError for Cline 4.x and Continue files with only unknown records', async () => {
    const sdkDir = join(tmp(), 'sessions', '1792999000000_zzzzz');
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(join(sdkDir, '1792999000000_zzzzz.messages.json'), JSON.stringify({ messages: [{ role: 'robot', content: 'beep' }] }));
    const [sdkRef] = await cline.discover([join(sdkDir, '..')], dctx());
    expect((await parse(cline, sdkRef)).run.readError).toBe(UNRECOGNISED);

    const contDir = join(tmp(), 'sessions');
    mkdirSync(contDir, { recursive: true });
    writeFileSync(join(contDir, 'a.json'), JSON.stringify({ sessionId: 'a', history: [{ message: { role: 'oracle', content: 'x' } }, { nope: 1 }] }));
    writeFileSync(join(contDir, 'b.json'), JSON.stringify({ sessionId: 'b', conversation: [] }));
    for (const ref of await cont.discover([contDir], dctx())) {
      expect((await parse(cont, ref)).run.readError).toBe(UNRECOGNISED);
    }
  });
});

describe('re-reading whole-file JSON', () => {
  function copyTask(id: string): { dir: string; ui: string; api: string } {
    const dir = join(tmp(), 'tasks', id);
    cpSync(join(CLINE_EXT_DIR, 'tasks', id), dir, { recursive: true });
    return { dir, ui: join(dir, 'ui_messages.json'), api: join(dir, 'api_conversation_history.json') };
  }

  it('returns the previous state when nothing changed, and re-parses when a file did', async () => {
    const { dir, ui, api } = copyTask(CLINE_WAITING);
    const [ref] = await cline.discover([join(dir, '..')], dctx());
    const first = await parse(cline, ref);
    expect(await parse(cline, ref, first)).toBe(first);

    // The agent approves and runs the tool: both files are rewritten.
    const records = JSON.parse(readFileSync(ui, 'utf8'));
    records.push({ ts: 1792900604000, type: 'say', say: 'api_req_started', text: '{"tokensIn":100,"tokensOut":5,"cost":0.001}' });
    records.push({ ts: 1792900605000, type: 'say', say: 'completion_result', text: 'Created todo_cli/export.py.' });
    writeFileSync(ui, JSON.stringify(records));
    const msgs = JSON.parse(readFileSync(api, 'utf8'));
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01WriteExport0000000008', content: "[write_to_file for 'todo_cli/export.py'] Result:\nOK" }], ts: 1792900603900 });
    writeFileSync(api, JSON.stringify(msgs));
    const second = await parse(cline, freshRef(ref), first);
    expect(second).not.toBe(first);
    expect(second.run.turn).toBe('completed');
    expect(second.run.inputTokens).toBe(8900);
    expectPaired(second);
  });

  it('re-parses when only the API history changed', async () => {
    const { dir, api } = copyTask(CLINE_WAITING);
    const [ref] = await cline.discover([join(dir, '..')], dctx());
    const first = await parse(cline, ref);
    expect(first.run.openTool).toBeDefined();
    const msgs = JSON.parse(readFileSync(api, 'utf8'));
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01WriteExport0000000008', content: 'OK' }], ts: 1792900603900 });
    writeFileSync(api, JSON.stringify(msgs));
    const second = await parse(cline, ref, first);
    expect(second).not.toBe(first);
    expect(second.run.events.filter((e) => e.kind === 'tool_result')).toHaveLength(1);
    expect(second.run.openTool).toBeUndefined();
  });

  it('keeps the last good parse when a rewrite is caught half-written', async () => {
    const { dir, ui } = copyTask(CLINE_DONE);
    const [ref] = await cline.discover([join(dir, '..')], dctx());
    const first = await parse(cline, ref);
    writeFileSync(ui, '[{"ts":1792900000000,"type":"say","say":"ta');
    const second = await parse(cline, freshRef(ref), first);
    expect(second).toBe(first);
    expect(second.run.readError).toBeUndefined();
  });
});

// ------------------------------------------------------------------ status

describe('status', () => {
  it('reads a finished task as idle, then done', async () => {
    const st = await parse(cline, await refByPath(cline, [CLINE_EXT_DIR], CLINE_DONE));
    const last = st.run.lastEventAt!;
    expect(judgeStatus(st.run, 0, last + 60_000).status).toBe('idle');
    expect(judgeStatus(st.run, 0, last + 10 * 60_000).status).toBe('done');
  });

  it('reads a waiting task as waiting and an api_req_failed task as failed', async () => {
    const st = await parse(cline, await refByPath(cline, [CLINE_EXT_DIR], CLINE_WAITING));
    expect(judgeStatus(st.run, 0, st.run.lastEventAt! + 60_000).status).toBe('waiting');

    const dir = join(tmp(), 'tasks', '1792999999990');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'ui_messages.json'),
      JSON.stringify([
        { ts: 1792999999990, type: 'say', say: 'task', text: 'Do it' },
        { ts: 1792999999991, type: 'say', say: 'api_req_started', text: '{"request":"..."}' },
        { ts: 1792999999992, type: 'ask', ask: 'api_req_failed', text: '529 Overloaded' },
      ]),
    );
    const [ref] = await cline.discover([join(dir, '..')], dctx());
    const failed = await parse(cline, ref);
    expect(failed.run.turn).toBe('error');
    expect(judgeStatus(failed.run, 0, 1792999999992 + 1000)).toEqual({ status: 'failed', detail: 'API request failed: 529 Overloaded' });
    expect(failed.run.tally.errors).toBe(1);
  });

  it('reads a task cancelled by the user as aborted, and an in-flight request as running', async () => {
    const dir = join(tmp(), 'tasks', '1792999999980');
    mkdirSync(dir, { recursive: true });
    const records = [
      { ts: 1792999999980, type: 'say', say: 'task', text: 'Do it' },
      { ts: 1792999999981, type: 'say', say: 'api_req_started', text: '{"request":"..."}' },
    ];
    writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify(records));
    const [ref] = await cline.discover([join(dir, '..')], dctx());
    const live = await parse(cline, ref);
    expect(live.run.turn).toBe('in_progress');
    expect(judgeStatus(live.run, 0, 1792999999981 + 30_000).status).toBe('running');

    records[1].text = '{"request":"...","cancelReason":"user_cancelled","cost":0}';
    writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify(records) + ' ');
    const cancelled = await parse(cline, freshRef(ref), live);
    expect(cancelled.run.turn).toBe('aborted');
  });
});

// ------------------------------------------------------------------ review fixes

describe('review fixes', () => {
  function task(records: object[], api?: object[]): string {
    const dir = join(tmp(), 'tasks', String(1792990000000 + Math.floor(Math.random() * 1e6)));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify(records));
    if (api) writeFileSync(join(dir, 'api_conversation_history.json'), JSON.stringify(api));
    return dir;
  }

  it('does not mark a successful result as failed because the file it read mentions an error', async () => {
    // A compact JSON file that happens to look like Roo's error object, read through Cline.
    const fileBody = '{"status":"error","message":"The tool execution failed","error":"sample"}';
    const dir = task(
      [
        { ts: 1792990000000, type: 'say', say: 'task', text: 'Look at the fixture' },
        { ts: 1792990000100, type: 'say', say: 'tool', text: '{"tool":"readFile","path":"fixture.json"}', conversationHistoryIndex: 0 },
        { ts: 1792990000200, type: 'say', say: 'tool', text: '{"tool":"editedExistingFile","path":"fixture.json","content":"x"}', conversationHistoryIndex: 2 },
        { ts: 1792990000300, type: 'say', say: 'api_req_started', text: '{}', conversationHistoryIndex: 4 },
      ],
      [
        { role: 'user', content: [{ type: 'text', text: '<task>Look</task>' }], ts: 1792990000050 },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'fixture.json' } }], ts: 1792990000090 },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: `[read_file for 'fixture.json'] Result:\n${fileBody}` }], ts: 1792990000150 },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'replace_in_file', input: { path: 'fixture.json' } }], ts: 1792990000190 },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'e1', content: [{ type: 'text', text: `Saved. New content:\n${fileBody}` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo'.repeat(500) } }] }],
          ts: 1792990000250,
        },
      ],
    );
    const [ref] = await cline.discover([join(dir, '..')], dctx());
    const st = await parse(cline, ref);
    const results = st.run.events.filter((e) => e.kind === 'tool_result');
    expect(results.map((e) => e.isError)).toEqual([false, false]);
    expect(st.run.tally.errors).toBe(0);
    expect(st.run.files['fixture.json']?.count).toBe(1); // the edit still counts as a file change
    // Images in results become a placeholder, not base64.
    expect(results[1].text).toContain('[image]');
    expect(results[1].text).not.toContain('iVBORw0KGgo');
  });

  it('judges the turn from the record before trailing checkpoints', async () => {
    const done = task([
      { ts: 1792990001000, type: 'say', say: 'task', text: 'Do it' },
      { ts: 1792990001100, type: 'say', say: 'completion_result', text: 'Done' },
      { ts: 1792990001200, type: 'ask', ask: 'completion_result', text: '' },
      { ts: 1792990001300, type: 'say', say: 'checkpoint_created' },
    ]);
    const [doneRef] = await cline.discover([join(done, '..')], dctx());
    expect((await parse(cline, doneRef)).run.turn).toBe('completed');

    // Cline writes the checkpoint after an approved edit ran: that ask is no longer waiting.
    const ran = task([
      { ts: 1792990002000, type: 'say', say: 'task', text: 'Do it' },
      { ts: 1792990002100, type: 'ask', ask: 'tool', text: '{"tool":"editedExistingFile","path":"a.py","content":"x"}' },
      { ts: 1792990002200, type: 'say', say: 'checkpoint_created' },
    ]);
    const [ranRef] = await cline.discover([join(ran, '..')], dctx());
    expect((await parse(cline, ranRef)).run.turn).toBe('in_progress');
  });

  it('pairs thousands of tool calls without slowing down quadratically', async () => {
    const n = 2400; // 2 events per call: stays under MAX_EVENTS so none are dropped
    const ui: object[] = [{ ts: 1792991000000, type: 'say', say: 'task', text: 'Big task' }];
    const api: object[] = [{ role: 'user', content: 'Big task', ts: 1792991000000 }];
    for (let i = 0; i < n; i++) {
      const t = 1792991000000 + (i + 1) * 10;
      ui.push({ ts: t + 1, type: 'say', say: 'tool', text: '{"tool":"readFile","path":"f.py"}', conversationHistoryIndex: api.length - 1 });
      api.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read_file', input: { path: 'f.py' } }], ts: t });
      api.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }], ts: t + 5 });
      ui.push({ ts: t + 6, type: 'say', say: 'api_req_started', text: '{"tokensIn":1,"tokensOut":1}', conversationHistoryIndex: api.length - 1 });
    }
    const dir = task(ui, api);
    const [ref] = await cline.discover([join(dir, '..')], dctx());
    const t0 = Date.now();
    const st = await parse(cline, ref);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(st.run.tally.toolCalls).toBe(n);
    expectPaired(st);
    expect(st.run.events.filter((e) => e.kind === 'tool_call').every((e, i) => e.toolCallId === `t${i}`)).toBe(true);
  });

  it('lists a resumed 3.x task under its old id as a 4.x session, and hides it from the 3.x list', async () => {
    const root = tmp();
    const legacyId = '1792900600000';
    cpSync(join(CLINE_EXT_DIR, 'tasks', legacyId), join(root, 'ext', 'tasks', legacyId), { recursive: true });
    const sdkDir = join(root, 'data', 'sessions', legacyId);
    mkdirSync(sdkDir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(CLINE_DATA, 'sessions', SDK_FAILED, `${SDK_FAILED}.json`), 'utf8'));
    writeFileSync(join(sdkDir, `${legacyId}.json`), JSON.stringify({ ...manifest, session_id: legacyId, status: 'idle', metadata: { ...manifest.metadata, legacyTask: true } }));
    writeFileSync(
      join(sdkDir, `${legacyId}.messages.json`),
      JSON.stringify({
        version: 1,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Add a `todo export` command that writes todos.csv.' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Creating it.' }] },
          { role: 'user', content: 'Warning: this is a legacy conversation, which means tool names may have changed. Please use the most up-to-date tools you are aware of.' },
          {
            role: 'user',
            content: [{ type: 'text', text: '<mode_notice>The user switched from plan mode to act mode before sending this message.</mode_notice><user_input mode="act">Go ahead</user_input>' }],
            ts: 1792990003000,
          },
          { role: 'user', content: [{ type: 'text', text: 'Hook says: lint is clean' }], metadata: { displayRole: 'system' }, ts: 1792990003100 },
          { role: 'user', content: [{ type: 'text', text: '<user_command slash="team">spawn a team</user_command>' }], ts: 1792990003200 },
          { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], ts: 1792990004000 },
        ],
      }),
    );
    const refs = await cline.discover([join(root, 'ext'), join(root, 'data')], dctx());
    expect(refs).toHaveLength(1);
    expect(refs[0].hint).toMatchObject({ kind: 'sdk', sessionId: legacyId });
    const st = await parse(cline, refs[0]);
    expect(st.run.events.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual([
      'Add a `todo export` command that writes todos.csv.',
      'Go ahead',
      '/team spawn a team',
    ]);
    const system = st.run.events.filter((e) => e.kind === 'system').map((e) => e.text);
    expect(system).toEqual(['Resumed a Cline 3.x task', 'Context added: Hook says: lint is clean']);
    expect(st.run.turn).toBe('completed');
  });

  it('reads a 4.x session closed mid-run (stale-session reconciler) as interrupted, not failed', async () => {
    const dir = join(tmp(), 'sessions', '1792990005000_qwert');
    mkdirSync(dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(CLINE_DATA, 'sessions', SDK_RUNNING, `${SDK_RUNNING}.json`), 'utf8'));
    writeFileSync(
      join(dir, '1792990005000_qwert.json'),
      JSON.stringify({ ...manifest, session_id: '1792990005000_qwert', status: 'failed', exit_code: 1, metadata: { ...manifest.metadata, terminal_marker: 'failed_external_process_exit' } }),
    );
    writeFileSync(join(dir, '1792990005000_qwert.messages.json'), JSON.stringify({ messages: [{ role: 'user', content: '<user_input mode="act">Go</user_input>', ts: 1792990005100 }] }));
    const [ref] = await cline.discover([join(dir, '..')], dctx());
    const st = await parse(cline, ref);
    expect(st.run.turn).toBe('aborted');
    expect(judgeStatus(st.run, 0, 1792990005100 + 10 * 60_000).status).toBe('done');
  });

  it('reads a Continue session whose last tool call was cancelled as aborted', async () => {
    const dir = join(tmp(), 'sessions');
    mkdirSync(dir, { recursive: true });
    const call = { id: 'c1', type: 'function', function: { name: 'run_terminal_command', arguments: '{"command":"rm -rf build"}' } };
    writeFileSync(
      join(dir, 'x.json'),
      JSON.stringify({
        sessionId: 'x',
        title: 'Clean',
        workspaceDirectory: 'file:///home/alex/todo-cli',
        history: [
          { message: { role: 'user', content: 'Clean the build' }, contextItems: [] },
          { message: { role: 'assistant', content: '', toolCalls: [call] }, contextItems: [], toolCallStates: [{ toolCallId: 'c1', toolCall: call, status: 'canceled', parsedArgs: { command: 'rm -rf build' } }] },
        ],
      }),
    );
    const [ref] = await cont.discover([dir], dctx());
    const st = await parse(cont, ref);
    expect(st.run.turn).toBe('aborted');
    expect(st.run.turnDetail).toBe('run_terminal_command was cancelled');
    expect(st.run.projectPath).toBe('/home/alex/todo-cli');
  });

  it('ignores temp files, lock folders, checkpoints, caches and databases as watch noise', () => {
    const g = 'C:\\Users\\alex\\AppData\\Roaming\\Code\\User\\globalStorage';
    const relevant = [
      `${g}\\saoudrizwan.claude-dev\\tasks\\1792900000000\\ui_messages.json`,
      `${g}\\saoudrizwan.claude-dev\\state\\taskHistory.json`,
      `${g}\\rooveterinaryinc.roo-cline\\tasks\\019a\\history_item.json`,
      '/home/alex/.cline/data/sessions/1792907200000_k3x9q/1792907200000_k3x9q.json',
      '/home/alex/.continue/sessions/abc.json',
      '/srv/custom/tasks/1/ui_messages.json',
    ];
    const noise = [
      `${g}\\saoudrizwan.claude-dev\\tasks\\1792900000000\\ui_messages.json.tmp.1792900902001.k3j9xq.json`,
      `${g}\\rooveterinaryinc.roo-cline\\tasks\\019a\\.ui_messages.json.new_1792904001600_x7k2p9q.tmp`,
      `${g}\\rooveterinaryinc.roo-cline\\tasks\\019a\\ui_messages.json.lock`,
      `${g}\\rooveterinaryinc.roo-cline\\tasks\\019a\\checkpoints\\HEAD`,
      `${g}\\saoudrizwan.claude-dev\\checkpoints\\123\\x`,
      `${g}\\saoudrizwan.claude-dev\\cache\\models.json`,
      '/home/alex/.cline/data/db/sessions.db-wal',
      '/home/alex/.cline/data/logs/cline.log',
      '/home/alex/.continue/index/lancedb/x',
    ];
    for (const p of relevant) expect([p, cline.isRelevantChange!(p)]).toEqual([p, true]);
    for (const p of noise) expect([p, roo.isRelevantChange!(p)]).toEqual([p, false]);
  });
});

// ------------------------------------------------------------------ helpers

describe('helpers', () => {
  it('decodes VS Code folder URIs and leaves plain paths alone', () => {
    expect(uriToPath('file:///c%3A/Users/alex/todo-cli')).toBe('C:\\Users\\alex\\todo-cli');
    expect(uriToPath('file:///home/alex/todo%20cli')).toBe('/home/alex/todo cli');
    expect(uriToPath('/home/alex/todo-cli')).toBe('/home/alex/todo-cli');
    expect(uriToPath('vscode-remote://ssh-remote+box/home/alex')).toBe('vscode-remote://ssh-remote+box/home/alex');
  });

  it('recovers the complete leading elements of a cut-off array', () => {
    const text = '[{"a":1},{"b":"x}]{"},{"c":[1,2';
    expect(salvageArray(text, 0)).toEqual([{ a: 1 }, { b: 'x}]{' }]);
    expect(salvageArray('[]', 0)).toEqual([]);
  });
});
