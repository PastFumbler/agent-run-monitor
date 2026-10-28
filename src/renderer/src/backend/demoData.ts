// Synthetic demo data for the fixture backend: toy projects, made-up prompts, invented tool output.
// Nothing here comes from a real machine. Content is fully determined by the seed; only the
// timestamps are placed relative to `now`, so the same ?now= gives the same screen every time.

import type { RunFolder } from '@shared/folders';
import {
  AGENT_IDS,
  RUN_STATUSES,
  type AgentId,
  type CodeChange,
  type FileChangeSummary,
  type FileOp,
  type RunCounts,
  type RunDetail,
  type RunEvent,
  type RunStatus,
  type RunSummary,
  type RunUsage,
  type TokenUsage,
  type ToolCallSummary,
  type ToolKind,
} from '@shared/schema';
import { USAGE_FIELDS, dayKey } from '@shared/usage';
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

// What each made-up agent's records hold, mirroring the real sources (see docs/PLAN.md 3.2):
// Cursor rarely records tokens, so its demo runs report none; only some sources split out the
// prompt cache; Copilot in VS Code names edited files without the replaced text; Claude Code
// stores most thinking without its text.
const NO_USAGE: ReadonlySet<AgentId> = new Set(['cursor']);
const CACHE_READ: ReadonlySet<AgentId> = new Set(['claude-code', 'codex', 'opencode', 'cline', 'roo-code', 'copilot-cli', 'gemini-cli', 'qwen-code', 'aider']);
const CACHE_WRITE: ReadonlySet<AgentId> = new Set(['claude-code', 'opencode', 'cline', 'roo-code', 'copilot-cli', 'aider']);
const NO_DIFF: ReadonlySet<AgentId> = new Set(['copilot-vscode']);
const HIDDEN_THINKING: ReadonlySet<AgentId> = new Set(['claude-code']);

/** Made-up code lines per language, for the demo's diffs. */
const CODE: Record<DemoProject['lang'], string[]> = {
  ts: ['const ttl = options.ttl ?? 300;', 'if (!input) return null;', 'return items.filter((t) => !t.done);', 'export function parseArgs(argv: string[]) {', '  const flags = new Map<string, string>();', '}', '// Keep the old flag working for one release.', "logger.debug('cache miss', key);", 'const due = args.due ? new Date(args.due) : undefined;', 'items.sort((a, b) => a.order - b.order);'],
  py: ['def get_forecast(city: str) -> dict:', '    if city not in CITIES:', '        raise HTTPException(status_code=404)', '    return cache.get(key) or fetch(city)', 'CACHE_TTL = 600', '# Keep the old route working for one release.', '    units = request.args.get("units", "metric")', 'from app.cache import cache'],
  rs: ['pub fn render(post: &Post) -> String {', '    let mut out = String::new();', '    out.push_str(&post.title);', '}', 'let minutes = words / 200 + 1;', '// Keep the old feed path for one release.', 'use crate::markdown::to_html;'],
  go: ['func (s *Server) Shorten(w http.ResponseWriter, r *http.Request) {', '	if url == "" {', '		http.Error(w, "missing url", http.StatusBadRequest)', '	}', '	code := s.store.Next()', '// Keep the old handler for one release.', 'return nil'],
  c: ['static int score(const Board *b) {', '    int total = 0;', '    for (int i = 0; i < 64; i++) total += value[b->sq[i]];', '    return total;', '}', '/* Keep the old evaluator for one release. */', '#include "board.h"'],
  rb: ['def scale(factor)', '  ingredients.map { |i| i.scale(factor) }', 'end', '  validates :title, presence: true', '# Keep the old route for one release.', "  render json: recipe"],
};

/** A unified-diff style text with made-up lines, matching the given counts. */
function fakeDiff(rng: Rng, lang: DemoProject['lang'], op: FileOp, added: number, removed: number): string {
  const pool = CODE[lang];
  const lines = (n: number, mark: string) => Array.from({ length: n }, () => mark + rng.pick(pool));
  if (op === 'create') return [`@@ -0,0 +1,${added} @@`, ...lines(added, '+')].join('\n');
  if (op === 'delete') return [`@@ -1,${removed} +0,0 @@`, ...lines(removed, '-')].join('\n');
  const at = rng.int(4, 120);
  return [`@@ -${at},${removed + 3} +${at},${added + 3} @@`, ...lines(2, ' '), ...lines(removed, '-'), ...lines(added, '+'), ...lines(1, ' ')].join('\n');
}

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
  /** Edits, oldest first (RunDetail.changes). */
  changes: CodeChange[];
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
    const usage = this.usageFor(ev);
    if (usage) ev.usage = usage;
    this.run.events.push(ev);
    return ev;
  }

  /** Made-up tokens for one model message: the context grows as the run goes on. */
  private usageFor(ev: RunEvent): TokenUsage | undefined {
    const agent = this.run.summary.agent;
    if (NO_USAGE.has(agent) || (ev.kind !== 'assistant' && ev.kind !== 'reasoning' && ev.kind !== 'tool_call')) return undefined;
    const output = Math.ceil(ev.text.length / 4) + 40;
    const context = 1800 + this.run.events.length * 260;
    if (!CACHE_READ.has(agent)) return { input: context, output };
    const fresh = Math.round(context * 0.08);
    const write = CACHE_WRITE.has(agent) ? Math.round(context * 0.05) : undefined;
    return { input: fresh, output, cacheRead: context - fresh - (write ?? 0), cacheWrite: write };
  }

  private vars(file?: string): Record<string, string> {
    return { task: this.run.summary.title, file: file ?? this.rng.pick(this.project.files), test: this.project.test };
  }

  user(text: string, ts: number) {
    return this.push({ kind: 'user', text, ts });
  }
  reasoning(ts: number) {
    if (HIDDEN_THINKING.has(this.run.summary.agent) && this.rng.chance(0.75)) {
      return this.push({ kind: 'reasoning', text: `Thinking (${this.rng.float(0.8, 9).toFixed(1)} s, text not stored)`, ts, placeholder: true });
    }
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
    let lines: { added: number; removed: number } | undefined;
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
        lines = this.editLines(fileOp);
        output = fail
          ? 'Error: old_string not found in file. The file may have changed since it was read.'
          : `Applied ${plural(this.rng.int(1, 6), 'change')} to ${filePath} (+${lines.added} -${lines.removed})`;
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
    this.result(callId, name, kind, ts + dur, dur, output, fail, filePath, fileOp, lines);
    return callId;
  }

  private editLines(op: FileOp): { added: number; removed: number } {
    if (op === 'create') return { added: this.rng.int(6, 30), removed: 0 };
    if (op === 'delete') return { added: 0, removed: this.rng.int(5, 40) };
    return { added: this.rng.int(1, 12), removed: this.rng.int(0, 6) };
  }

  result(
    callId: string,
    name: string,
    kind: ToolKind,
    ts: number,
    durationMs: number,
    text: string,
    fail: boolean,
    filePath?: string,
    fileOp?: FileOp,
    lines?: { added: number; removed: number },
  ) {
    this.push({ kind: 'tool_result', text, ts, toolName: name, toolCallId: callId, toolKind: kind, isError: fail || undefined, durationMs });
    if (kind === 'edit' && !fail && filePath) {
      const op = fileOp ?? 'edit';
      this.push({ kind: 'file_change', text: `${op === 'create' ? 'Created' : op === 'delete' ? 'Deleted' : 'Edited'} ${filePath}`, ts, filePath, fileOp: op });
      const change: CodeChange = { ts, filePath, op, toolCallId: callId };
      if (!NO_DIFF.has(this.run.summary.agent)) {
        const n = lines ?? this.editLines(op);
        change.linesAdded = n.added;
        change.linesRemoved = n.removed;
        change.diff = fakeDiff(this.rng, this.project.lang, op, n.added, n.removed);
      }
      this.run.changes.push(change);
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

/** Usage totals and per-day buckets from the events' per-message usage, like the main process. */
export function usageOf(events: RunEvent[]): RunUsage | undefined {
  let total: RunUsage | undefined;
  const add = (into: TokenUsage, u: TokenUsage) => {
    for (const k of USAGE_FIELDS) if (u[k] !== undefined) into[k] = (into[k] ?? 0) + u[k]!;
  };
  for (const e of events) {
    if (!e.usage) continue;
    total ??= { byDay: {} };
    add(total, e.usage);
    if (e.ts) add((total.byDay![dayKey(e.ts)] ??= {}), e.usage);
  }
  return total;
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
    changes: run.changes.slice(-limit).map((c) => ({ ...c })),
    totalChanges: run.changes.length,
  };
}

/**
 * A made-up "AI" summary for the browser demo, which never calls a provider: worded differently from
 * the local summary so the two are easy to tell apart on screen.
 */
export function demoAiSummary(d: RunDetail): string {
  const s = d.summary;
  const task = s.title ? `“${s.title.replace(/[.!?]+$/, '')}”` : 'an untitled task';
  const top = [...d.files].sort((a, b) => b.count - a.count)[0]?.path.split('/').pop();
  const files = d.files.length === 1 ? '1 file' : `${d.files.length} files`;
  const touched = d.files.length ? `It has touched ${files}${top && d.files.length > 1 ? `, mostly ${top},` : ''}` : 'It has not changed any files';
  const where: Record<string, string> = {
    running: 'and is still going',
    waiting: 'and is waiting for your reply',
    idle: 'and is paused between turns',
    done: 'and wrapped up cleanly',
    failed: 'but stopped on an error',
    stuck: 'but has gone quiet for a long time',
    unreadable: '',
  };
  return `In ${s.projectName}, the agent took on ${task}. ${touched} ${where[s.status] ?? ''}.`.replace(/\s+\./g, '.');
}

export function refreshSummary(run: DemoRun): void {
  run.summary.counts = countsOf(run);
  run.summary.usage = usageOf(run.events);
  run.summary.hasReasoning = run.events.some((e) => e.kind === 'reasoning' && !e.placeholder);
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
  // A little older history (as with a longer history setting) so the run list viewer shows month
  // groups. Set after the loop so the random draws, and so every other run, stay the same.
  if (scenario === 'demo') {
    const older = [33, 47, 61];
    for (let j = ANCHORS.length, k = 0; j < plans.length && k < older.length; j++) {
      if (plans[j].status === 'done') plans[j] = { ...plans[j], age: older[k++] * DAY };
    }
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
  const run: DemoRun = { summary, events: [], live: !!plan.live, keepAlive: plan.keepAlive, changes: [] };

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
  for (const c of run.changes) if (c.ts !== undefined && c.ts > end) c.ts = end;
  refreshSummary(run);
  return run;
}

/**
 * Made-up run folders for the demo: two that hold the runs of some projects, one still empty.
 * Like the user's real folders they are settings data, keyed by run id.
 */
export function demoFolders(runs: Iterable<DemoRun>): { folders: RunFolder[]; runFolders: Record<string, string> } {
  const folders: RunFolder[] = [
    { id: 'f_demo_work', name: 'Client work' },
    { id: 'f_demo_side', name: 'Side projects' },
    { id: 'f_demo_later', name: 'Someday' },
  ];
  const byProject: Record<string, string> = {
    'weather-api': 'f_demo_work',
    'link-shortener': 'f_demo_work',
    'chess-engine': 'f_demo_side',
    'pixel-editor': 'f_demo_side',
  };
  const runFolders: Record<string, string> = {};
  for (const r of runs) {
    const fid = r.summary.projectName ? byProject[r.summary.projectName] : undefined;
    if (fid) runFolders[r.summary.id] = fid;
  }
  return { folders, runFolders };
}

export function demoProject(name: string): DemoProject {
  return PROJECTS.find((p) => p.name === name) ?? PROJECTS[0];
}

export { RUN_STATUSES };
