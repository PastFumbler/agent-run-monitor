import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env, ParseContext, ParseState, SessionRef } from '../../adapter';
import { safeParse, toDetail } from '../../build';
import { judgeStatus } from '../../status';
import { adapter, adapters } from './index';

const FIX = fileURLToPath(new URL('../../../../test/fixtures/claude-code/', import.meta.url));
const SID = '7c1e4b2a-3f5d-4e8a-9b6c-2d1f0a9e8c71';
const PROJ = join(FIX, 'claude-config', 'projects', 'C--Users-alex-code-todo-cli');
const MAIN = join(PROJ, `${SID}.jsonl`);
const SUB = join(PROJ, SID, 'subagents');
const WF = join(SUB, 'workflows', 'wf_5d2e9a41-7b3');
const JOURNAL = join(WF, 'journal.jsonl');
const AGENT_OK = join(WF, 'agent-a3f19c07be52d4e81.jsonl');
const AGENT_FAILED = join(WF, 'agent-b7d20e4c19fa36d05.jsonl');
const SUBAGENT = join(SUB, 'agent-e4b8c21f07d93a5b6.jsonl');

let tmp: string;
const env = (home: string, vars: Record<string, string> = {}): Env => ({ platform: process.platform, home, vars });
const ctx = (): ParseContext => ({ env: env(tmp), tempDir: join(tmp, 'scratch') });

async function ref(path: string, hint?: Record<string, string>): Promise<SessionRef> {
  const s = await stat(path);
  return { agent: 'claude-code', path, mtimeMs: s.mtimeMs, size: s.size, hint };
}

async function parse(path: string, prev?: ParseState, hint?: Record<string, string>): Promise<ParseState> {
  return adapter.parse(await ref(path, hint), prev, ctx());
}

function kinds(st: ParseState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of st.run.events) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

/** Everything a full parse and an incremental parse must agree on. */
function comparable(st: ParseState) {
  const r = st.run;
  return {
    events: r.events, title: r.title, model: r.model, turn: r.turn, turnDetail: r.turnDetail, tally: r.tally,
    files: r.files, usage: r.usage, changes: r.changes, hasReasoning: r.hasReasoning, projectPath: r.projectPath,
    gitBranch: r.gitBranch, openTool: r.openTool, skipped: r.skipped, offset: st.offset,
  };
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'arm-claude-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('claude-code defaultRoots', () => {
  it('uses ~/.claude on Windows and honours CLAUDE_CONFIG_DIR first', () => {
    expect(adapter.defaultRoots({ platform: 'win32', home: 'C:\\Users\\alex', vars: {} })).toEqual(['C:\\Users\\alex\\.claude']);
    expect(adapter.defaultRoots({ platform: 'win32', home: 'C:\\Users\\alex', vars: { CLAUDE_CONFIG_DIR: 'D:\\claude-work' } })).toEqual([
      'D:\\claude-work',
      'C:\\Users\\alex\\.claude',
    ]);
    // An override equal to the default is not listed twice.
    expect(adapter.defaultRoots({ platform: 'win32', home: 'C:\\Users\\alex', vars: { CLAUDE_CONFIG_DIR: 'C:\\users\\alex\\.claude' } })).toHaveLength(1);
  });

  it('adds the legacy XDG folder on macOS and Linux', () => {
    expect(adapter.defaultRoots({ platform: 'linux', home: '/home/alex', vars: {} })).toEqual(['/home/alex/.claude', '/home/alex/.config/claude']);
    expect(adapter.defaultRoots({ platform: 'linux', home: '/home/alex', vars: { XDG_CONFIG_HOME: '/data/cfg' } })).toEqual([
      '/home/alex/.claude',
      '/data/cfg/claude',
    ]);
    expect(adapter.defaultRoots({ platform: 'darwin', home: '/Users/alex', vars: { CLAUDE_CONFIG_DIR: '/Users/alex/cc2' } })[0]).toBe('/Users/alex/cc2');
  });

  it('exports the adapter list', () => {
    expect(adapters.map((a) => a.id)).toEqual(['claude-code']);
    expect(adapter.confidence).toBe('verified');
  });
});

describe('claude-code discover', () => {
  let home: string;
  beforeAll(async () => {
    home = join(tmp, 'home');
    await cp(join(FIX, 'claude-config'), join(home, '.claude'), { recursive: true });
  });

  it('finds main sessions, sub-agents, workflow runs and workflow agents', async () => {
    const e = env(home);
    const refs = await adapter.discover(adapter.defaultRoots(e), { env: e, since: 0, projectRoots: [] });
    const by = (k: string) => refs.filter((r) => r.hint?.kind === k);
    expect(refs).toHaveLength(5);
    expect(by('session').map((r) => r.path)).toEqual([join(home, '.claude', 'projects', 'C--Users-alex-code-todo-cli', `${SID}.jsonl`)]);
    const main = by('session')[0].path;
    expect(by('subagent')).toHaveLength(1);
    expect(by('subagent')[0].hint?.parent).toBe(main);
    expect(by('workflow')).toHaveLength(1);
    expect(by('workflow')[0].hint?.parent).toBe(main);
    expect(by('workflow')[0].hint?.runId).toBe('wf_5d2e9a41-7b3');
    // Two agent transcripts; the third attempt has only a meta file.
    expect(by('workflow-agent')).toHaveLength(2);
    for (const r of by('workflow-agent')) expect(r.hint?.parent).toBe(by('workflow')[0].path);
    for (const r of refs) {
      expect(r.agent).toBe('claude-code');
      expect(r.size).toBeGreaterThan(0);
    }
  });

  it('honours since and accepts a projects folder as the root', async () => {
    const main = join(home, '.claude', 'projects', 'C--Users-alex-code-todo-cli', `${SID}.jsonl`);
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(main, old, old);
    const e = env(home);
    const refs = await adapter.discover([join(home, '.claude')], { env: e, since: Date.parse('2021-01-01T00:00:00Z'), projectRoots: [] });
    expect(refs.find((r) => r.path === main)).toBeUndefined();
    expect(refs).toHaveLength(4);
    const direct = await adapter.discover([join(home, '.claude', 'projects')], { env: e, since: 0, projectRoots: [] });
    expect(direct).toHaveLength(5);
  });

  it('accepts one project folder that directly holds the session files', async () => {
    const e = env(home);
    const projDir = join(home, '.claude', 'projects', 'C--Users-alex-code-todo-cli');
    const refs = await adapter.discover([projDir], { env: e, since: 0, projectRoots: [] });
    expect(refs).toHaveLength(5);
    const main = refs.find((r) => r.hint?.kind === 'session')!;
    expect(main.path).toBe(join(projDir, `${SID}.jsonl`));
    expect(main.hint?.project).toBe('C--Users-alex-code-todo-cli');
    // Same files as through the default root, so adding both lists each run once.
    const both = await adapter.discover([join(home, '.claude'), projDir], { env: e, since: 0, projectRoots: [] });
    expect(both).toHaveLength(5);
  });

  it('accepts the folder that holds .claude, and a renamed copy of the projects folder', async () => {
    const e = env(home);
    expect(await adapter.discover([home], { env: e, since: 0, projectRoots: [] })).toHaveLength(5);
    const copy = join(tmp, 'backup-of-claude-projects');
    await cp(join(home, '.claude', 'projects'), copy, { recursive: true });
    const refs = await adapter.discover([copy], { env: e, since: 0, projectRoots: [] });
    expect(refs).toHaveLength(5);
    expect(refs.find((r) => r.hint?.kind === 'session')!.hint?.project).toBe('C--Users-alex-code-todo-cli');
  });

  it('finds nothing in a folder without session files (the UI then says which folder to pick)', async () => {
    const e = env(home);
    const other = join(tmp, 'unrelated');
    await mkdir(join(other, 'logs'), { recursive: true });
    await writeFile(join(other, 'logs', 'events.jsonl'), '{"a":1}\n');
    await writeFile(join(other, 'notes.jsonl'), '{"a":1}\n');
    await expect(adapter.discover([other], { env: e, since: 0, projectRoots: [] })).resolves.toEqual([]);
  });

  it('returns nothing for a missing root', async () => {
    const e = env(join(tmp, 'nobody'));
    await expect(adapter.discover([join(tmp, 'nobody', '.claude'), ''], { env: e, since: 0, projectRoots: [] })).resolves.toEqual([]);
  });
});

describe('claude-code parse: main session', () => {
  let st: ParseState;
  beforeAll(async () => {
    st = await parse(MAIN);
  });

  it('reads title, project, model, branch and tokens', () => {
    const r = st.run;
    expect(r.title).toBe('todo-cli: due dates'); // the user's rename wins over the first prompt
    expect(r.projectPath).toBe('C:\\Users\\alex\\code\\todo-cli');
    expect(r.projectName).toBe('todo-cli');
    expect(r.model).toBe('claude-opus-5-5');
    expect(r.gitBranch).toBe('main');
    expect(r.startedAt).toBe(Date.parse('2026-03-14T09:12:03.000Z')); // first record, a queue operation
    expect(r.lastEventAt).toBe(Date.parse('2026-03-14T09:16:30.584Z'));
    // 12 API messages, usage counted once per message id, cache reads and writes kept apart.
    expect(r.usage).toMatchObject({ input: 12 * 2, output: 2025, cacheRead: 12 * 20000, cacheWrite: 12 * 900 });
    expect(Object.values(r.usage!.byDay!).reduce((n, d) => n + (d.output ?? 0), 0)).toBe(2025);
    // Per message: on the first event of each message only.
    const tagged = r.events.filter((e) => e.usage);
    expect(tagged).toHaveLength(12);
    expect(tagged.reduce((n, e) => n + (e.usage!.output ?? 0), 0)).toBe(2025);
    expect(r.readError).toBeUndefined();
    expect(r.parentPath).toBeUndefined();
  });

  it('turns records into the right events', () => {
    expect(kinds(st)).toEqual({ user: 3, system: 5, reasoning: 4, assistant: 5, tool_call: 10, tool_result: 10, error: 1 });
    const users = st.run.events.filter((e) => e.kind === 'user').map((e) => e.text);
    expect(users[0]).toMatch(/^Add a `--due` option/);
    expect(users.some((t) => t.includes('system-reminder'))).toBe(false);
    expect(st.run.tally).toEqual({ events: 38, messages: 8, toolCalls: 10, errors: 4 });
    // Unrecognised top-level types: none in this fixture.
    expect(st.run.skipped).toBe(0);
  });

  it('pairs every tool call with its result', () => {
    const calls = st.run.events.filter((e) => e.kind === 'tool_call');
    const results = st.run.events.filter((e) => e.kind === 'tool_result');
    for (const res of results) {
      const call = calls.find((c) => c.toolCallId === res.toolCallId);
      expect(call, res.toolCallId).toBeDefined();
      expect(res.toolName).toBe(call!.toolName);
    }
    const bash = results.find((e) => e.toolCallId === 'toolu_01vfqvWbu7Jb0jN2lXC3Hmw5')!;
    expect(bash.durationMs).toBe(3000);
    expect(results.filter((e) => e.isError).map((e) => e.toolName)).toEqual(['Bash', 'Edit', 'Bash']);
    expect(calls.find((c) => c.toolName === 'Workflow')?.toolKind).toBe('agent');
    expect(calls.find((c) => c.toolName === 'Read')?.toolKind).toBe('read');
    const detail = toDetail(adapterRef(), st, Date.parse('2026-03-15T00:00:00Z'), false);
    expect(detail.tools).toHaveLength(10);
    expect(detail.tools.every((t) => !t.open)).toBe(true);
  });

  it('counts edited files, minus the failed edit, and marks the created one', () => {
    const store = 'C:\\Users\\alex\\code\\todo-cli\\todo\\store.py';
    const dates = 'C:\\Users\\alex\\code\\todo-cli\\todo\\dates.py';
    expect(Object.keys(st.run.files).sort()).toEqual([dates, store]);
    expect(st.run.files[store].ops).toEqual(['edit']);
    expect(st.run.files[dates].ops).toEqual(['create']);
    const write = st.run.events.find((e) => e.toolName === 'Write' && e.kind === 'tool_call');
    expect(write?.fileOp).toBe('create');
    // The linter's change to cli.py is shown but not counted as an agent edit.
    expect(st.run.events.some((e) => e.kind === 'system' && e.filePath?.endsWith('cli.py'))).toBe(true);
  });

  it('records each successful edit with its diff, from the result patch', () => {
    const store = 'C:\\Users\\alex\\code\\todo-cli\\todo\\store.py';
    const dates = 'C:\\Users\\alex\\code\\todo-cli\\todo\\dates.py';
    const changes = st.run.changes!;
    // The failed Edit of cli.py is not a change.
    expect(changes.map((c) => [c.filePath, c.op, c.linesAdded, c.linesRemoved])).toEqual([
      [store, 'edit', 1, 0],
      [dates, 'create', 5, 0],
    ]);
    expect(changes[0].ts).toBe(Date.parse('2026-03-14T09:12:17.628Z'));
    expect(changes[0].toolCallId).toBe('toolu_01jeC0tsgcDKIADVDnwVXUoi');
    expect(changes[0].diff).toBe('@@ -6,3 +6,4 @@\n     id: int\n     title: str\n     done: bool = False\n+    due: str | None = None');
    expect(changes[1].diff!.split('\n')[0]).toBe('@@ -0,0 +1,5 @@');
    const detail = toDetail(adapterRef(), st, Date.parse('2026-03-15T00:00:00Z'), false);
    expect(detail.changes).toEqual(changes);
    expect(detail.totalChanges).toBe(2);
  });

  it('marks thinking stored without its text as a placeholder', () => {
    const thoughts = st.run.events.filter((e) => e.kind === 'reasoning');
    expect(thoughts.filter((e) => e.placeholder)).toHaveLength(3);
    expect(thoughts.find((e) => !e.placeholder)?.text).toMatch(/^The add command builds a Task/);
    expect(st.run.hasReasoning).toBe(true);
  });

  it('reads a finished turn as idle, then done', () => {
    expect(st.run.turn).toBe('completed');
    expect(st.run.openTool).toBeUndefined();
    const last = st.run.lastEventAt!;
    expect(judgeStatus(st.run, last, last + 60_000).status).toBe('idle');
    expect(judgeStatus(st.run, last, last + 10 * 60_000).status).toBe('done');
  });

  function adapterRef(): SessionRef {
    return { agent: 'claude-code', path: MAIN, mtimeMs: st.run.lastEventAt!, size: st.size };
  }
});

describe('claude-code parse: child runs', () => {
  it('parses an Agent-tool sub-agent that is still running', async () => {
    const st = await parse(SUBAGENT);
    const r = st.run;
    expect(r.title).toBe('Find due-date callers'); // from agent-*.meta.json
    expect(r.parentPath).toBe(MAIN);
    expect(r.gitBranch).toBe('feature/due-dates');
    expect(r.projectName).toBe('todo-cli');
    expect(kinds(st)).toEqual({ user: 1, reasoning: 1, assistant: 1, tool_call: 2, tool_result: 1 });
    expect(r.events.find((e) => e.kind === 'reasoning')?.text).toContain('1.8 s');
    expect(r.usage).toMatchObject({ output: 95 + 60, input: 2 * 3, cacheWrite: 2 * 500, cacheRead: 2 * 12000 }); // the repeated message counted once, at its last value
    expect(r.hasReasoning).toBeFalsy(); // its one thinking block was stored without text
    expect(r.turn).toBe('in_progress');
    expect(r.openTool).toEqual({ name: 'Bash', kind: 'run', since: Date.parse('2026-03-14T10:02:05.000Z') });
    const j = judgeStatus(r, r.lastEventAt!, r.lastEventAt! + 30_000);
    expect(j.status).toBe('running');
    expect(j.detail).toBe('Running Bash');
    expect(judgeStatus(r, r.lastEventAt!, r.lastEventAt! + 13 * 60_000).status).toBe('stuck');
  });

  it('parses a successful workflow agent', async () => {
    const st = await parse(AGENT_OK);
    expect(st.run.title).toBe('review:logic');
    expect(st.run.parentPath).toBe(JOURNAL);
    expect(st.run.events.filter((e) => e.kind === 'tool_call').map((e) => e.toolName)).toEqual(['Bash', 'Read', 'StructuredOutput']);
    expect(st.run.turn).toBe('completed'); // the StructuredOutput result ends the turn
  });

  it('reads a rate-limited workflow agent as failed', async () => {
    const st = await parse(AGENT_FAILED);
    expect(st.run.turn).toBe('error');
    expect(st.run.turnDetail).toContain('429');
    expect(st.run.model).toBeUndefined(); // "<synthetic>" is not a model
    expect(kinds(st)).toEqual({ user: 1, error: 1 });
    expect(judgeStatus(st.run, 0, Date.parse('2026-03-14T09:21:00Z')).status).toBe('failed');
  });

  it('parses the workflow journal as a run with one call per agent attempt', async () => {
    const st = await parse(JOURNAL);
    const r = st.run;
    expect(r.title).toBe('review-due-dates: Review the due-date change with two reviewers');
    expect(r.parentPath).toBe(MAIN);
    expect(r.projectName).toBe('todo-cli');
    expect(r.model).toBe('claude-opus-5-5');
    expect(kinds(st)).toEqual({ system: 1, tool_call: 3, tool_result: 3 });
    const results = r.events.filter((e) => e.kind === 'tool_result');
    expect(results.map((e) => [e.toolCallId, !!e.isError])).toEqual([
      ['b7d20e4c19fa36d05', true],
      ['a3f19c07be52d4e81', false],
      ['c0e8a5d2f1b7934ce', false],
    ]);
    expect(results[1].text).toMatch(/^Clean: /);
    expect(r.events.filter((e) => e.kind === 'tool_call')[2].text).toBe('review:tests (Review), retry');
    expect(r.turn).toBe('completed'); // the failed key was retried and passed
    expect(r.startedAt).toBe(1773480010400);
    expect(judgeStatus(r, 0, r.lastEventAt! + 10 * 60_000).status).toBe('done');
  });

  it('reads a workflow mid-run as running, with names from the script', async () => {
    const dir = join(tmp, 'wf-live', 'projects', 'C--Users-alex-code-todo-cli');
    const sessionDir = join(dir, SID);
    const wdir = join(sessionDir, 'subagents', 'workflows', 'wf_5d2e9a41-7b3');
    await mkdir(wdir, { recursive: true });
    await cp(join(PROJ, SID, 'workflows', 'scripts'), join(sessionDir, 'workflows', 'scripts'), { recursive: true });
    await cp(MAIN, join(dir, `${SID}.jsonl`));
    const lines = (await readFile(JOURNAL, 'utf8')).split('\n').slice(0, 3).join('\n') + '\n';
    await writeFile(join(wdir, 'journal.jsonl'), lines);
    await cp(AGENT_OK, join(wdir, 'agent-a3f19c07be52d4e81.jsonl'));
    const st = await parse(join(wdir, 'journal.jsonl'));
    expect(st.run.title).toBe('review-due-dates: Review the due-date change with two reviewers');
    expect(st.run.projectPath).toBe('C:\\Users\\alex\\code\\todo-cli');
    expect(st.run.turn).toBe('in_progress');
    expect(st.run.openTool?.name).toBe('review:tests');
    const now = Date.now();
    expect(judgeStatus(st.run, now - 5_000, now).status).toBe('running');
  });
});

describe('claude-code parse: damaged and unfamiliar files', () => {
  it('skips corrupt lines and keeps the good records', async () => {
    const r0 = await ref(join(FIX, 'claude-code-corrupt.jsonl'));
    const st = await safeParse(adapter, r0, undefined, ctx());
    expect(st.run.readError).toBeUndefined();
    expect(st.run.skipped).toBe(2); // the cut-off record and the garbage line
    expect(st.run.title).toMatch(/^Add a `--due` option/);
    expect(st.run.events.some((e) => e.kind === 'tool_call' && e.toolName === 'Edit')).toBe(true);
    expect(st.offset).toBeLessThan(r0.size); // the unfinished last line is held back
  });

  it('flags a file of only unknown records without throwing', async () => {
    const st = await safeParse(adapter, await ref(join(FIX, 'unknown-types.jsonl')), undefined, ctx());
    expect(st.run.readError).toBe('No records this app recognises; the agent may have changed its format.');
    expect(st.run.skipped).toBe(3);
    expect(judgeStatus(st.run, 0, Date.now()).status).toBe('unreadable');
  });

  it('turns an unreadable file into an unreadable run', async () => {
    const st = await safeParse(adapter, { agent: 'claude-code', path: join(tmp, 'gone.jsonl'), mtimeMs: 0, size: 10 }, undefined, ctx());
    expect(st.run.readError).toMatch(/gone/);
  });
});

describe('claude-code incremental parsing', () => {
  it('gives the same run when the file arrives in pieces, split lines included', async () => {
    const full = await readFile(MAIN);
    const path = join(tmp, 'inc', `${SID}.jsonl`);
    await mkdir(join(tmp, 'inc'), { recursive: true });
    // Cut 1 lands inside a record; cut 2 lands between a tool call and its result.
    const text = full.toString('utf8');
    const cut2 = Buffer.byteLength(text.slice(0, text.indexOf('"tool_use_id":"toolu_01SQsGroVWBi563SejwFNHxw"')), 'utf8') - 40;
    const cut1 = Math.floor(cut2 * 0.6);
    expect(full[cut1 - 1]).not.toBe(0x0a);
    expect(cut2).toBeGreaterThan(cut1);
    await writeFile(path, full.subarray(0, cut1));
    const a = await parse(path, undefined, { kind: 'session' });
    expect(a.offset).toBeLessThan(cut1); // the partial line waits
    await appendFile(path, full.subarray(cut1, cut2));
    const b = await parse(path, a, { kind: 'session' });
    expect(b.run.openTool?.name).toBe('Bash');
    await appendFile(path, full.subarray(cut2));
    const c = await parse(path, b, { kind: 'session' });
    const once = await parse(path, undefined, { kind: 'session' });
    expect(comparable(c)).toEqual(comparable(once));
    // The earlier state was not mutated by the later parses.
    expect(a.run.events.length).toBeLessThan(c.run.events.length);
  });

  it('starts over when the file shrinks', async () => {
    const path = join(tmp, 'inc', 'shrink.jsonl');
    await cp(MAIN, path);
    const big = await parse(path, undefined, { kind: 'session' });
    const lines = (await readFile(MAIN, 'utf8')).split('\n').slice(0, 5).join('\n') + '\n';
    await writeFile(path, lines);
    const small = await parse(path, big, { kind: 'session' });
    expect(comparable(small)).toEqual(comparable(await parse(path, undefined, { kind: 'session' })));
    expect(small.run.tally.toolCalls).toBe(0);
  });
});

describe('claude-code waits', () => {
  async function liveSession(name: string, pid: number) {
    const root = join(tmp, name);
    const dir = join(root, 'projects', 'C--Users-alex-code-todo-cli');
    await mkdir(dir, { recursive: true });
    await mkdir(join(root, 'sessions'), { recursive: true });
    // Up to and including the first Bash tool_use: a call with no result yet.
    const lines = (await readFile(MAIN, 'utf8')).split('\n').slice(0, 11).join('\n') + '\n';
    const path = join(dir, `${SID}.jsonl`);
    await writeFile(path, lines);
    const reg = JSON.parse(await readFile(join(FIX, 'claude-config', 'sessions', '18424.json'), 'utf8'));
    await writeFile(join(root, 'sessions', `${pid}.json`), JSON.stringify({ ...reg, pid }));
    return path;
  }

  it('shows a permission prompt from a live registry entry as waiting', async () => {
    const path = await liveSession('reg-live', process.pid);
    const st = await parse(path);
    expect(st.run.turn).toBe('waiting_input');
    expect(judgeStatus(st.run, 0, st.run.lastEventAt! + 1000)).toEqual({ status: 'waiting', detail: 'Waiting for tool approval' });
  });

  it('ignores a registry entry whose process is gone', async () => {
    const path = await liveSession('reg-dead', 2147483646);
    const st = await parse(path);
    expect(st.run.turn).toBe('in_progress');
    expect(st.run.openTool?.name).toBe('Bash');
    expect(judgeStatus(st.run, 0, st.run.lastEventAt! + 1000).status).toBe('running');
  });

  it('reads an open AskUserQuestion call as waiting for an answer', async () => {
    const path = join(tmp, 'ask.jsonl');
    const base = { sessionId: SID, cwd: '/home/alex/code/todo-cli', isSidechain: false };
    await writeFile(
      path,
      [
        { ...base, type: 'user', timestamp: '2026-03-14T09:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: 'Pick a date format' } },
        {
          ...base,
          type: 'assistant',
          timestamp: '2026-03-14T09:00:02.000Z',
          message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [] } }] },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    const st = await parse(path, undefined, { kind: 'session' });
    expect(st.run.projectName).toBe('todo-cli');
    expect(st.run.turn).toBe('waiting_input');
    expect(judgeStatus(st.run, 0, Date.parse('2026-03-14T09:30:00Z')).status).toBe('waiting');
  });

  it('reads an interrupted turn as aborted', async () => {
    const path = join(tmp, 'interrupted.jsonl');
    const lines = (await readFile(MAIN, 'utf8')).split('\n').slice(0, 41).join('\n') + '\n';
    await writeFile(path, lines);
    const st = await parse(path, undefined, { kind: 'session' });
    expect(st.run.turn).toBe('aborted');
    expect(st.run.turnDetail).toBe('You stopped a tool call');
    expect(st.run.openTool).toBeUndefined();
  });
});

describe('claude-code user records and turn edges', () => {
  const base = { sessionId: SID, cwd: 'C:\\Users\\alex\\code\\todo-cli', isSidechain: false, gitBranch: 'main' };
  let n = 0;
  async function write(records: Record<string, unknown>[]): Promise<string> {
    const path = join(tmp, `edge-${++n}.jsonl`);
    await writeFile(path, records.map((r) => JSON.stringify({ ...base, ...r })).join('\n') + '\n');
    return path;
  }
  const human = (ts: string, content: unknown) => ({ type: 'user', timestamp: ts, origin: { kind: 'human' }, message: { role: 'user', content } });
  const text = (ts: string, id: string, t: string, stop: string | null = 'end_turn', model = 'claude-opus-5-5') => ({
    type: 'assistant',
    timestamp: ts,
    message: { id, model, role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: t }] },
  });

  it('splits IDE and reminder blocks from the typed prompt (shape seen on the real install)', async () => {
    const path = await write([
      human('2026-03-14T09:00:00.000Z', [
        { type: 'text', text: '<system-reminder>\nThe user opened todo/cli.py in the IDE.\n</system-reminder>' },
        { type: 'text', text: 'Rename the --due flag to --by' },
      ]),
      human('2026-03-14T09:00:01.000Z', [
        { type: 'text', text: '<ide_opened_file>The user opened the file todo/store.py in the IDE.</ide_opened_file>' },
        { type: 'text', text: 'and update the help text' },
      ]),
    ]);
    const st = await parse(path, undefined, { kind: 'session' });
    expect(st.run.events.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual(['Rename the --due flag to --by', 'and update the help text']);
    expect(st.run.events.filter((e) => e.kind === 'system')).toHaveLength(2);
    expect(st.run.title).toBe('Rename the --due flag to --by');
    expect(st.run.turn).toBe('in_progress'); // the prompt started a turn even though it led with a reminder
  });

  it('starts a turn for a prompt-style slash command but not for a local one', async () => {
    const local = await write([
      human('2026-03-14T09:00:00.000Z', 'Hi'),
      text('2026-03-14T09:00:02.000Z', 'msg_a', 'Hello.'),
      { type: 'user', timestamp: '2026-03-14T09:00:03.000Z', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>' } },
      { type: 'user', timestamp: '2026-03-14T09:00:03.100Z', message: { role: 'user', content: '<local-command-stdout>Set model to opus</local-command-stdout>' } },
    ]);
    const a = await parse(local, undefined, { kind: 'session' });
    expect(a.run.turn).toBe('completed');
    expect(a.run.title).toBe('Hi');
    const skill = await write([
      human('2026-03-14T09:00:00.000Z', 'Hi'),
      text('2026-03-14T09:00:02.000Z', 'msg_a', 'Hello.'),
      human('2026-03-14T09:00:03.000Z', '<command-message>review is running…</command-message>\n<command-name>/review</command-name>'),
    ]);
    const b = await parse(skill, undefined, { kind: 'session' });
    expect(b.run.turn).toBe('in_progress');
    expect(b.run.events.filter((e) => e.kind === 'user')).toHaveLength(1);
  });

  it('keeps retrying API errors running and fails the turn when retries run out', async () => {
    const retry = (ts: string, attempt: number) => ({
      type: 'system', subtype: 'api_error', level: 'error', timestamp: ts, retryAttempt: attempt, maxRetries: 10,
      error: { message: 'Overloaded' },
    });
    const p1 = await write([human('2026-03-14T09:00:00.000Z', 'Go'), retry('2026-03-14T09:00:05.000Z', 3)]);
    const s1 = await parse(p1, undefined, { kind: 'session' });
    expect(s1.run.turn).toBe('in_progress');
    expect(s1.run.tally.errors).toBe(1);
    const p2 = await write([human('2026-03-14T09:00:00.000Z', 'Go'), retry('2026-03-14T09:05:00.000Z', 10)]);
    const s2 = await parse(p2, undefined, { kind: 'session' });
    expect(s2.run.turn).toBe('error');
    expect(judgeStatus(s2.run, 0, Date.parse('2026-03-14T09:05:10Z')).status).toBe('failed');
    // A synthetic API-error message in a main session fails the turn too.
    const p3 = await write([
      human('2026-03-14T09:00:00.000Z', 'Go'),
      { type: 'assistant', timestamp: '2026-03-14T09:00:09.000Z', isApiErrorMessage: true, error: 'server_error', apiErrorStatus: 529,
        message: { id: 'msg_e', model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } },
    ]);
    const s3 = await parse(p3, undefined, { kind: 'session' });
    expect(s3.run.turn).toBe('error');
    expect(s3.run.turnDetail).toBe('API error 529: 529 Overloaded');
  });

  it('reads a plain interrupt as aborted, not failed, and ignores the synthetic follow-up', async () => {
    const path = await write([
      human('2026-03-14T09:00:00.000Z', 'Go'),
      { type: 'assistant', timestamp: '2026-03-14T09:00:02.000Z', isAbortedMidStream: true,
        message: { id: 'msg_b', model: 'claude-opus-5-5', role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'Let me' }] } },
      { type: 'user', timestamp: '2026-03-14T09:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      text('2026-03-14T09:00:03.100Z', 'msg_c', 'No response requested.', 'stop_sequence', '<synthetic>'),
    ]);
    const st = await parse(path, undefined, { kind: 'session' });
    expect(st.run.turn).toBe('aborted');
    expect(st.run.turnDetail).toBe('Interrupted by you');
    expect(st.run.model).toBe('claude-opus-5-5');
    expect(judgeStatus(st.run, 0, Date.parse('2026-03-14T10:00:00Z')).status).toBe('done');
  });

  it('keeps inline sidechain records out of the main run', async () => {
    const path = await write([
      human('2026-03-14T09:00:00.000Z', 'Go'),
      text('2026-03-14T09:00:02.000Z', 'msg_a', 'Done.'),
      { ...text('2026-03-14T09:00:04.000Z', 'msg_s', 'sub-agent chatter', 'tool_use'), isSidechain: true },
    ]);
    const st = await parse(path, undefined, { kind: 'session' });
    expect(st.run.turn).toBe('completed');
    expect(st.run.events.some((e) => e.text === 'sub-agent chatter')).toBe(false);
  });
});

describe('claude-code workflow agents cut off or replaced', () => {
  const KEY = 'v2:aaaa';
  const started = (agentId: string, key = KEY, label = 'review:logic') => ({ type: 'started', key, agentId, label, phase: 'Review' });
  let n = 0;
  /** A workflow folder whose agent a3f19c07be52d4e81 stopped mid-turn (open Bash call). */
  async function setup(journal: Record<string, unknown>[]) {
    const sessionDir = join(tmp, `wfa-${++n}`, 'projects', 'C--Users-alex-code-todo-cli', SID);
    const wdir = join(sessionDir, 'subagents', 'workflows', 'wf_5d2e9a41-7b3');
    await mkdir(wdir, { recursive: true });
    await writeFile(join(wdir, 'journal.jsonl'), journal.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const head = (await readFile(AGENT_OK, 'utf8')).split('\n').slice(0, 4).join('\n') + '\n';
    const agent = join(wdir, 'agent-a3f19c07be52d4e81.jsonl');
    await writeFile(agent, head);
    return { sessionDir, wdir, agent };
  }

  it('leaves an agent the journal still counts as running alone', async () => {
    const { agent } = await setup([{ type: 'launched' }, started('a3f19c07be52d4e81')]);
    const st = await parse(agent);
    expect(st.run.turn).toBe('in_progress');
    expect(st.run.openTool?.kind).toBe('run');
  });

  it('takes the journal end record over a transcript that stops mid-turn', async () => {
    const { agent } = await setup([{ type: 'launched' }, started('a3f19c07be52d4e81'), { type: 'failed', key: KEY, agentId: 'a3f19c07be52d4e81' }]);
    const st = await parse(agent);
    expect(st.run.turn).toBe('error');
    expect(st.run.openTool).toBeUndefined();
  });

  it('reads an agent restarted under the same key as cut off, in the agent and in the run', async () => {
    const { agent, wdir } = await setup([{ type: 'launched' }, started('a3f19c07be52d4e81'), started('d1d1d1d1d1d1d1d1d')]);
    const st = await parse(agent);
    expect(st.run.turn).toBe('aborted');
    expect(st.run.turnDetail).toBe('Cut off; the workflow started a new attempt');
    expect(judgeStatus(st.run, 0, Date.now()).status).toBe('done');
    const wf = await parse(join(wdir, 'journal.jsonl'));
    const res = wf.run.events.filter((e) => e.kind === 'tool_result');
    expect(res.map((e) => e.toolCallId)).toEqual(['a3f19c07be52d4e81']);
    expect(wf.run.events.filter((e) => e.kind === 'tool_call').at(-1)?.text).toBe('review:logic (Review), restart');
    expect(wf.run.openTool?.name).toBe('review:logic');
  });

  it('reads an agent re-run under a new key long after it went quiet as cut off, but not a busy sibling', async () => {
    const { agent, wdir } = await setup([{ type: 'launched' }, started('a3f19c07be52d4e81'), started('d2d2d2d2d2d2d2d2d', 'v2:bbbb')]);
    // The sibling's transcript is created now; the old agent last wrote in March.
    await writeFile(join(wdir, 'agent-d2d2d2d2d2d2d2d2d.jsonl'), '');
    const old = new Date('2026-03-14T09:20:00Z');
    await utimes(agent, old, old);
    expect((await parse(agent)).run.turn).toBe('aborted');
    // Same layout, but the old agent wrote just now: a sibling with the same label, not a re-run.
    const now = new Date();
    await utimes(agent, now, now);
    expect((await parse(agent)).run.turn).toBe('in_progress');
  });

  it('reads an agent the finished workflow never heard back from as stopped', async () => {
    const { agent, sessionDir } = await setup([{ type: 'launched' }, started('a3f19c07be52d4e81')]);
    await mkdir(join(sessionDir, 'workflows'), { recursive: true });
    await writeFile(join(sessionDir, 'workflows', 'wf_5d2e9a41-7b3.json'), JSON.stringify({ status: 'killed' }));
    const st = await parse(agent);
    expect(st.run.turn).toBe('aborted');
    expect(st.run.turnDetail).toBe('The workflow ended before this agent finished');
  });
});
