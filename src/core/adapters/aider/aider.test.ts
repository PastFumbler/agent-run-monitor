import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Env, ParseContext, ParseState, SessionRef } from '../../adapter';
import { safeParse } from '../../build';
import { judgeStatus } from '../../status';
import { adapter } from './index';
import { clearIndexCache } from './discover';

const FIX = resolve(__dirname, '../../../../test/fixtures/aider');
const fixture = (name: string) => readFileSync(join(FIX, name));

let tmp: string;
let env: Env;
let ctx: ParseContext;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'arm-aider-test-'));
  env = { platform: process.platform, home: join(tmp, 'home'), vars: {} };
  ctx = { env, tempDir: join(tmp, 'scratch') };
  mkdirSync(env.home, { recursive: true });
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Writes content to a fresh temp file (fresh mtime) and returns its path. */
function place(rel: string, content: Buffer | string): string {
  const p = join(tmp, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
}

async function sessionsOf(file: string): Promise<SessionRef[]> {
  clearIndexCache();
  // A home folder with no history file, so only `file` is found.
  return adapter.discover([file], { env: { ...env, home: join(tmp, 'nohome') }, since: 0, projectRoots: [] });
}

async function parseAll(file: string): Promise<ParseState[]> {
  const refs = await sessionsOf(file);
  return Promise.all(refs.map((r) => safeParse(adapter, r, undefined, ctx)));
}

const kinds = (st: ParseState) =>
  st.run.events.reduce<Record<string, number>>((acc, e) => ((acc[e.kind] = (acc[e.kind] ?? 0) + 1), acc), {});

describe('aider defaultRoots', () => {
  it('returns the home-folder history file on every OS, plus AIDER_CHAT_HISTORY_FILE when absolute', () => {
    expect(adapter.defaultRoots({ platform: 'win32', home: 'C:\\Users\\alex', vars: {} })).toEqual([
      'C:\\Users\\alex\\.aider.chat.history.md',
    ]);
    expect(adapter.defaultRoots({ platform: 'darwin', home: '/Users/alex', vars: {} })).toEqual([
      '/Users/alex/.aider.chat.history.md',
    ]);
    expect(
      adapter.defaultRoots({ platform: 'linux', home: '/home/alex', vars: { AIDER_CHAT_HISTORY_FILE: '/home/alex/logs/aider.md' } }),
    ).toEqual(['/home/alex/.aider.chat.history.md', '/home/alex/logs/aider.md']);
    // A relative override depends on Aider's launch folder, which we cannot know.
    expect(adapter.defaultRoots({ platform: 'linux', home: '/home/alex', vars: { AIDER_CHAT_HISTORY_FILE: 'chat.md' } })).toHaveLength(1);
  });
});

describe('aider discover', () => {
  it('walks project roots to a bounded depth, prunes heavy folders, checks the home file, one ref per session', async () => {
    const main = fixture('aider-chat-history.md');
    const root = join(tmp, 'code');
    place('code/todo-cli/.aider.chat.history.md', fixture('projects/todo-cli/.aider.chat.history.md'));
    place('code/todo-cli/.aider.input.history', fixture('projects/todo-cli/.aider.input.history'));
    place('code/group/nested/api/.aider.chat.history.md', fixture('aider-live.chat.history.md'));
    // Decoys: pruned folders and a file deeper than the depth limit.
    place('code/todo-cli/node_modules/pkg/.aider.chat.history.md', main);
    place('code/todo-cli/.git/.aider.chat.history.md', main);
    place('code/todo-cli/.venv/.aider.chat.history.md', main);
    place('code/a/b/c/d/e/.aider.chat.history.md', main);
    place('home/.aider.chat.history.md', fixture('aider-live.chat.history.md'));

    clearIndexCache();
    const refs = await adapter.discover([join(tmp, 'missing-root')], { env, since: 0, projectRoots: [root] });
    const byProject = refs.map((r) => `${r.hint?.project}@${r.subId}`).sort();
    expect(byProject).toEqual(['api@1', 'home@1', 'todo-cli@1', 'todo-cli@3036', 'todo-cli@4783'].sort());

    // Each subId is the byte offset of that session's header line.
    for (const r of refs) {
      const bytes = readFileSync(r.path);
      expect(bytes.subarray(Number(r.subId)).toString('utf8').startsWith('# aider chat started at ')).toBe(true);
      expect(r.agent).toBe('aider');
    }
    // Earlier sessions end when the next starts: their mtime is the next header's time.
    const todo = refs.filter((r) => r.hint?.project === 'todo-cli').sort((a, b) => Number(a.subId) - Number(b.subId));
    expect(todo[0].mtimeMs).toBe(new Date(2026, 2, 15, 14, 40, 51).getTime());
    // Every ref carries the whole file's size (the store compares it with a stat of the file).
    expect(todo.map((r) => r.size)).toEqual([5322, 5322, 5322]);
    expect(todo[2].mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it('returns [] for missing roots and honours since', async () => {
    clearIndexCache();
    expect(await adapter.discover([join(tmp, 'nope')], { env: { ...env, home: join(tmp, 'nohome') }, since: 0, projectRoots: [join(tmp, 'nope2')] })).toEqual([]);

    const p = place('old/proj/.aider.chat.history.md', fixture('aider-chat-history.md'));
    const old = new Date(2026, 2, 16, 9, 0, 0);
    utimesSync(p, old, old);
    clearIndexCache();
    const all = await adapter.discover([], { env: { ...env, home: join(tmp, 'nohome') }, since: 0, projectRoots: [join(tmp, 'old')] });
    expect(all).toHaveLength(3);
    // Only the sessions still active at or after 2026-03-16 08:30 local.
    const since = new Date(2026, 2, 16, 8, 30, 0).getTime();
    const recent = await adapter.discover([], { env: { ...env, home: join(tmp, 'nohome') }, since, projectRoots: [join(tmp, 'old')] });
    expect(recent.map((r) => r.subId)).toEqual(['4783']);
    // A whole file older than since is skipped without reading it.
    const none = await adapter.discover([], { env: { ...env, home: join(tmp, 'nohome') }, since: Date.now(), projectRoots: [join(tmp, 'old')] });
    expect(none).toEqual([]);
  });
});

describe('aider parse', () => {
  it('session 1: edits, a reflection, a failed edit, /run and /exit', async () => {
    const [s1] = await parseAll(place('p1/proj/.aider.chat.history.md', fixture('aider-chat-history.md')));
    const r = s1.run;
    expect(r.readError).toBeUndefined();
    expect(r.title).toBe('add a --due flag to the add command');
    expect(r.projectName).toBe('proj');
    expect(r.projectPath).toBe(join(tmp, 'p1/proj'));
    expect(r.model).toBe('anthropic/claude-sonnet-4-5');
    expect(r.gitBranch).toBeUndefined();
    expect(r.startedAt).toBe(new Date(2026, 2, 14, 9, 12, 5).getTime());
    expect(r.events.every((e) => e.ts === r.startedAt)).toBe(true);
    expect(kinds(s1)).toEqual({ system: 20, user: 2, assistant: 4, tool_call: 4, tool_result: 4, file_change: 2, error: 2 });
    expect(r.inputTokens).toBe(3100 + 3600 + 4000 + 4400);
    expect(r.outputTokens).toBe(412 + 38 + 120 + 160);
    expect(Object.keys(r.files).sort()).toEqual(['tests/test_cli.py', 'todo/cli.py']);
    expect(r.turn).toBe('completed');
    expect(r.openTool).toBeUndefined();

    // Every tool call is answered by a result with the same id; the failed edit is an error.
    const calls = r.events.filter((e) => e.kind === 'tool_call');
    const results = r.events.filter((e) => e.kind === 'tool_result');
    expect(calls.map((c) => c.toolCallId)).toEqual(results.map((x) => x.toolCallId));
    expect(calls.map((c) => `${c.toolName}:${c.text}`)).toEqual([
      'edit:todo/cli.py',
      'edit:tests/test_cli.py',
      'edit:tests/test_cli.py',
      'shell:pytest -q',
    ]);
    expect(results[1].isError).toBe(true);
    expect(calls[3].toolKind).toBe('run');
    // The approval keeps its subject; the multi-line failure report stays one error event.
    expect(r.events.some((e) => e.kind === 'system' && e.text === 'Add file to the chat? y\ntests/test_cli.py')).toBe(true);
    const failed = r.events.find((e) => e.kind === 'error' && e.text.startsWith('# 1 SEARCH/REPLACE'));
    expect(failed?.text).toContain('The SEARCH section must exactly match');
  });

  it('session 2: reasoning, retried API error, Cost continuation, Ctrl-C, fatal auth error', async () => {
    const [, s2] = await parseAll(place('p2/proj/.aider.chat.history.md', fixture('aider-chat-history.md')));
    const r = s2.run;
    expect(r.title).toBe('why does `todo list` crash when the data file is empty?');
    expect(kinds(s2)).toEqual({ system: 11, user: 3, error: 4, reasoning: 1, assistant: 2, tool_call: 1, tool_result: 1, file_change: 1 });
    expect(r.events.find((e) => e.kind === 'reasoning')?.text).toMatch(/^The loader calls json\.load/);
    expect(r.events.find((e) => e.kind === 'assistant')?.text).not.toContain('thinking-content');
    expect(r.events.find((e) => e.text.startsWith('Tokens: 4.4k'))?.text).toContain('\nCost: $0.03 message');
    expect(r.inputTokens).toBe(4400);
    expect(r.outputTokens).toBe(1100);
    expect(r.files['todo/storage.py'].ops).toEqual(['edit']);
    expect(r.turn).toBe('error');
    expect(r.turnDetail).toBe('The API provider is not able to authenticate you. Check your API key.');
  });

  it('session 3: an unanswered approval is waiting for input', async () => {
    const refs = await parseAll(place('p3/proj/.aider.chat.history.md', fixture('aider-chat-history.md')));
    const r = refs[2].run;
    expect(r.title).toBe('create a short README for the project');
    expect(r.turn).toBe('waiting_input');
    expect(r.turnDetail).toBe('Waiting for approval: README.md');
    // The "# todo-cli" heading inside the fenced reply does not start a session or break the reply.
    expect(r.events.find((e) => e.kind === 'assistant')?.text).toContain('# todo-cli');
    const call = r.events.find((e) => e.kind === 'tool_call');
    expect(call).toMatchObject({ toolName: 'edit', toolKind: 'edit', text: 'README.md' });
  });

  it('a live session with a shell command running has an open tool', async () => {
    const [s] = await parseAll(place('p4/api/.aider.chat.history.md', fixture('aider-live.chat.history.md')));
    const r = s.run;
    expect(r.title).toBe('fix the failing date test');
    expect(r.model).toBe('openai/gpt-5');
    expect(r.turn).toBe('in_progress');
    expect(r.openTool).toMatchObject({ name: 'shell', kind: 'run' });
    expect(Object.keys(r.files)).toEqual(['tests/test_dates.py']); // whole edit format
    expect(r.events.at(-1)).toMatchObject({ kind: 'tool_call', toolName: 'shell', text: 'pytest -q tests/test_dates.py' });
  });

  it('CRLF files (Aider on Windows) parse to the same events as LF', async () => {
    const lf = fixture('aider-chat-history.md').toString('utf8');
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(fixture('aider-chat-history.crlf.md').toString('utf8').replace(/\r\n/g, '\n')).toBe(lf);
    const a = await parseAll(place('lf/x/.aider.chat.history.md', lf));
    const b = await parseAll(place('crlf/x/.aider.chat.history.md', crlf));
    expect(b).toHaveLength(3);
    const norm = (s: ParseState) => s.run.events.map((e) => ({ ...e, toolCallId: e.toolCallId?.split(':')[1] }));
    for (let i = 0; i < 3; i++) {
      expect(norm(b[i])).toEqual(norm(a[i]));
      expect(b[i].run.turn).toBe(a[i].run.turn);
    }
  });

  it('a corrupt file: bad bytes are skipped, good records kept, the cut-off last line is held back', async () => {
    const p = place('bad/proj/.aider.chat.history.md', fixture('aider-corrupt.chat.history.md'));
    const refs = await sessionsOf(p);
    expect(refs).toHaveLength(1);
    const st = await safeParse(adapter, refs[0], undefined, ctx);
    expect(st.run.readError).toBeUndefined();
    expect(st.run.skipped).toBeGreaterThanOrEqual(1);
    expect(st.run.title).toBe('add a --due flag to the add command');
    expect(st.run.events.filter((e) => e.kind === 'user')).toHaveLength(2);
    expect(st.run.events.some((e) => e.text.includes('\u0000'))).toBe(false);
    // "> Tokens: 4.4k sen" has no newline yet: not consumed.
    expect(st.offset).toBeLessThan(st.size);
    expect(st.run.events.some((e) => e.text.startsWith('Tokens: 4.4k'))).toBe(false);
  });

  it('a file with no record this app knows gets a readError, without throwing', async () => {
    const p = place('unknown/proj/.aider.chat.history.md', fixture('unknown-format.chat.history.md'));
    const refs = await sessionsOf(p);
    expect(refs).toHaveLength(1);
    const st = await safeParse(adapter, refs[0], undefined, ctx);
    expect(st.run.readError).toBe('No records this app recognises; the agent may have changed its format.');
    expect(st.run.events).toHaveLength(0);
  });

  it('a session offset that no longer points at a header (file rewritten) is reported, not thrown', async () => {
    const p = place('moved/proj/.aider.chat.history.md', fixture('aider-chat-history.md'));
    const st = await safeParse(adapter, { agent: 'aider', path: p, subId: '100', mtimeMs: 0, size: 0 }, undefined, ctx);
    expect(st.run.readError).toMatch(/no longer where it was/);
    const gone = await safeParse(adapter, { agent: 'aider', path: join(tmp, 'gone.md'), subId: '1', mtimeMs: 0, size: 0 }, undefined, ctx);
    expect(gone.run.readError).toBeTruthy();
  });
});

describe('aider parse: edge cases found in review', () => {
  const HEAD =
    '\n# aider chat started at 2026-03-17 10:00:00\n\n> /home/alex/.local/bin/aider --model openai/gpt-5  \n> Aider v0.86.1  \n> Main model: openai/gpt-5 with diff edit format  \n';
  let n = 0;
  async function one(body: string) {
    const p = place(`edge/e${++n}/.aider.chat.history.md`, HEAD + body);
    const refs = await sessionsOf(p);
    expect(refs).toHaveLength(1);
    return (await safeParse(adapter, refs[0], undefined, ctx)).run;
  }

  it('a reply cut off inside a code fence (Ctrl-C) does not swallow the turns after it', async () => {
    const r = await one(
      '\n#### write a func  \n>  \n>  \n> ^C again to exit  \n\nHere:\n\n```python\ndef f():\n\n\n' +
        '#### now something else  \n\nSure, done.\n\n> Tokens: 1k sent, 10 received.  \n',
    );
    expect(r.events.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual(['write a func', 'now something else']);
    expect(r.events.filter((e) => e.kind === 'assistant').map((e) => e.text)).toEqual(['Here:\n\n```python\ndef f():', 'Sure, done.']);
    expect(r.inputTokens).toBe(1000);
    expect(r.turn).toBe('completed');
  });

  it('a fenced "> " quote or "#### " heading inside a reply does not end it', async () => {
    const r = await one('\n#### show me  \n\nSee:\n\n```markdown\n> a quote  \n\n#### Heading\n```\n\n> Tokens: 1k sent, 10 received.  \n');
    expect(r.events.filter((e) => e.kind === 'assistant').map((e) => e.text)).toEqual([
      'See:\n\n```markdown\n> a quote  \n\n#### Heading\n```',
    ]);
  });

  it('the output of a local command (/ls) is not mistaken for an approval prompt', async () => {
    const r = await one('\n#### /ls  \n> Files in chat:  \n> todo/cli.py  \n> tests/test_cli.py  \n');
    expect(r.turn).toBe('completed');
    expect(r.events.filter((e) => e.kind === 'system').map((e) => e.text)).toContain('todo/cli.py');
  });

  it('a pending "Run shell command(s)?" is waiting, including multi-line and dot-ending commands', async () => {
    const reply = '\n#### do it  \n\nRun:\n\n```bash\nnpm install\nnpm test\n```\n\n> Tokens: 1k sent, 10 received.  \n';
    // confirm_ask pads multi-line subjects and prefixes only the first line.
    const multi = await one(`${reply}> npm install  \nnpm test     \n`);
    expect([multi.turn, multi.turnDetail]).toEqual(['waiting_input', 'Waiting for approval: npm install']);
    const dot = await one(`${reply}> git add .  \n`);
    expect([dot.turn, dot.turnDetail]).toEqual(['waiting_input', 'Waiting for approval: git add .']);
    // Once answered, the subject travels with the approval and the shell call opens.
    const answered = await one(`${reply}> git add .  \n> Run shell command? (Y)es/(N)o/(D)on't ask again [Yes]: y  \n> Running git add .  \n`);
    expect(answered.events.some((e) => e.kind === 'system' && e.text === "Run shell command? y\ngit add .")).toBe(true);
    expect(answered.openTool).toMatchObject({ name: 'shell', kind: 'run' });
  });

  it('an edit block that Aider never applied does not leave the run "running"', async () => {
    const r = await one(
      '\n#### how would I?  \n\nlike this:\n\nfoo.py\n```python\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```\n\n> Tokens: 1k sent, 10 received.  \n',
    );
    expect(r.events.filter((e) => e.kind === 'tool_call').map((e) => e.text)).toEqual(['foo.py']);
    expect(r.turn).toBe('completed');
    expect(r.openTool).toBeUndefined();
    expect(judgeStatus(r, Date.now(), Date.now() + 10 * 60_000).status).toBe('done');
  });
});

describe('aider incremental parse', () => {
  it('appending in pieces (split mid-line and mid-reply) gives the same run as one full parse', { timeout: 30_000 }, async () => {
    const all = fixture('aider-chat-history.md');
    // Session 2 alone, so it is the live (last) session of its file.
    const s2 = all.subarray(3036, 4783);
    const fullPath = place('inc/full/.aider.chat.history.md', s2);
    const [ref] = await sessionsOf(fullPath);
    const full = await safeParse(adapter, ref, undefined, ctx);

    const cuts = [40, 300, 555, 700, 901, 1100, 1300, 1500, 1700];
    for (const cut of cuts) {
      const p = place(`inc/cut${cut}/.aider.chat.history.md`, s2.subarray(0, cut));
      const r1 = { ...ref, path: p, subId: '0' };
      const first = await safeParse(adapter, r1, undefined, ctx);
      expect(first.run.readError).toBeUndefined();
      // Append the rest in two steps; the middle step ends in a partial line.
      const mid = Math.min(s2.length, cut + 37);
      appendFileSync(p, s2.subarray(cut, mid));
      const second = await safeParse(adapter, r1, first, ctx);
      appendFileSync(p, s2.subarray(mid));
      const third = await safeParse(adapter, r1, second, ctx);
      expect(third.offset).toBe(s2.length);
      expect(third.run.events).toEqual(full.run.events);
      expect(third.run.tally).toEqual(full.run.tally);
      expect(third.run.files).toEqual(full.run.files);
      expect([third.run.turn, third.run.turnDetail, third.run.inputTokens, third.run.title]).toEqual([
        full.run.turn,
        full.run.turnDetail,
        full.run.inputTokens,
        full.run.title,
      ]);
    }
  });

  it('returns prev when nothing changed, stops at the next session, restarts when the file shrank', async () => {
    const all = fixture('aider-chat-history.md');
    const p = place('inc2/x/.aider.chat.history.md', all.subarray(0, 3036));
    const [ref] = await sessionsOf(p);
    const a = await safeParse(adapter, ref, undefined, ctx);
    expect(a.run.turn).toBe('completed'); // ended with /exit
    expect(await safeParse(adapter, ref, a, ctx)).toBe(a);

    appendFileSync(p, all.subarray(3036));
    const b = await safeParse(adapter, ref, a, ctx);
    expect(b.run.events).toEqual(a.run.events); // session 2 belongs to its own ref
    expect(b.offset).toBe(3036);

    writeFileSync(p, all.subarray(0, 1500));
    const c = await safeParse(adapter, ref, b, ctx);
    expect(c.run.events.length).toBeLessThan(a.run.events.length);
    expect(c.run.title).toBe('add a --due flag to the add command');
  });

  it('a file deleted and recreated larger is re-indexed and never resumed at a stale offset', async () => {
    const all = fixture('aider-chat-history.md');
    const p = place('inc3/x/.aider.chat.history.md', all.subarray(3036, 4783));
    const envNoHome = { ...env, home: join(tmp, 'nohome') };
    clearIndexCache();
    const [ref] = await adapter.discover([p], { env: envNoHome, since: 0, projectRoots: [] });
    expect(ref.subId).toBe('0');
    const a = await safeParse(adapter, ref, undefined, ctx);
    expect(a.run.readError).toBeUndefined();

    // A new file, bigger than the old one, whose sessions sit at other offsets.
    writeFileSync(p, Buffer.concat([Buffer.from('\n\n'), all]));
    // The index cache must not keep the old offsets (no clearIndexCache here).
    const refs = await adapter.discover([p], { env: envNoHome, since: 0, projectRoots: [] });
    expect(refs.map((r) => r.subId)).toEqual(['3', '3038', '4785']);
    // The old ref with its old state: offset 0 is no longer a header, so no stale resume.
    const b = await safeParse(adapter, ref, a, ctx);
    expect(b.run.readError).toMatch(/no longer where it was/);
    expect(b.run.events).toHaveLength(0);
  });
});

describe('aider status', () => {
  it('a finished session reads done, a fresh live one running, an unanswered prompt waiting, a fatal error failed', async () => {
    const refs = await sessionsOf(place('st/proj/.aider.chat.history.md', fixture('aider-chat-history.md')));
    const [s1, s2, s3] = await Promise.all(refs.map((r) => safeParse(adapter, r, undefined, ctx)));
    const hourLater = refs[0].mtimeMs + 60 * 60_000;
    expect(judgeStatus(s1.run, refs[0].mtimeMs, hourLater).status).toBe('done');
    expect(judgeStatus(s2.run, refs[1].mtimeMs, hourLater).status).toBe('failed');
    expect(judgeStatus(s3.run, refs[2].mtimeMs, refs[2].mtimeMs + 10_000).status).toBe('waiting');

    const [live] = await sessionsOf(place('st/live/.aider.chat.history.md', fixture('aider-live.chat.history.md')));
    const l = await safeParse(adapter, live, undefined, ctx);
    const j = judgeStatus(l.run, live.mtimeMs, live.mtimeMs + 10_000);
    expect(j.status).toBe('running');
    expect(j.detail).toBe('Running shell');
    // Idle right after a finished turn.
    const idle = { ...s1.run, turn: 'completed' as const };
    expect(judgeStatus(idle, refs[0].mtimeMs, refs[0].mtimeMs + 30_000).status).toBe('idle');
  });
});
