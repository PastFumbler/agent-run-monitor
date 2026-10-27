#!/usr/bin/env node
// Writes synthetic Claude Code sessions and keeps appending to them, so the app has live runs to
// show without a real agent. Everything is made up: toy projects, toy prompts, fake ids.
//
//   node scripts/simulate-live-runs.mjs [--count 12] [--duration 300] [--dir <folder>] [--seed 7]
//
// It writes <dir>/projects/<encoded-cwd>/<uuid>.jsonl, the layout Claude Code uses under
// CLAUDE_CONFIG_DIR (default ~/.claude). Without --dir it creates <temp>/arm-sim-XXXX/.claude,
// so you can start the app with ARM_HOME=<temp>/arm-sim-XXXX, or add the printed folder as a
// custom Claude Code folder in Settings. Each session appends a record every 300-1500 ms.
// Sessions end in different ways: finished, failed (API error), waiting on a question, stalled
// on a long shell call, or busy until the time is up.

import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---- arguments ------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: node scripts/simulate-live-runs.mjs [--count 12] [--duration 300] [--dir <folder>] [--seed 7]');
  process.exit(0);
}
const COUNT = Math.max(1, Math.min(200, Number(opt('count', 12)) || 12));
const DURATION_S = Math.max(5, Number(opt('duration', 300)) || 300);
let seed = Number(opt('seed', Date.now() % 100000)) || 1;
const DIR = path.resolve(opt('dir', '') || path.join(mkdtempSync(path.join(tmpdir(), 'arm-sim-')), '.claude'));

// ---- deterministic randomness ---------------------------------------------------------------------

function rand() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const between = (a, b) => Math.round(a + rand() * (b - a));
const hexId = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const b62 = (n) => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: n }, () => abc[Math.floor(rand() * abc.length)]).join('');
};
const uuid = () => `${hexId(8)}-${hexId(4)}-4${hexId(3)}-${pick(['8', '9', 'a', 'b'])}${hexId(3)}-${hexId(12)}`;

// ---- synthetic material ----------------------------------------------------------------------------

const PROJECTS = [
  { name: 'todo-cli', lang: 'py', files: ['todo/cli.py', 'todo/store.py', 'tests/test_cli.py', 'README.md'] },
  { name: 'weather-api', lang: 'ts', files: ['src/server.ts', 'src/routes/forecast.ts', 'src/cache.ts', 'test/forecast.test.ts'] },
  { name: 'blog-engine', lang: 'rb', files: ['app/models/post.rb', 'app/views/posts/index.html.erb', 'config/routes.rb', 'spec/post_spec.rb'] },
  { name: 'pixel-garden', lang: 'rs', files: ['src/main.rs', 'src/grid.rs', 'src/render.rs', 'Cargo.toml'] },
  { name: 'recipe-box', lang: 'ts', files: ['src/App.tsx', 'src/components/RecipeCard.tsx', 'src/api.ts', 'package.json'] },
  { name: 'tiny-wiki', lang: 'go', files: ['main.go', 'wiki/page.go', 'wiki/page_test.go', 'templates/view.html'] },
  { name: 'budget-sheet', lang: 'py', files: ['budget/report.py', 'budget/categories.py', 'tests/test_report.py', 'pyproject.toml'] },
  { name: 'chess-clock', lang: 'ts', files: ['src/clock.ts', 'src/ui.ts', 'src/clock.test.ts', 'index.html'] },
  { name: 'markdown-slides', lang: 'js', files: ['lib/parse.js', 'lib/render.js', 'test/parse.test.js', 'bin/slides.js'] },
  { name: 'plant-tracker', lang: 'kt', files: ['app/src/main/Plant.kt', 'app/src/main/Schedule.kt', 'app/build.gradle.kts', 'README.md'] },
  { name: 'url-shortener', lang: 'go', files: ['cmd/server/main.go', 'store/sqlite.go', 'store/sqlite_test.go', 'Makefile'] },
  { name: 'habit-log', lang: 'swift', files: ['Sources/HabitLog/Log.swift', 'Sources/HabitLog/Streak.swift', 'Tests/StreakTests.swift', 'Package.swift'] },
];

const PROMPTS = [
  'Add a --due flag so tasks can have a due date, and show overdue ones in red',
  'The forecast endpoint is slow; add a small in-memory cache with a 10 minute expiry',
  'Write tests for the post model and fix whatever they find',
  'Refactor the render loop so the grid only redraws changed cells',
  'Add a search box that filters recipes by ingredient',
  'Pages with spaces in the title 404; fix the routing and add a test',
  'Group the monthly report by category and add a total row',
  'Add an increment option (Fischer) to the clock and cover it with tests',
  'Support speaker notes after a line with three question marks',
  'Add a watering reminder that respects the plant schedule',
  'Make short codes case-insensitive without breaking existing links',
  'Count a streak as broken only after two missed days',
];

const TEST_CMD = { py: 'python -m pytest -q', ts: 'npm test --silent', rb: 'bundle exec rspec', rs: 'cargo test', js: 'npm test', go: 'go test ./...', kt: './gradlew test', swift: 'swift test' };

const SAY = [
  "I'll start by looking at how this is structured today.",
  'Let me check the existing tests before changing anything.',
  'The change is small; updating the function and its caller.',
  'Running the tests to make sure nothing else broke.',
  'One test fails because the fixture still uses the old format. Fixing the fixture.',
  'All tests pass now.',
];

const DONE = [
  'Done. The feature is in place, covered by two new tests, and the full suite passes.',
  'Finished: the bug came from an off-by-one in the date check. Fixed it and added a regression test.',
  'All set. I kept the public API the same and documented the new option in the README.',
];

// ---- record builders (Claude Code 2.1.x shape, synthetic values) -----------------------------------

const VERSION = '2.1.309';
const MODEL = 'claude-sonnet-4-5';

function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

class Session {
  constructor(project, index) {
    this.project = project;
    this.id = uuid();
    this.cwd = process.platform === 'win32' ? `C:\\Users\\demo\\code\\${project.name}` : `/home/demo/code/${project.name}`;
    const dir = path.join(DIR, 'projects', encodeCwd(this.cwd));
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${this.id}.jsonl`);
    this.parent = null;
    this.prompt = PROMPTS[index % PROMPTS.length];
    this.ending = pick(['finish', 'finish', 'finish', 'fail', 'ask', 'stall', 'busy']);
    this.turns = between(1, 3);
    this.queue = [];
    this.done = false;
  }

  envelope(type, extra) {
    const uuidNow = uuid();
    const rec = {
      parentUuid: this.parent,
      isSidechain: false,
      userType: 'external',
      cwd: this.cwd,
      sessionId: this.id,
      version: VERSION,
      gitBranch: 'main',
      type,
      ...extra,
      uuid: uuidNow,
      timestamp: new Date().toISOString(),
    };
    this.parent = uuidNow;
    return rec;
  }

  user(text) {
    return this.envelope('user', { message: { role: 'user', content: text }, permissionMode: 'default' });
  }

  assistant(block, stop) {
    return this.envelope('assistant', {
      message: {
        model: MODEL,
        id: `msg_01${b62(22)}`,
        type: 'message',
        role: 'assistant',
        content: [block],
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: between(4, 40), cache_creation_input_tokens: between(0, 900), cache_read_input_tokens: between(2000, 30000), output_tokens: between(20, 600) },
      },
      requestId: `req_01${b62(22)}`,
    });
  }

  toolUse(name, input) {
    const id = `toolu_01${b62(22)}`;
    this.lastToolId = id;
    this.lastToolUuid = null;
    const rec = this.assistant({ type: 'tool_use', id, name, input }, 'tool_use');
    this.lastToolUuid = rec.uuid;
    return rec;
  }

  toolResult(content, toolUseResult, isError = false) {
    return this.envelope('user', {
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: this.lastToolId, content, is_error: isError }] },
      toolUseResult,
      sourceToolAssistantUUID: this.lastToolUuid,
    });
  }

  plan() {
    const p = this.project;
    const f = () => pick(p.files);
    const steps = [];
    steps.push(() => this.user(this.prompt));
    steps.push(() => ({ type: 'ai-title', aiTitle: this.prompt.split(/[,;]/)[0].slice(0, 60), sessionId: this.id }));
    for (let t = 0; t < this.turns; t++) {
      steps.push(() => this.assistant({ type: 'thinking', thinking: '', signature: b62(40) }, null));
      steps.push(() => this.assistant({ type: 'text', text: pick(SAY) }, null));
      const read = f();
      steps.push(() => this.toolUse('Read', { file_path: path.join(this.cwd, read) }));
      steps.push(() =>
        this.toolResult(`     1\t// ${read}\n     2\t(synthetic file contents)\n`, { type: 'text', file: { filePath: path.join(this.cwd, read), content: '(synthetic)', numLines: 2, startLine: 1, totalLines: 2 } }),
      );
      const edit = f();
      steps.push(() => this.toolUse('Edit', { file_path: path.join(this.cwd, edit), old_string: 'old line', new_string: 'new line', replace_all: false }));
      steps.push(() =>
        this.toolResult(`The file ${path.join(this.cwd, edit)} has been updated.`, {
          filePath: path.join(this.cwd, edit),
          oldString: 'old line',
          newString: 'new line',
          structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-old line', '+new line'] }],
          userModified: false,
          replaceAll: false,
        }),
      );
      const cmd = TEST_CMD[p.lang];
      const fail = rand() < 0.35;
      steps.push(() => this.toolUse('Bash', { command: cmd, description: 'Run the tests' }));
      steps.push(() =>
        fail
          ? this.toolResult(`Exit code 1\n1 failed, ${between(5, 40)} passed`, `Error: Exit code 1\n1 failed`, true)
          : this.toolResult(`${between(5, 40)} passed in ${(rand() * 3).toFixed(2)}s`, { stdout: 'all passed', stderr: '', interrupted: false, isImage: false }),
      );
      if (fail) {
        steps.push(() => this.assistant({ type: 'text', text: 'One test failed; looking at why.' }, null));
        steps.push(() => this.toolUse('Bash', { command: cmd, description: 'Run the tests again' }));
        steps.push(() => this.toolResult(`${between(5, 40)} passed`, { stdout: 'all passed', stderr: '', interrupted: false, isImage: false }));
      }
    }
    switch (this.ending) {
      case 'fail':
        steps.push(() => {
          const rec = this.assistant({ type: 'text', text: 'API Error: 529 Overloaded. Please try again later.' }, 'stop_sequence');
          rec.message.model = '<synthetic>';
          rec.message.usage = { input_tokens: 0, output_tokens: 0 };
          return { ...rec, isApiErrorMessage: true, error: 'server_error', apiErrorStatus: 529 };
        });
        break;
      case 'ask':
        steps.push(() =>
          this.toolUse('AskUserQuestion', {
            questions: [{ question: 'Should the new option be on by default?', header: 'Default', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }],
          }),
        );
        break;
      case 'stall':
        steps.push(() => this.toolUse('Bash', { command: 'npm run build -- --watch', description: 'Start the build watcher' }));
        break;
      case 'busy':
        // Keeps working until the simulation ends.
        for (let i = 0; i < 400; i++) {
          steps.push(() => this.assistant({ type: 'text', text: pick(SAY) }, null));
          steps.push(() => this.toolUse('Grep', { pattern: pick(['TODO', 'cache', 'parse', 'render']), path: this.cwd }));
          steps.push(() => this.toolResult(`Found ${between(1, 9)} files`, { mode: 'files_with_matches', numFiles: between(1, 9), filenames: [] }));
        }
        break;
      default:
        steps.push(() => this.assistant({ type: 'text', text: pick(DONE) }, 'end_turn'));
        steps.push(() => ({ type: 'last-prompt', lastPrompt: this.prompt.slice(0, 200), leafUuid: this.parent, sessionId: this.id }));
    }
    this.queue = steps;
  }

  step() {
    const next = this.queue.shift();
    if (!next) {
      this.done = true;
      return;
    }
    appendFileSync(this.file, `${JSON.stringify(next())}\n`);
  }
}

// ---- run --------------------------------------------------------------------------------------------

mkdirSync(DIR, { recursive: true });
const sessions = Array.from({ length: COUNT }, (_, i) => {
  const s = new Session(PROJECTS[i % PROJECTS.length], i);
  s.plan();
  return s;
});

console.log(`Simulating ${COUNT} Claude Code sessions for ${DURATION_S}s.`);
console.log(`Claude config folder (CLAUDE_CONFIG_DIR-style): ${DIR}`);
if (path.basename(DIR) === '.claude') console.log(`Start the app with ARM_HOME=${path.dirname(DIR)}`);
console.log('Or add that folder as a custom Claude Code folder in Settings > Sources.');

const until = Date.now() + DURATION_S * 1000;
const timers = new Set();
for (const s of sessions) {
  const tick = () => {
    timers.delete(t);
    if (Date.now() >= until || s.done) return;
    s.step();
    t = setTimeout(tick, between(300, 1500));
    timers.add(t);
  };
  let t = setTimeout(tick, between(0, 1200));
  timers.add(t);
}

const finish = () => {
  for (const t of timers) clearTimeout(t);
  const ended = sessions.filter((s) => s.done).length;
  console.log(`Stopped. ${ended} session(s) reached their ending; files stay in ${DIR}.`);
  process.exit(0);
};
setTimeout(finish, DURATION_S * 1000 + 50);
process.on('SIGINT', finish);
