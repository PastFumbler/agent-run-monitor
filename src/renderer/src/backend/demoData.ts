// Synthetic demo data for the fixture backend: toy projects, made-up prompts, invented tool output.
// Nothing here comes from a real machine. Content is fully determined by the seed; only the
// timestamps are placed relative to `now`, so the same ?now= gives the same screen every time.

import {
  AGENT_IDS,
  RUN_STATUSES,
  type AgentId,
  type FileChangeSummary,
  type FileOp,
  type RunCounts,
  type RunDetail,
  type RunEvent,
  type RunStatus,
  type RunSummary,
  type ToolCallSummary,
  type ToolKind,
} from '@shared/schema';
import { Rng } from './prng';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HOME = '/home/demo';

export interface DemoProject {
  name: string;
  lang: 'ts' | 'py' | 'rs' | 'go' | 'c' | 'rb';
  files: string[];
  test: string;
  tasks: string[];
  branches: string[];
}

export const PROJECTS: DemoProject[] = [
  {
    name: 'todo-cli',
    lang: 'ts',
    files: ['src/cli.ts', 'src/commands/add.ts', 'src/commands/list.ts', 'src/store.ts', 'test/add.test.ts', 'README.md', 'package.json'],
    test: 'npm test',
    tasks: [
      'Add a --due flag to the add command',
      'Fix sorting of completed todos in the list view',
      'Write tests for the list command filters',
      'Make the store file path configurable with TODO_HOME',
      'Colour overdue items red in the terminal output',
    ],
    branches: ['main', 'feat/due-dates', 'fix/sort-order'],
  },
  {
    name: 'weather-api',
    lang: 'py',
    files: ['app/main.py', 'app/routes/forecast.py', 'app/cache.py', 'app/models.py', 'tests/test_forecast.py', 'pyproject.toml'],
    test: 'pytest -q',
    tasks: [
      'Cache forecast responses for ten minutes',
      'Return 404 instead of 500 for unknown cities',
      'Add a /health endpoint for the load balancer',
      'Fix the flaky test in test_forecast.py',
      'Switch temperature units with a ?units= query parameter',
    ],
    branches: ['main', 'cache-forecasts', 'fix/unknown-city'],
  },
  {
    name: 'blog-engine',
    lang: 'rs',
    files: ['src/main.rs', 'src/render.rs', 'src/markdown.rs', 'src/feed.rs', 'templates/post.html', 'Cargo.toml'],
    test: 'cargo test',
    tasks: [
      'Generate an Atom feed next to the RSS feed',
      'Support footnotes in the markdown renderer',
      'Add reading-time estimates to each post',
      'Speed up the site build by caching rendered posts',
    ],
    branches: ['main', 'atom-feed', 'footnotes'],
  },
  {
    name: 'pixel-editor',
    lang: 'ts',
    files: ['src/App.tsx', 'src/canvas.ts', 'src/tools/brush.ts', 'src/tools/fill.ts', 'src/palette.ts', 'src/history.ts', 'index.html'],
    test: 'npm run test',
    tasks: [
      'Implement flood fill with a tolerance slider',
      'Add undo and redo with Ctrl+Z and Ctrl+Y',
      'Export the canvas as a PNG at 4x scale',
      'Fix the brush leaving gaps on fast strokes',
    ],
    branches: ['main', 'flood-fill', 'undo-redo'],
  },
  {
    name: 'recipe-box',
    lang: 'go',
    files: ['cmd/server/main.go', 'internal/recipes/store.go', 'internal/recipes/search.go', 'internal/recipes/search_test.go', 'go.mod'],
    test: 'go test ./...',
    tasks: [
      'Search recipes by ingredient, ignoring case',
      'Scale ingredient amounts by number of servings',
      'Add a shopping list endpoint that merges duplicates',
      'Persist recipes in SQLite instead of a JSON file',
    ],
    branches: ['main', 'ingredient-search', 'sqlite-store'],
  },
  {
    name: 'chess-engine',
    lang: 'c',
    files: ['src/board.c', 'src/movegen.c', 'src/search.c', 'src/eval.c', 'tests/perft.c', 'Makefile'],
    test: 'make test',
    tasks: [
      'Add castling rights to the move generator',
      'Implement iterative deepening with a time limit',
      'Fix perft counts at depth 5 from the start position',
      'Add a simple transposition table',
    ],
    branches: ['main', 'castling', 'iterative-deepening'],
  },
  {
    name: 'habit-tracker',
    lang: 'rb',
    files: ['app/models/habit.rb', 'app/controllers/habits_controller.rb', 'app/views/habits/index.html.erb', 'spec/models/habit_spec.rb', 'Gemfile'],
    test: 'bundle exec rspec',
    tasks: [
      'Show a streak counter on each habit',
      'Allow habits that repeat on weekdays only',
      'Add a weekly summary email preview',
    ],
    branches: ['main', 'streaks'],
  },
  {
    name: 'link-shortener',
    lang: 'py',
    files: ['shortener/app.py', 'shortener/codes.py', 'shortener/storage.py', 'tests/test_codes.py', 'requirements.txt'],
    test: 'pytest',
    tasks: [
      'Reject URLs that point back at the shortener',
      'Count clicks per short link',
      'Generate codes without ambiguous characters',
    ],
    branches: ['main', 'click-stats'],
  },
];

interface ToolSet {
  read: string;
  search: string;
  edit: string;
  write: string;
  run: string;
  web: string;
  agent?: string;
}

const CLAUDE: ToolSet = { read: 'Read', search: 'Grep', edit: 'Edit', write: 'Write', run: 'Bash', web: 'WebFetch', agent: 'Task' };
const TOOLSETS: Record<AgentId, ToolSet> = {
  'claude-code': CLAUDE,
  codex: { read: 'shell', search: 'shell', edit: 'apply_patch', write: 'apply_patch', run: 'shell', web: 'web_search' },
  'gemini-cli': { read: 'read_file', search: 'search_file_content', edit: 'replace', write: 'write_file', run: 'run_shell_command', web: 'web_fetch' },
  'qwen-code': { read: 'read_file', search: 'search_file_content', edit: 'replace', write: 'write_file', run: 'run_shell_command', web: 'web_fetch' },
  'copilot-vscode': { read: 'read_file', search: 'grep_search', edit: 'replace_string_in_file', write: 'create_file', run: 'run_in_terminal', web: 'fetch_webpage' },
  'copilot-cli': { read: 'view', search: 'grep', edit: 'str_replace', write: 'create', run: 'bash', web: 'web_fetch' },
  aider: { read: 'read', search: 'search', edit: 'edit_block', write: 'edit_block', run: 'run', web: 'web' },
  cursor: { read: 'read_file', search: 'codebase_search', edit: 'edit_file', write: 'edit_file', run: 'run_terminal_cmd', web: 'web_search' },
  cline: { read: 'read_file', search: 'search_files', edit: 'replace_in_file', write: 'write_to_file', run: 'execute_command', web: 'browser_action' },
  'roo-code': { read: 'read_file', search: 'search_files', edit: 'apply_diff', write: 'write_to_file', run: 'execute_command', web: 'browser_action', agent: 'new_task' },
  opencode: { read: 'read', search: 'grep', edit: 'edit', write: 'write', run: 'bash', web: 'webfetch', agent: 'task' },
  continue: { read: 'read_file', search: 'grep_search', edit: 'edit_existing_file', write: 'create_new_file', run: 'run_terminal_command', web: 'fetch_url_content' },
};

const MODELS: Record<AgentId, string[]> = {
  'claude-code': ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  codex: ['gpt-5-codex', 'gpt-5'],
  'gemini-cli': ['gemini-2.5-pro', 'gemini-2.5-flash'],
  'qwen-code': ['qwen3-coder-plus'],
  'copilot-vscode': ['gpt-4.1', 'claude-sonnet-4'],
  'copilot-cli': ['claude-sonnet-4-5', 'gpt-5'],
  aider: ['deepseek-chat', 'claude-sonnet-4-5'],
  cursor: ['auto', 'claude-4-sonnet'],
  cline: ['claude-sonnet-4-5', 'qwen3-coder'],
  'roo-code': ['claude-sonnet-4-5', 'gemini-2.5-pro'],
  opencode: ['kimi-k2', 'claude-sonnet-4-5'],
  continue: ['llama3.1:8b', 'qwen2.5-coder:7b'],
};

const THOUGHTS = [
  'The user wants {task}. First I should find where this lives. {file} looks like the entry point, so I will read it before changing anything.',
  'The test failure says the expected value is off by one. That points at the loop bound in {file}. I will check the boundary handling.',
  'There are two ways to do this: change the caller, or add an option to the helper. The helper is used in three places, so an option keeps the callers unchanged.',
  'Before editing, I want to know whether anything else depends on this behaviour. A quick search for the function name should tell me.',
  'The edit compiled. Now I should run the tests to make sure nothing else broke, then summarise the change.',
  'This error is about a missing import, not the logic. Adding the import and re-running should be enough.',
  'The docs for this library say the option was renamed in the latest version. I will fetch the changelog to confirm before using it.',
];

const ASSISTANT = [
  "I'll start by looking at how {file} is structured.",
  'Found it: the bug is in {file}. Making the change now.',
  'The tests pass. Next I will update the README so the new option is documented.',
  'That command failed because the build folder was missing; creating it first.',
  'I have a plan: read the current implementation, add the option, then cover it with a test.',
];

const SUMMARIES = [
  'Done. {task}: the change is in {file}, with a new test. All tests pass.',
  'Finished. I updated {file} and added two tests; the full suite passes locally.',
  'Implemented and verified with `{test}`. One follow-up: the README example still uses the old flag name.',
];

const ERRORS = [
  { text: 'API error 529: the model is overloaded. Please try again later.', detail: 'API error 529: overloaded' },
  { text: 'Rate limit reached (429). Retry after 60 seconds.', detail: 'Rate limit reached (429)' },
  { text: 'The conversation is too long for the model context window.', detail: 'Context window exceeded' },
  { text: 'Process exited with code 1 after the test run failed three times in a row.', detail: 'Stopped after repeated test failures' },
];

const READ_ERRORS = [
  "The file isn't valid JSON; the agent may have changed its format.",
  'No permission to read this file.',
  'The file is locked by another program; will retry.',
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? k);

export interface DemoRun {
  summary: RunSummary;
  events: RunEvent[];
  /** Live runs get new events from the fixture's timer. */
  live: boolean;
  /** Never auto-finished by the timer (the demo's headline run stays alive for screenshots). */
  keepAlive?: boolean;
  /** Open tool call id when a tool is running. */
  openCallId?: string;
  tokensIn: number;
  tokensOut: number;
}

function sourcePathFor(agent: AgentId, project: DemoProject, rng: Rng, startedAt: number): string {
  const id = rng.uuid();
  const d = new Date(startedAt);
  const ymd = [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')];
  const proj = `${HOME}/code/${project.name}`;
  switch (agent) {
    case 'claude-code':
      return `${HOME}/.claude/projects/${proj.replace(/\//g, '-')}/${id}.jsonl`;
    case 'codex':
      return `${HOME}/.codex/sessions/${ymd.join('/')}/rollout-${ymd.join('-')}T09-12-33-${id}.jsonl`;
    case 'gemini-cli':
      return `${HOME}/.gemini/tmp/${rng.hex(16)}/chats/session-${ymd.join('-')}-${rng.hex(8)}.json`;
    case 'qwen-code':
      return `${HOME}/.qwen/tmp/${rng.hex(16)}/chats/session-${ymd.join('-')}-${rng.hex(8)}.json`;
    case 'copilot-vscode':
      return `${HOME}/.config/Code/User/workspaceStorage/${rng.hex(32)}/chatSessions/${id}.json`;
    case 'copilot-cli':
      return `${HOME}/.copilot/session-state/${id}.jsonl`;
    case 'aider':
      return `${proj}/.aider.chat.history.md`;
    case 'cursor':
      return `${HOME}/.config/Cursor/User/globalStorage/state.vscdb`;
    case 'cline':
      return `${HOME}/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/${startedAt}/ui_messages.json`;
    case 'roo-code':
      return `${HOME}/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/${startedAt}/ui_messages.json`;
    case 'opencode':
      return `${HOME}/.local/share/opencode/storage/session/ses_${rng.hex(20)}.json`;
    case 'continue':
      return `${HOME}/.continue/sessions/${id}.json`;
  }
}

/** Builds events one step at a time; used both for history and for live ticks. */
export class EventWriter {
  constructor(
    private readonly run: DemoRun,
    private readonly rng: Rng,
    private readonly project: DemoProject,
  ) {}

  private get tools(): ToolSet {
    return TOOLSETS[this.run.summary.agent];
  }

  private push(e: Omit<RunEvent, 'seq'>): RunEvent {
    const ev: RunEvent = { seq: this.run.events.length, ...e };
    this.run.events.push(ev);
    const tokens = Math.ceil(ev.text.length / 4) + 40;
    if (ev.kind === 'assistant' || ev.kind === 'reasoning' || ev.kind === 'tool_call') this.run.tokensOut += tokens;
    else this.run.tokensIn += tokens * 6;
    return ev;
  }

  private vars(file?: string): Record<string, string> {
    return { task: this.run.summary.title, file: file ?? this.rng.pick(this.project.files), test: this.project.test };
  }

  user(text: string, ts: number) {
    return this.push({ kind: 'user', text, ts });
  }
  reasoning(ts: number) {
    const a = fill(this.rng.pick(THOUGHTS), this.vars());
    const b = this.rng.chance(0.5) ? ` ${fill(this.rng.pick(THOUGHTS), this.vars())}` : '';
    return this.push({ kind: 'reasoning', text: a + b, ts });
  }
  assistant(ts: number, tpl?: string) {
    return this.push({ kind: 'assistant', text: fill(tpl ?? this.rng.pick(ASSISTANT), this.vars()), ts });
  }
  system(text: string, ts: number) {
    return this.push({ kind: 'system', text, ts });
  }
  error(text: string, ts: number) {
    return this.push({ kind: 'error', text, ts, isError: true });
  }

  /** A tool call and (unless `open`) its result. Returns the call id. */
  tool(kind: ToolKind, ts: number, opts: { open?: boolean; fail?: boolean; durationMs?: number; input?: string } = {}): string {
    const t = this.tools;
    const file = this.rng.pick(this.project.files);
    const callId = `call_${this.rng.hex(12)}`;
    let name: string;
    let input: string;
    let output: string;
    let filePath: string | undefined;
    let fileOp: FileOp | undefined;
    const fail = opts.fail ?? false;
    switch (kind) {
      case 'read':
        name = t.read;
        input = name === 'shell' ? `sed -n '1,120p' ${file}` : file;
        filePath = file;
        output = fail ? `Error: ENOENT: no such file or directory, open '${file}'` : `Read ${this.rng.int(40, 400)} lines from ${file}`;
        break;
      case 'search': {
        name = t.search;
        const pat = this.rng.pick(['parseArgs', 'TODO', 'cache_ttl', 'fn render', 'flood', 'castle', 'units', 'streak']);
        input = name === 'shell' ? `rg -n "${pat}" .` : pat;
        output = fail ? 'Error: regex parse error: unclosed group' : `${this.rng.int(0, 9)} matches in ${this.rng.int(1, 4)} files`;
        break;
      }
      case 'edit': {
        const create = this.rng.chance(0.15);
        name = create ? t.write : t.edit;
        filePath = create ? file.replace(/(\.\w+)$/, '_extra$1') : file;
        input = filePath;
        fileOp = create ? 'create' : this.rng.chance(0.05) ? 'delete' : 'edit';
        output = fail
          ? 'Error: old_string not found in file. The file may have changed since it was read.'
          : `Applied ${plural(this.rng.int(1, 6), 'change')} to ${filePath} (+${this.rng.int(1, 40)} -${this.rng.int(0, 20)})`;
        break;
      }
      case 'run': {
        name = t.run;
        input = opts.input ?? this.rng.pick([this.project.test, 'git status --short', 'git diff --stat', `${this.project.test} -- --watch=false`, 'ls -la']);
        output = fail
          ? `FAIL  1 test failed\n  expected 3, received 2\n  at ${file}:${this.rng.int(10, 200)}\nProcess exited with code 1`
          : input.includes('git')
            ? ` M ${file}\n M README.md`
            : `ok  ${this.rng.int(4, 60)} passed, 0 failed in ${this.rng.float(0.4, 9).toFixed(2)}s`;
        break;
      }
      case 'web':
        name = t.web;
        input = this.rng.pick(['https://example.com/docs/changelog', 'https://example.org/guide/caching', 'https://example.net/api/reference']);
        output = fail ? 'Error: request timed out after 30 s' : `Fetched ${this.rng.int(3, 40)} KB: the option was renamed to "ttl" in version 2.`;
        break;
      case 'agent':
        name = t.agent ?? t.run;
        input = 'Explore the test helpers and report which ones are unused';
        output = 'The sub-agent found 2 unused helpers in the test folder.';
        break;
      default:
        name = 'todo_write';
        input = 'Update the plan';
        output = 'Plan updated (3 items)';
    }
    this.push({ kind: 'tool_call', text: input, ts, toolName: name, toolCallId: callId, toolKind: kind, filePath: kind === 'edit' ? filePath : undefined, fileOp: kind === 'edit' ? fileOp : undefined });
    if (opts.open) {
      this.run.openCallId = callId;
      this.run.summary.currentTool = name;
      return callId;
    }
    const dur = opts.durationMs ?? (kind === 'run' ? this.rng.int(800, 40_000) : this.rng.int(40, 1500));
    this.result(callId, name, kind, ts + dur, dur, output, fail, filePath, fileOp);
    return callId;
  }

  result(callId: string, name: string, kind: ToolKind, ts: number, durationMs: number, text: string, fail: boolean, filePath?: string, fileOp?: FileOp) {
    this.push({ kind: 'tool_result', text, ts, toolName: name, toolCallId: callId, toolKind: kind, isError: fail || undefined, durationMs });
    if (kind === 'edit' && !fail && filePath) {
      this.push({ kind: 'file_change', text: `${fileOp === 'create' ? 'Created' : fileOp === 'delete' ? 'Deleted' : 'Edited'} ${filePath}`, ts, filePath, fileOp: fileOp ?? 'edit' });
    }
  }

  /** Closes the open tool call (live runs). */
  closeOpen(ts: number, fail = false) {
    const id = this.run.openCallId;
    if (!id) return;
    const call = [...this.run.events].reverse().find((e) => e.kind === 'tool_call' && e.toolCallId === id);
    this.run.openCallId = undefined;
    this.run.summary.currentTool = undefined;
    if (!call) return;
    const dur = Math.max(50, ts - (call.ts ?? ts));
    const text = fail ? 'Error: command failed with exit code 2' : call.toolKind === 'run' ? `ok  ${this.rng.int(4, 60)} passed, 0 failed` : 'Done';
    this.result(id, call.toolName ?? 'tool', call.toolKind ?? 'other', ts, dur, text, fail, call.filePath, call.fileOp);
  }

  /** One "step" of work: a few related events. */
  step(ts: number, spread: number, failRate = 0.1) {
    const r = this.rng.next();
    let t = ts;
    const dt = () => (t += Math.max(200, Math.round(spread * this.rng.float(0.05, 0.3))));
    if (r < 0.25) {
      this.reasoning(dt());
      this.tool('read', dt(), { fail: this.rng.chance(failRate / 3) });
    } else if (r < 0.4) {
      this.tool('search', dt());
      this.tool('read', dt());
    } else if (r < 0.7) {
      this.assistant(dt());
      this.tool('edit', dt(), { fail: this.rng.chance(failRate) });
    } else if (r < 0.88) {
      this.tool('run', dt(), { fail: this.rng.chance(failRate * 2) });
    } else if (r < 0.95) {
      this.reasoning(dt());
      this.tool('web', dt(), { fail: this.rng.chance(failRate) });
    } else {
      this.tool(this.tools.agent ? 'agent' : 'other', dt());
    }
    return t;
  }
}

export function countsOf(run: DemoRun): RunCounts {
  const c: RunCounts = { events: run.events.length, messages: 0, toolCalls: 0, errors: 0, filesChanged: 0 };
  const files = new Set<string>();
  for (const e of run.events) {
    if (e.kind === 'user' || e.kind === 'assistant') c.messages++;
    if (e.kind === 'tool_call') c.toolCalls++;
    if (e.kind === 'error' || (e.kind === 'tool_result' && e.isError)) c.errors++;
    if (e.kind === 'file_change' && e.filePath) files.add(e.filePath);
  }
  c.filesChanged = files.size;
  if (run.events.length) {
    c.inputTokens = run.tokensIn;
    c.outputTokens = run.tokensOut;
  }
  return c;
}

export function detailOf(run: DemoRun, limit = 2000): RunDetail {
  const files = new Map<string, FileChangeSummary>();
  const tools: ToolCallSummary[] = [];
  const open = new Map<string, ToolCallSummary>();
  for (const e of run.events) {
    if (e.kind === 'file_change' && e.filePath) {
      const f = files.get(e.filePath) ?? { path: e.filePath, ops: [], count: 0 };
      const op = e.fileOp ?? 'edit';
      if (!f.ops.includes(op)) f.ops.push(op);
      f.count++;
      f.lastTs = e.ts;
      files.set(e.filePath, f);
    } else if (e.kind === 'tool_call') {
      const t: ToolCallSummary = { toolCallId: e.toolCallId, toolName: e.toolName ?? 'tool', toolKind: e.toolKind ?? 'other', input: e.text, startedAt: e.ts, open: true };
      tools.push(t);
      if (e.toolCallId) open.set(e.toolCallId, t);
    } else if (e.kind === 'tool_result' && e.toolCallId) {
      const t = open.get(e.toolCallId);
      if (t) {
        t.open = false;
        t.output = e.text;
        t.isError = e.isError;
        t.durationMs = e.durationMs;
        open.delete(e.toolCallId);
      }
    }
  }
  return {
    summary: { ...run.summary, counts: { ...run.summary.counts } },
    events: run.events.slice(-limit),
    totalEvents: run.events.length,
    files: [...files.values()],
    tools,
  };
}

export function refreshSummary(run: DemoRun): void {
  run.summary.counts = countsOf(run);
}

interface RunPlan {
  agent: AgentId;
  status: RunStatus;
  project?: string;
  /** Age of the last update in ms. */
  age: number;
  live?: boolean;
  keepAlive?: boolean;
  task?: number;
  size?: number;
  parent?: number;
}

/** Hand-placed runs at the top of the demo so screenshots and e2e tests can rely on them. */
const ANCHORS: RunPlan[] = [
  { agent: 'claude-code', status: 'running', project: 'todo-cli', task: 0, age: 20_000, live: true, keepAlive: true, size: 14 },
  { agent: 'codex', status: 'failed', project: 'weather-api', task: 0, age: DAY + 2 * HOUR, size: 10 },
  { agent: 'gemini-cli', status: 'waiting', project: 'blog-engine', task: 0, age: 4 * MIN, size: 8 },
  { agent: 'cursor', status: 'stuck', project: 'pixel-editor', task: 1, age: 25 * MIN, size: 9 },
  { agent: 'aider', status: 'done', project: 'recipe-box', task: 0, age: 3 * HOUR, size: 8 },
  { agent: 'copilot-vscode', status: 'idle', project: 'chess-engine', task: 0, age: 90_000, size: 7 },
  { agent: 'cline', status: 'unreadable', project: 'link-shortener', task: 0, age: 5 * HOUR },
  { agent: 'opencode', status: 'running', project: 'chess-engine', task: 1, age: 8_000, live: true, size: 10 },
  { agent: 'claude-code', status: 'done', project: 'todo-cli', task: 2, age: 40 * MIN, size: 6, parent: 0 },
  { agent: 'qwen-code', status: 'running', project: 'habit-tracker', task: 0, age: 45_000, live: true, size: 6 },
  { agent: 'roo-code', status: 'failed', project: 'pixel-editor', task: 0, age: 2 * HOUR, size: 7 },
  { agent: 'copilot-cli', status: 'done', project: 'weather-api', task: 2, age: DAY + 5 * HOUR, size: 6 },
  { agent: 'continue', status: 'done', project: 'link-shortener', task: 1, age: 3 * DAY, size: 5 },
  { agent: 'codex', status: 'running', project: 'recipe-box', task: 1, age: 30_000, live: true, size: 8 },
];

export type Scenario = 'demo' | 'empty' | 'firstrun' | 'many';

function plansFor(scenario: Scenario, rng: Rng): RunPlan[] {
  if (scenario === 'empty') return [];
  const total = scenario === 'many' ? 300 : 40;
  const plans = [...ANCHORS];
  // Remaining runs: mostly finished history, a few of every other status.
  const mix: RunStatus[] = ['done', 'done', 'done', 'done', 'failed', 'idle', 'waiting', 'stuck', 'unreadable', 'done', 'done', 'failed', 'running'];
  let i = 0;
  while (plans.length < total) {
    const status = mix[i % mix.length];
    const agent = AGENT_IDS[(i * 5 + 3) % AGENT_IDS.length];
    let age: number;
    if (status === 'idle') age = rng.int(30_000, 170_000);
    else if (status === 'waiting') age = rng.int(MIN, 30 * MIN);
    else if (status === 'stuck') age = rng.int(21 * MIN, 3 * HOUR);
    else if (status === 'running') age = rng.int(2_000, 4 * MIN);
    else age = rng.pick([rng.int(10 * MIN, 9 * HOUR), rng.int(DAY, 2 * DAY), rng.int(2 * DAY, 13 * DAY)]);
    plans.push({ agent, status, age, size: scenario === 'many' ? rng.int(4, 10) : rng.int(4, 14) });
    i++;
  }
  return plans;
}

export function buildDemo(scenario: Scenario, now: number, seed = 20261027): DemoRun[] {
  const root = new Rng(seed);
  const plans = plansFor(scenario, root.fork(1));
  const runs: DemoRun[] = [];
  plans.forEach((plan, index) => {
    const rng = root.fork(1000 + index);
    runs.push(makeRun(plan, rng, now, runs));
  });
  // Every status and agent shows up at least once in the demo (checked by the fixture tests).
  return runs;
}

export function makeRun(plan: RunPlan, rng: Rng, now: number, existing: DemoRun[]): DemoRun {
  const project = plan.project ? PROJECTS.find((p) => p.name === plan.project)! : rng.pick(PROJECTS);
  const title = project.tasks[plan.task ?? rng.int(0, project.tasks.length - 1)];
  const updatedAt = now - plan.age;
  const steps = plan.size ?? rng.int(4, 12);
  const duration = Math.round(steps * rng.float(40_000, 150_000));
  const startedAt = updatedAt - duration;
  const summary: RunSummary = {
    id: `${plan.agent}:${rng.hex(16)}`,
    agent: plan.agent,
    title,
    projectName: project.name,
    projectPath: `${HOME}/code/${project.name}`,
    gitBranch: plan.agent === 'aider' || rng.chance(0.85) ? rng.pick(project.branches) : undefined,
    model: rng.pick(MODELS[plan.agent]),
    startedAt,
    updatedAt,
    status: plan.status,
    counts: { events: 0, messages: 0, toolCalls: 0, errors: 0, filesChanged: 0 },
    sourcePath: sourcePathFor(plan.agent, project, rng, startedAt),
  };
  if (plan.parent !== undefined && existing[plan.parent]) {
    summary.parentId = existing[plan.parent].summary.id;
    summary.title = `Sub-agent: ${rng.pick(['explore the test helpers', 'check for unused exports', 'review the diff for mistakes'])}`;
  }
  const run: DemoRun = { summary, events: [], live: !!plan.live, keepAlive: plan.keepAlive, tokensIn: 0, tokensOut: 0 };

  if (plan.status === 'unreadable') {
    const reason = rng.pick(READ_ERRORS);
    summary.readError = reason;
    summary.statusDetail = reason;
    summary.title = '';
    refreshSummary(run);
    return run;
  }

  const w = new EventWriter(run, rng, project);
  let t = startedAt;
  w.user(rng.chance(0.4) ? `${title}. Keep the change small and add a test.` : title, t);
  const spread = duration / (steps + 1);
  for (let s = 0; s < steps; s++) t = Math.min(updatedAt - 1000, w.step(t + 500, spread));
  const end = updatedAt;

  switch (plan.status) {
    case 'running':
      if (rng.chance(0.6)) w.tool(rng.pick(['run', 'read', 'search', 'edit'] as ToolKind[]), end, { open: true });
      else w.reasoning(end);
      summary.statusDetail = summary.currentTool ? `Running ${summary.currentTool}` : undefined;
      break;
    case 'waiting': {
      w.tool('run', end - 1000, { open: true, input: rng.pick(['rm -rf dist && npm run build', 'git push origin HEAD', 'docker compose up -d']) });
      w.system('Waiting for your approval to run this command', end);
      summary.currentTool = undefined;
      summary.statusDetail = 'Waiting for tool approval';
      break;
    }
    case 'stuck': {
      w.tool('run', end, { open: true, input: `${project.test} -- --watch` });
      const mins = Math.max(21, Math.round((now - end) / MIN));
      summary.currentTool = undefined;
      summary.statusDetail = `A shell command has been running for ${mins} min with no output`;
      break;
    }
    case 'failed': {
      const e = rng.pick(ERRORS);
      w.error(e.text, end);
      summary.statusDetail = e.detail;
      break;
    }
    case 'idle':
      w.assistant(end, rng.pick(SUMMARIES));
      summary.statusDetail = 'Turn finished';
      break;
    case 'done':
      w.assistant(end, rng.pick(SUMMARIES));
      break;
  }
  for (const e of run.events) if (e.ts !== undefined && e.ts > end) e.ts = end;
  refreshSummary(run);
  return run;
}

export function demoProject(name: string): DemoProject {
  return PROJECTS.find((p) => p.name === name) ?? PROJECTS[0];
}

export { RUN_STATUSES };
