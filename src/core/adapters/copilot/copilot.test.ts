import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Env, ParseContext, ParseState, SessionRef, SourceAdapter } from '../../adapter';
import { safeParse } from '../../build';
import { judgeStatus } from '../../status';
import { adapters, copilotCliAdapter as cli, copilotVscodeAdapter as vscode } from './index';

const FIX = resolve(__dirname, '../../../../test/fixtures/copilot');
const VS_USER = join(FIX, 'vscode', 'User');
const WS = join(VS_USER, 'workspaceStorage', '5e8f0c2b9a7d4f1e8c3b6a2d9e0f1a4b');
const VS_ID = '3f1c2a9e-7b4d-4e21-9c55-0d8e6a1b2c3d';
const VS_LOG = join(WS, 'chatSessions', `${VS_ID}.jsonl`);
const VS_SNAP = join(WS, 'chatSessions', `${VS_ID}.json`);
const VS_LEGACY = join(VS_USER, 'globalStorage', 'emptyWindowChatSessions', '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d.json');
const CLI_ID = '9d4e1f7a-2b3c-4d5e-8f60-71829a3b4c5d';
const CLI_EVENTS = join(FIX, 'cli', 'session-state', CLI_ID, 'events.jsonl');

const temps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'arm-copilot-'));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const env: Env = { platform: process.platform, home: tmpdir(), vars: {} };
const ctx = (): ParseContext => ({ env, tempDir: tmp() });

function refFor(adapter: SourceAdapter, path: string, hint?: Record<string, string>): SessionRef {
  const s = statSync(path);
  return { agent: adapter.id, path, mtimeMs: s.mtimeMs, size: s.size, hint };
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

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
}

async function vsHint(): Promise<Record<string, string> | undefined> {
  const refs = await vscode.discover([VS_USER], { env, since: 0, projectRoots: [] });
  return refs.find((r) => r.path === VS_LOG)?.hint;
}

// ------------------------------------------------------------------ roots

describe('defaultRoots', () => {
  it('lists the VS Code user dirs per OS', () => {
    const win = vscode.defaultRoots({ platform: 'win32', home: 'C:\\Users\\alex', vars: { APPDATA: 'C:\\Users\\alex\\AppData\\Roaming' } });
    expect(win).toContain('C:\\Users\\alex\\AppData\\Roaming\\Code\\User');
    expect(win).toContain('C:\\Users\\alex\\AppData\\Roaming\\Code - Insiders\\User');
    expect(win).toContain('C:\\Users\\alex\\AppData\\Roaming\\VSCodium\\User');
    const mac = vscode.defaultRoots({ platform: 'darwin', home: '/Users/alex', vars: {} });
    expect(mac).toContain('/Users/alex/Library/Application Support/Code/User');
    const linux = vscode.defaultRoots({ platform: 'linux', home: '/home/alex', vars: {} });
    expect(linux).toContain('/home/alex/.config/Code/User');
    const xdg = vscode.defaultRoots({ platform: 'linux', home: '/home/alex', vars: { XDG_CONFIG_HOME: '/home/alex/cfg' } });
    expect(xdg).toContain('/home/alex/cfg/VSCodium/User');
    const portable = vscode.defaultRoots({ platform: 'linux', home: '/home/alex', vars: { VSCODE_PORTABLE: '/opt/code/data' } });
    expect(portable[0]).toBe('/opt/code/data/user-data/User');
  });

  it('lists the Copilot CLI session store, honouring COPILOT_HOME', () => {
    expect(cli.defaultRoots({ platform: 'win32', home: 'C:\\Users\\alex', vars: {} })).toEqual(['C:\\Users\\alex\\.copilot\\session-state']);
    expect(cli.defaultRoots({ platform: 'linux', home: '/home/alex', vars: {} })).toEqual(['/home/alex/.copilot/session-state']);
    expect(cli.defaultRoots({ platform: 'darwin', home: '/Users/alex', vars: { COPILOT_HOME: '/Users/alex/cp' } })).toEqual(['/Users/alex/cp/session-state']);
  });

  it('exports both adapters', () => {
    expect(adapters.map((a) => a.id)).toEqual(['copilot-vscode', 'copilot-cli']);
    for (const a of adapters) expect(a.confidence).toBe('source');
  });
});

// ------------------------------------------------------------------ discovery

describe('discover', () => {
  it('finds VS Code sessions under a fake home, maps the workspace hash to its folder, honours since', async () => {
    const home = tmp();
    const e: Env = { platform: process.platform, home, vars: { APPDATA: join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(home, '.config') } };
    const userDir = vscode.defaultRoots(e)[0];
    cpSync(VS_USER, userDir, { recursive: true });
    const refs = await vscode.discover(vscode.defaultRoots(e), { env: e, since: 0, projectRoots: [] });
    expect(refs).toHaveLength(2);
    const log = refs.find((r) => r.path.endsWith(`${VS_ID}.jsonl`))!;
    expect(log.agent).toBe('copilot-vscode');
    expect(log.hint?.project).toBe('todo-cli');
    expect(log.hint?.projectPath).toBe('c:\\Users\\alex\\projects\\todo-cli');
    expect(log.hint?.alt).toMatch(/\.json$/);
    expect(refs.some((r) => r.path.endsWith('6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d.json'))).toBe(true);

    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(join(userDir, 'globalStorage', 'emptyWindowChatSessions', '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d.json'), old, old);
    const recent = await vscode.discover(vscode.defaultRoots(e), { env: e, since: Date.parse('2021-01-01T00:00:00Z'), projectRoots: [] });
    expect(recent).toHaveLength(1);
  });

  it('finds Copilot CLI sessions under ~/.copilot and COPILOT_HOME', async () => {
    const home = tmp();
    const e: Env = { platform: process.platform, home, vars: {} };
    cpSync(join(FIX, 'cli', 'session-state'), join(home, '.copilot', 'session-state'), { recursive: true });
    const refs = await cli.discover(cli.defaultRoots(e), { env: e, since: 0, projectRoots: [] });
    expect(refs).toHaveLength(1);
    expect(refs[0].path.endsWith('events.jsonl')).toBe(true);
    expect(refs[0].hint?.sessionId).toBe(CLI_ID);

    const other = tmp();
    cpSync(join(FIX, 'cli', 'session-state'), join(other, 'session-state'), { recursive: true });
    const viaEnv = await cli.discover(cli.defaultRoots({ ...e, vars: { COPILOT_HOME: other } }), { env: e, since: 0, projectRoots: [] });
    expect(viaEnv).toHaveLength(1);
    // The COPILOT_HOME folder itself also works as a custom root.
    expect(await cli.discover([other], { env: e, since: 0, projectRoots: [] })).toHaveLength(1);
    expect(await cli.discover([other], { env: e, since: Date.now() + 60_000, projectRoots: [] })).toHaveLength(0);
  });

  it('returns nothing for missing roots', async () => {
    const missing = join(tmpdir(), 'arm-copilot-does-not-exist', 'x');
    await expect(vscode.discover([missing], { env, since: 0, projectRoots: [] })).resolves.toEqual([]);
    await expect(cli.discover([missing], { env, since: 0, projectRoots: [] })).resolves.toEqual([]);
  });
});

// ------------------------------------------------------------------ VS Code parse

describe('copilot-vscode parse', () => {
  it('replays the .jsonl mutation log', async () => {
    const ref = refFor(vscode, VS_LOG, await vsHint());
    const st = await vscode.parse(ref, undefined, ctx());
    const r = st.run;
    expect(r.readError).toBeUndefined();
    // customTitle (set by a kind:1 line) wins over the first prompt, as in VS Code.
    expect(r.title).toBe('Add --done flag to todo-cli');
    expect(r.projectName).toBe('todo-cli');
    expect(r.projectPath).toBe('c:\\Users\\alex\\projects\\todo-cli');
    expect(r.model).toBe('claude-sonnet-4.5');
    expect(r.startedAt).toBe(1792310400000);
    expect(kinds(st)).toEqual({ user: 3, assistant: 5, reasoning: 1, tool_call: 4, tool_result: 4, file_change: 1, error: 1, system: 1 });
    expectPaired(st);
    expect(r.tally.errors).toBe(2); // the 503 and the failed read
    expect(Object.keys(r.files)).toEqual(['c:\\Users\\alex\\projects\\todo-cli\\todo_cli\\main.py']);
    expect(r.files['c:\\Users\\alex\\projects\\todo-cli\\todo_cli\\main.py'].count).toBe(1);
    expect(r.inputTokens).toBe(18234);
    expect(r.outputTokens).toBe(912);
    // The last request was cancelled by the user.
    expect(r.turn).toBe('aborted');
    expect(r.skipped).toBe(0);

    const tools = r.events.filter((e) => e.kind === 'tool_call');
    expect(tools.map((t) => t.toolKind)).toEqual(['read', 'read', 'edit', 'run']);
    expect(tools[0].text).toContain('main.py'); // raw arguments from toolCallRounds
    expect(tools[3].text).toBe('python -m pytest -q');
    const term = r.events.find((e) => e.kind === 'tool_result' && e.toolName === 'run_in_terminal')!;
    expect(term.isError).toBe(false);
    expect(term.text).toContain('exit code 1');
    expect(term.durationMs).toBe(1800);
    expect(r.events.find((e) => e.kind === 'reasoning')!.text).toContain('--done flag');
    // The kind:2 splice with i:0 replaced the third response.
    const lastAssistant = r.events.filter((e) => e.kind === 'assistant').at(-1)!;
    expect(lastAssistant.text).toBe('Let me check the storage module first.');
    expect(r.events.find((e) => e.kind === 'error')!.text).toContain('Server error: 503');
  });

  it('reads the flat .json snapshot of the same session the same way', async () => {
    const hint = await vsHint();
    const log = await vscode.parse(refFor(vscode, VS_LOG, hint), undefined, ctx());
    const snap = await vscode.parse(refFor(vscode, VS_SNAP, hint), undefined, ctx());
    expect(snap.run.readError).toBeUndefined();
    expect(kinds(snap)).toEqual(kinds(log));
    expect(snap.run.events.map((e) => e.text)).toEqual(log.run.events.map((e) => e.text));
    expect(snap.run.turn).toBe('aborted');
    expect(snap.run.inputTokens).toBe(18234);
  });

  it('reads an older v2 snapshot with string responses and a workingDirectory', async () => {
    const st = await vscode.parse(refFor(vscode, VS_LEGACY), undefined, ctx());
    expect(st.run.title).toBe('Explain a list comprehension'); // v2 computedTitle
    expect(st.run.projectName).toBe('scratch');
    expect(st.run.projectPath).toBe('/home/alex/scratch');
    expect(st.run.model).toBe('gpt-4.1');
    expect(kinds(st)).toEqual({ user: 1, assistant: 1 });
    expect(st.run.events[1].text).toBe('It builds a new list with each truthy item doubled.');
    expect(st.run.turn).toBe('completed');
  });

  it('returns the previous state when a snapshot did not change', async () => {
    const ref = refFor(vscode, VS_SNAP);
    const first = await vscode.parse(ref, undefined, ctx());
    expect(await vscode.parse(ref, first, ctx())).toBe(first);
  });

  it('skips the corrupt lines and keeps the good records', async () => {
    const path = join(FIX, 'vscode', 'corrupt', `${VS_ID}-corrupt.jsonl`);
    const st = await safeParse(vscode, refFor(vscode, path), undefined, ctx());
    expect(st.run.readError).toBeUndefined();
    expect(st.run.skipped).toBeGreaterThanOrEqual(1);
    expect(st.run.title).toContain('--done flag');
    expect(st.run.tally.toolCalls).toBe(4);
    expect(st.run.files['c:\\Users\\alex\\projects\\todo-cli\\todo_cli\\main.py']).toBeDefined();
  });

  it('flags a file with only unknown records', async () => {
    const st = await safeParse(vscode, refFor(vscode, join(FIX, 'vscode', 'unknown-only.jsonl')), undefined, ctx());
    expect(st.run.readError).toMatch(/No records this app recognises/);
    expect(st.run.events).toHaveLength(0);
  });

  it('continues incrementally and matches one full parse', async () => {
    const full = readFileSync(VS_LOG);
    const cut = Math.floor(full.length / 2) + 7; // lands mid-line
    const path = join(tmp(), `${VS_ID}.jsonl`);
    writeFileSync(path, full.subarray(0, cut));
    const first = await vscode.parse(refFor(vscode, path), undefined, ctx());
    expect(first.offset).toBeLessThan(cut);
    appendFileSync(path, full.subarray(cut));
    const second = await vscode.parse(refFor(vscode, path), first, ctx());
    const once = await vscode.parse(refFor(vscode, VS_LOG), undefined, ctx());
    expect(second.offset).toBe(full.length);
    expect(second.run.events).toEqual(once.run.events);
    expect(second.run.turn).toBe(once.run.turn);
  });

  it('starts over when the log is compacted into a single snapshot line', async () => {
    const path = join(tmp(), `${VS_ID}.jsonl`);
    writeFileSync(path, readFileSync(VS_LOG));
    const first = await vscode.parse(refFor(vscode, path), undefined, ctx());
    const snapshot = JSON.parse(readFileSync(VS_SNAP, 'utf8'));
    snapshot.requests = snapshot.requests.slice(0, 1);
    writeFileSync(path, `${JSON.stringify({ kind: 0, v: snapshot })}\n`);
    const second = await vscode.parse(refFor(vscode, path), first, ctx());
    expect(second.run.tally.messages).toBe(4); // one prompt, three answers
    expect(second.run.turn).toBe('completed');
  });

  it('judges status: finished reads done, an open tool reads running, an unconfirmed tool reads waiting', async () => {
    const st = await vscode.parse(refFor(vscode, VS_LOG, await vsHint()), undefined, ctx());
    expect(judgeStatus(st.run, 0, st.run.lastEventAt! + 10 * 60_000).status).toBe('done');
    expect(judgeStatus(st.run, 0, st.run.lastEventAt! + 60_000).status).toBe('idle');

    // First request still in flight (modelState 2, no result) with a terminal tool running.
    // VS Code 1.143 writes isComplete:true for every tool and marks open ones with summary.kind "incomplete".
    const head = lines(VS_LOG).slice(0, 4);
    const tool = (confirmed: boolean, legacy = false) => ({
      kind: 2,
      k: ['requests', 0, 'response'],
      v: [
        {
          kind: 'toolInvocationSerialized',
          invocationMessage: { value: 'Running `npm test`' },
          ...(confirmed ? { isConfirmed: { type: 1 } } : {}),
          ...(legacy ? { isComplete: false } : { isComplete: true, summary: { kind: 'incomplete' } }),
          toolCallId: 'toolu_live',
          toolId: 'run_in_terminal',
        },
      ],
    });
    const live = join(tmp(), 'live.jsonl');
    writeFileSync(live, [...head, JSON.stringify(tool(true))].join('\n') + '\n');
    const running = await vscode.parse(refFor(vscode, live), undefined, ctx());
    expect(running.run.turn).toBe('in_progress');
    expect(running.run.openTool?.name).toBe('run_in_terminal');
    expect(running.run.openTool?.kind).toBe('run');
    const now = running.run.openTool!.since + 60_000;
    expect(judgeStatus(running.run, now - 30_000, now).status).toBe('running');
    expect(running.run.events.filter((e) => e.kind === 'tool_result')).toHaveLength(0);

    const older = join(tmp(), 'older.jsonl');
    writeFileSync(older, [...head, JSON.stringify(tool(true, true))].join('\n') + '\n');
    expect((await vscode.parse(refFor(vscode, older), undefined, ctx())).run.openTool?.name).toBe('run_in_terminal');

    const ask = join(tmp(), 'ask.jsonl');
    writeFileSync(ask, [...head, JSON.stringify(tool(false))].join('\n') + '\n');
    const waiting = await vscode.parse(refFor(vscode, ask), undefined, ctx());
    expect(judgeStatus(waiting.run, Date.now(), Date.now()).status).toBe('waiting');
  });
});

// ------------------------------------------------------------------ Copilot CLI parse

describe('copilot-cli parse', () => {
  it('parses events.jsonl with workspace.yaml', async () => {
    const st = await cli.parse(refFor(cli, CLI_EVENTS), undefined, ctx());
    const r = st.run;
    expect(r.readError).toBeUndefined();
    expect(r.title).toBe('Add --done flag to todo-cli complete command'); // workspace.yaml summary
    expect(r.projectName).toBe('todo-cli');
    expect(r.projectPath).toBe('C:\\Users\\alex\\projects\\todo-cli');
    expect(r.gitBranch).toBe('main');
    expect(r.model).toBe('gpt-5.1');
    expect(r.startedAt).toBe(Date.parse('2026-10-16T09:00:00.000Z'));
    expect(r.lastEventAt).toBe(Date.parse('2026-10-16T09:01:03.710Z'));
    expect(kinds(st)).toEqual({ system: 7, user: 2, reasoning: 1, assistant: 3, tool_call: 5, tool_result: 5, file_change: 1, error: 1 });
    expectPaired(st);
    expect(r.tally.errors).toBe(3); // missing file, rejected create, session.error
    expect(r.files).toEqual({ 'C:\\Users\\alex\\projects\\todo-cli\\todo_cli\\main.py': { ops: ['edit'], count: 1, lastTs: Date.parse('2026-10-16T09:00:14.350Z') } });
    expect(r.inputTokens).toBe(61234);
    expect(r.outputTokens).toBe(404);
    // The user interrupted the last turn; the "request aborted" error belongs to that.
    expect(r.turn).toBe('aborted');
    expect(r.skipped).toBe(0);

    const calls = r.events.filter((e) => e.kind === 'tool_call');
    expect(calls.map((c) => `${c.toolName}:${c.toolKind}`)).toEqual(['view:read', 'view:read', 'edit:edit', 'powershell:run', 'create:edit']);
    const editResult = r.events.find((e) => e.kind === 'tool_result' && e.toolName === 'edit')!;
    expect(editResult.durationMs).toBe(4250);
    const rejected = r.events.find((e) => e.kind === 'tool_result' && e.toolName === 'create')!;
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toBe('The user rejected this tool call.');
  });

  it('uses a user-set name from workspace.yaml as the title', async () => {
    const dir = join(tmp(), CLI_ID);
    cpSync(join(FIX, 'cli', 'session-state', CLI_ID), dir, { recursive: true });
    appendFileSync(join(dir, 'workspace.yaml'), 'name: "Done flag work"\nuser_named: true\n');
    const st = await cli.parse(refFor(cli, join(dir, 'events.jsonl')), undefined, ctx());
    expect(st.run.title).toBe('Done flag work');
  });

  it('skips the corrupt lines and keeps the good records', async () => {
    const st = await safeParse(cli, refFor(cli, join(FIX, 'cli', 'corrupt', 'events-corrupt.jsonl')), undefined, ctx());
    expect(st.run.readError).toBeUndefined();
    expect(st.run.skipped).toBe(2); // a cut-off JSON line and a non-JSON line
    expect(st.run.title).toBe('Add a --done flag to the complete command and fix the tests');
    expect(st.run.tally.toolCalls).toBe(4); // view, view, edit, powershell
    // The cut-off last line is left for the next read, so the powershell call is still open.
    expect(st.run.turn).toBe('in_progress');
    expect(st.run.openTool?.name).toBe('powershell');
  });

  it('flags a file with only unknown records', async () => {
    const st = await safeParse(cli, refFor(cli, join(FIX, 'cli', 'unknown-only.jsonl')), undefined, ctx());
    expect(st.run.readError).toMatch(/No records this app recognises/);
    expect(st.run.skipped).toBe(2);
  });

  it('continues incrementally and matches one full parse', async () => {
    const full = readFileSync(CLI_EVENTS);
    const cut = Math.floor(full.length / 2) + 11; // lands mid-line
    const path = join(tmp(), 'events.jsonl');
    writeFileSync(path, full.subarray(0, cut));
    const first = await cli.parse(refFor(cli, path), undefined, ctx());
    expect(first.offset).toBeLessThan(cut);
    expect(first.run.turn).toBe('in_progress');
    appendFileSync(path, full.subarray(cut));
    const second = await cli.parse(refFor(cli, path), first, ctx());
    // Compare against a copy without workspace.yaml so only the transcript differs.
    const alone = join(tmp(), 'events.jsonl');
    writeFileSync(alone, full);
    const once = await cli.parse(refFor(cli, alone), undefined, ctx());
    expect(second.offset).toBe(full.length);
    expect(second.run.events).toEqual(once.run.events);
    expect(second.run.turn).toBe(once.run.turn);
    expect(second.run.outputTokens).toBe(once.run.outputTokens);
    expect(JSON.parse(JSON.stringify(second.extra))).toEqual(second.extra); // plain data only
  });

  it('starts over when the transcript shrinks', async () => {
    const path = join(tmp(), 'events.jsonl');
    writeFileSync(path, readFileSync(CLI_EVENTS));
    const first = await cli.parse(refFor(cli, path), undefined, ctx());
    writeFileSync(path, lines(CLI_EVENTS).slice(0, 3).join('\n') + '\n');
    const second = await cli.parse(refFor(cli, path), first, ctx());
    expect(second.run.tally.events).toBe(2); // model change + first prompt
    expect(second.run.turn).toBe('in_progress');
  });

  it('judges status: finished reads done, mid-tool reads running, open permission reads waiting', async () => {
    const done = await cli.parse(refFor(cli, CLI_EVENTS), undefined, ctx());
    expect(judgeStatus(done.run, 0, done.run.lastEventAt! + 10 * 60_000).status).toBe('done');

    const all = lines(CLI_EVENTS);
    const mid = join(tmp(), 'events.jsonl');
    writeFileSync(mid, all.slice(0, 20).join('\n') + '\n'); // ends on tool.execution_start powershell
    const running = await cli.parse(refFor(cli, mid), undefined, ctx());
    expect(running.run.openTool).toMatchObject({ name: 'powershell', kind: 'run' });
    const now = running.run.lastEventAt! + 30_000;
    expect(judgeStatus(running.run, 0, now)).toEqual({ status: 'running', detail: 'Running powershell' });

    const perm = join(tmp(), 'events.jsonl');
    writeFileSync(perm, all.slice(0, 14).join('\n') + '\n'); // ends on permission.requested
    const waiting = await cli.parse(refFor(cli, perm), undefined, ctx());
    expect(waiting.run.turn).toBe('waiting_input');
    expect(judgeStatus(waiting.run, 0, now).status).toBe('waiting');
    expect(waiting.run.turnDetail).toContain('main.py');
  });
/** Envelope helper for synthetic CLI events. */
  const evt = (type: string, data: Record<string, unknown>, sec: number) =>
    JSON.stringify({ type, data, id: `e${sec}`, timestamp: new Date(Date.parse('2026-10-16T10:00:00.000Z') + sec * 1000).toISOString(), parentId: null });
  const start = evt('session.start', { sessionId: 's1', version: 1, selectedModel: 'gpt-5.1', context: { cwd: '/home/alex/todo-cli' } }, 0);
  const shutdown = (sec: number, input: number, output: number) =>
    evt('session.shutdown', { shutdownType: 'routine', modelMetrics: { 'gpt-5.1': { requests: { count: 1, cost: 1 }, usage: { inputTokens: input, outputTokens: output } } }, codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } }, sec);

  it('takes token totals from the newest shutdown: each one is cumulative across resumes', async () => {
    const path = join(tmp(), 'events.jsonl');
    writeFileSync(path, [start, evt('user.message', { content: 'hi', source: 'user' }, 1), shutdown(2, 100, 10), evt('session.resume', { selectedModel: 'gpt-5.1' }, 3), evt('user.message', { content: 'more', source: 'user' }, 4), shutdown(5, 250, 30)].join('\n') + '\n');
    const st = await cli.parse(refFor(cli, path), undefined, ctx());
    expect(st.run.inputTokens).toBe(250);
    expect(st.run.outputTokens).toBe(30);
    expect(st.run.turn).toBe('completed');
  });

  it('pairs a shell command the user ran directly (tool.user_requested) with its result', async () => {
    const path = join(tmp(), 'events.jsonl');
    writeFileSync(path, [start, evt('tool.user_requested', { toolCallId: 'u1', toolName: 'bash', arguments: { command: 'ls' } }, 1), evt('tool.execution_complete', { toolCallId: 'u1', success: true, isUserRequested: true, result: { content: 'a.txt' } }, 2)].join('\n') + '\n');
    const st = await cli.parse(refFor(cli, path), undefined, ctx());
    expectPaired(st);
    expect(st.run.events.find((e) => e.kind === 'tool_call')).toMatchObject({ toolName: 'bash', toolKind: 'run', text: 'ls' });
    expect(st.run.skipped).toBe(0);
  });

  it('an error the agent recovers from does not fail the turn; an abort survives a trailing turn_end', async () => {
    const base = [start, evt('user.message', { content: 'go', source: 'user' }, 1), evt('assistant.turn_start', { turnId: '0' }, 2), evt('session.error', { errorType: 'rate_limit', message: 'Too many requests' }, 3)];
    const failed = join(tmp(), 'events.jsonl');
    writeFileSync(failed, base.join('\n') + '\n');
    const f = await cli.parse(refFor(cli, failed), undefined, ctx());
    expect(f.run.turn).toBe('error');
    expect(judgeStatus(f.run, 0, Date.parse('2026-10-16T10:00:10Z')).status).toBe('failed');

    const recovered = join(tmp(), 'events.jsonl');
    writeFileSync(recovered, [...base, evt('assistant.turn_start', { turnId: '1' }, 4), evt('assistant.message', { content: 'Done.', toolRequests: [] }, 5)].join('\n') + '\n');
    expect((await cli.parse(refFor(cli, recovered), undefined, ctx())).run.turn).toBe('in_progress');
    appendFileSync(recovered, evt('assistant.turn_end', { turnId: '1' }, 6) + '\n');
    expect((await cli.parse(refFor(cli, recovered), undefined, ctx())).run.turn).toBe('completed');

    const aborted = join(tmp(), 'events.jsonl');
    writeFileSync(aborted, [start, evt('user.message', { content: 'go', source: 'user' }, 1), evt('assistant.turn_start', { turnId: '0' }, 2), evt('abort', { reason: 'user initiated' }, 3), evt('assistant.turn_end', { turnId: '0' }, 4)].join('\n') + '\n');
    expect((await cli.parse(refFor(cli, aborted), undefined, ctx())).run.turn).toBe('aborted');
  });

  it('does not change the previous state while continuing', async () => {
    const full = readFileSync(CLI_EVENTS);
    const cut = Math.floor(full.length / 2) + 11;
    const path = join(tmp(), 'events.jsonl');
    writeFileSync(path, full.subarray(0, cut));
    const first = await cli.parse(refFor(cli, path), undefined, ctx());
    const before = JSON.stringify(first);
    appendFileSync(path, full.subarray(cut));
    await cli.parse(refFor(cli, path), first, ctx());
    expect(JSON.stringify(first)).toBe(before);
  });
});
