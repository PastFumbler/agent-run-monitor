# Contributing to Agent Run Monitor

Thanks for helping. Agent Run Monitor is a desktop app that reads the session files coding agents write to disk and shows each session as a run. It is MIT licensed and has no server, no account and no telemetry. This guide covers setting up a development copy, how the code is laid out, how to test, the privacy rules every contributor must follow, and how to add support for a new agent.

If something here is wrong or unclear, opening an issue or a pull request to fix this file is a welcome first contribution.

Contents

- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Tests](#tests)
- [Privacy rules for contributors](#privacy-rules-for-contributors)
- [Coding conventions](#coding-conventions)
- [Adding a source adapter](#adding-a-source-adapter)
- [Reporting a changed format](#reporting-a-changed-format)
- [Pull requests](#pull-requests)

## Development setup

You need:

- **Node 24** (the same major version as the Node inside Electron 45). Older versions may work, but the Cursor tests need the built-in `node:sqlite` module and the compressed Codex rollouts need Node's built-in zstd.
- **Git**.
- **Google Chrome**, only for the end-to-end tests (Playwright drives your installed Chrome, so no browser download is needed).

Then:

```sh
git clone https://github.com/PastFumbler/agent-run-monitor.git
cd agent-run-monitor
npm ci
npx install-electron
npm run dev
```

`npx install-electron` downloads the Electron binary. The project does not run install scripts on `npm ci` (newer npm versions block them unless allowed), so this step is explicit. Run it again after any Electron upgrade.

`npm run dev` starts the Electron app with hot reload. It reads your real agent session files, read-only. To point it at a different home folder instead (for example a folder of fixtures, or a simulator folder), set `ARM_HOME`:

```sh
# macOS / Linux
ARM_HOME=/path/to/fake-home npm run dev
# Windows PowerShell
$env:ARM_HOME = 'C:\path\to\fake-home'; npm run dev
```

With `ARM_HOME` set, every home-like variable is redirected into that folder and variables that point into your real profile are dropped, so nothing from your real profile is read. `ARM_USER_DATA` does the same for the app's own settings folder.

### Browser-only UI work

```sh
npm run dev:web
```

This serves only the renderer at http://localhost:5317 in your browser, backed by the **fixture backend**: synthetic demo runs, no Electron and no files from your disk. Use it for UI work, screenshots and anything you might share. The URL accepts a few parameters, for example `/?now=2026-10-27T15:30:00&live=0` pins the clock and stops the simulated live updates so the list order is stable.

### Live runs without a real agent

```sh
node scripts/simulate-live-runs.mjs --count 12 --duration 300
```

writes made-up Claude Code sessions into a temporary folder and keeps appending to them. Start the app with the `ARM_HOME` it prints, or add the printed folder as a custom Claude Code folder in Settings.

### Other scripts

| Command | What it does |
| --- | --- |
| `npm run typecheck` | TypeScript check of the whole project. |
| `npm run build` | Builds main, preload and renderer into `out/`. |
| `npm run dist:dir` | Builds an unpacked app for your OS into `release/`. |
| `npm run dist` | Builds the installers for your OS (unsigned unless signing variables are set; see `electron-builder.yml`). |
| `npm run scan-secrets` | Scans the working tree and the full git history for secrets and personal paths. |
| `npm run set-repo -- <owner>/<repo>` | Points every project link at your fork or the real repository. |

If you launch Electron from a shell that has `ELECTRON_RUN_AS_NODE=1` set (some editors and tools set it), Electron starts as plain Node and the window never opens. Unset it first.

## Project layout

```
src/
  core/                 Node-only logic, no Electron imports. Testable on its own.
    adapter.ts          The source adapter contract (read this first).
    adapters/<agent>/   One folder per agent family: discover + parse.
    all-adapters.ts     The list of adapters the app ships.
    build.ts            safeParse, run ids, and the conversion to what the UI sees.
    events.ts           pushEvent, toolKind, makeTitle and other shared helpers.
    jsonl.ts            Incremental, read-only JSONL reader (readJsonl) and readJson.
    status.ts           Status rules shared by every adapter (running, stuck, done...).
    masking.ts          Secret masking applied before text leaves the main process.
    store.ts            RunStore: discovery, watching, incremental parsing, batching.
    env.ts              Builds the Env adapters see (and the ARM_HOME redirect).
  main/                 Electron main process: window, security, IPC, OS integration.
  preload/              The contextBridge that exposes the typed backend to the renderer.
  renderer/             The React UI. src/backend holds the Electron and fixture backends.
  shared/               Types used on both sides: schema.ts, ipc.ts, settings.ts, project.ts.
test/fixtures/<agent>/  Anonymised or synthesized session files used by the adapter tests.
e2e/                    Playwright tests against the renderer with the fixture backend.
scripts/                scan-secrets, set-repo, simulate-live-runs.
build/                  Icons and installer resources.
docs/PLAN.md            Architecture, per-agent research, and design decisions.
```

The renderer never sees an agent's raw format. Adapters turn files into the common types in `src/shared/schema.ts`, the main process masks them, and the renderer talks to the backend only through the `Backend` interface in `src/shared/ipc.ts`.

## Tests

```sh
npm test                 # all unit tests (Vitest): core, adapters, masking, store, renderer, contrast
npm run typecheck
npm run test:e2e         # Playwright, starts the fixture web server on :5317 by itself
```

- **Unit tests** live next to the code as `*.test.ts` / `*.test.tsx`. Tests under `src/core`, `src/shared`, `src/main` and `test/` run in Node; tests under `src/renderer` run in jsdom. To run one file: `npx vitest run src/core/adapters/codex/codex.test.ts`.
- **Contrast test**: `src/renderer/src/theme/contrast.test.ts` checks every theme. Text tokens need at least 4.5:1 against every surface they appear on, UI tokens (borders, focus ring, status colours, icons) at least 3:1, and the status colours within a theme must be clearly distinguishable from each other. Run it alone with `npx vitest run src/renderer/src/theme/contrast.test.ts`. If you touch a colour, this must pass; a failing theme cannot ship.
- **End-to-end tests** in `e2e/` drive the renderer in Chrome against the fixture backend, so they never touch real session files. If you change what the UI shows or how keys behave, update or add a test there.

CI runs the type check, the unit tests (contrast included) and the end-to-end tests on Windows, macOS and Linux. Please run at least `npm run typecheck` and `npm test` before opening a pull request.

## Privacy rules for contributors

People run this app on machines full of private code. The repository must never become a place where that code, or anyone's identity, leaks. These rules are not negotiable:

1. **Never commit real session data.** Not a transcript, not a database, not a "small excerpt", not a screenshot of your real runs. Session files contain prompts, source code, file paths, command output and sometimes secrets.
2. **Fixtures must be anonymised or synthesized.** Use the placeholder user `alex` for home folders (`C:\Users\alex`, `/home/alex`, `/Users/alex`), a toy project such as `todo-cli`, toy prompts and fake ids that keep the real shape (a UUID stays a UUID). No real names, usernames, e-mail addresses, company names, host names, repository URLs or API keys, not even expired ones. See [Fixtures](#8-fixtures) below.
3. **Screenshots and recordings come from the fixture backend** (`npm run dev:web`), never from the app reading your own files.
4. **Issues and pull requests too.** When you describe a format, describe its structure (record types, field names, nesting) with the contents removed.
5. **Run the secret scan before every push:**

   ```sh
   npm run scan-secrets
   ```

   It scans every file in the working tree and every blob in the git history, plus commit author names and e-mails. It looks for provider API keys, private keys, tokens, URLs with embedded passwords, and personal home folder paths (anything under `Users\` or `/home/` other than the placeholders). It exits with code 1 on any finding.

   To also catch words that are private to you (your employer, your username, a client's name) without committing that list, put them one per line in a file outside the repository and point `ARM_PRIVATE_TERMS` at it:

   ```sh
   ARM_PRIVATE_TERMS=~/arm-private-terms.txt npm run scan-secrets
   ```

   Lines starting with `#` are comments. A line in the repository that contains the marker `scan-secrets:allow` is skipped; use it only for reviewed false positives (for example the masking test's fake keys), and say why in your pull request.

6. **Check your commit metadata.** The scan reads author names and e-mails too. If you do not want your e-mail in the history, use your GitHub `noreply` address.

If you find real data anywhere in the repository or its history, please report it privately as described in [SECURITY.md](SECURITY.md) rather than in a public issue.

## Coding conventions

- **TypeScript, strict mode, ES modules.** `npm run typecheck` must pass. Follow the style of the file you are editing: 2-space indent, single quotes, semicolons.
- **Start every file with a short comment** saying what it is for. Adapter files also record where the format knowledge came from (see [Confidence](#3-confidence-levels)).
- **Plain words for people.** Status details and error messages are shown to users: "Waiting for tool approval", "The file is gone (it was moved or deleted).", not error codes or stack traces.
- **`src/core` is read-only towards agent files.** It may read, stat and list agent paths. It must never write, rename, delete, create folders or change permissions there. See [Read-only rule](#6-the-read-only-rule).
- **No network.** Nothing in the app talks to the network except the opt-in update check in `src/main/system.ts`. Do not add fetches, CDN links, remote fonts or analytics.
- **No native modules and no child processes.** The app loads no `.node` files and starts no other programs. This keeps it simple to audit and keeps Windows Smart App Control happy. Use Node built-ins (`node:sqlite`, `node:zlib`) or pure-JS libraries.
- **New dependencies** need a reason in the pull request, a licence compatible with MIT, and an entry in `THIRD_PARTY_NOTICES.md` if their licence requires one.
- **UI**: use the theme tokens (CSS variables), never raw colours. Never use colour as the only signal; pair it with a shape or a word. Every animation goes through the motion policy (`useMotionPolicy`) so it respects reduced motion, low-GPU mode and hidden windows. Everything must be reachable by keyboard.
- **Be robust, not clever.** A bad file must never crash the app or block other runs. Unknown input is skipped and counted.

## Adding a source adapter

A source adapter teaches the app one agent's on-disk format. It finds the agent's session files (`discover`) and turns one of them into a run in the common schema (`parse`). The contract is `SourceAdapter` in [`src/core/adapter.ts`](src/core/adapter.ts). Read it alongside one existing adapter before you start:

- [`src/core/adapters/codex`](src/core/adapters/codex) is a compact example of an append-only JSONL format: per-OS roots with an env override (`paths.ts`), a stat-only discover with date folders, incremental parsing with a version-stamped state (`index.ts`, `records.ts`), and thorough tests.
- [`src/core/adapters/claude-code`](src/core/adapters/claude-code) shows sub-runs (sub-agents and workflow runs linked to a parent) and side files that signal a live state (`isLiveSignal`).
- [`src/core/adapters/cursor`](src/core/adapters/cursor) and [`src/core/adapters/opencode`](src/core/adapters/opencode) show the two accepted ways to read a SQLite database without ever opening the original.
- [`src/core/adapters/aider`](src/core/adapters/aider) shows an agent with no central folder, scanning user-chosen project folders (`ctx.projectRoots`) for a Markdown history.

Before writing code, look at docs/PLAN.md section 4 to see whether the agent has already been researched, and check open issues for an adapter request.

### 1. Files to create

```
src/core/adapters/<agent>/
  index.ts            exports the adapter object(s), plus the provenance header comment
  paths.ts            defaultRoots() and discover() (name it discover.ts if you prefer)
  records.ts          the record handling for parse() (split further if it grows)
  <agent>.test.ts     the tests listed in step 9
test/fixtures/<agent>/
  README.txt          where every fixture came from (see step 8)
  ...                 the fixtures themselves
```

`index.ts` must export either `adapter` (one agent) or `adapters` (several agents that share a format, as Gemini CLI and Qwen Code do), or both. The id must be one of `AGENT_IDS` (step 10).

```ts
export const myAgentAdapter: SourceAdapter = {
  id: 'my-agent',
  displayName: 'My Agent',
  confidence: 'source',
  note: 'Reads ~/.myagent/sessions (or $MYAGENT_HOME); checked against the source, not a real install.',
  defaultRoots,
  discover,
  parse,
};
export const adapter = myAgentAdapter;
export const adapters = [myAgentAdapter];
```

`note` is the one line the first-run wizard shows next to the agent: what it reads, where, and how sure we are.

### 2. `defaultRoots(env)`: where to look, per OS

`defaultRoots` returns the folders (or files) to look in on the current OS. It must be a pure function of the `Env` it is given; never read `process.env`, `os.homedir()` or `process.platform` directly, because tests pass in a fake `Env` for every OS:

```ts
interface Env {
  platform: NodeJS.Platform; // 'win32' | 'darwin' | 'linux' ...
  home: string;              // the user's home folder
  vars: Record<string, string | undefined>; // environment variables
}
```

Rules:

- **Honour the agent's own override first.** If the agent lets users relocate its data with an environment variable (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, `COPILOT_HOME`...), use it when it is set and not blank (`env.vars.X?.trim()`). Only honour variables the agent itself reads; cite where in its source.
- **Then the default for each OS.** Use `path.win32` when `env.platform === 'win32'` and `path.posix` otherwise, so a test on Linux can check the Windows answer. Typical places:
  - a dot folder in the home: `<home>/.myagent` on every OS;
  - an editor's user folder: `%APPDATA%\Code\User` on Windows (`env.vars.APPDATA`, falling back to `<home>\AppData\Roaming`), `~/Library/Application Support/Code/User` on macOS, `$XDG_CONFIG_HOME/Code/User` (falling back to `~/.config/Code/User`) on Linux;
  - XDG data: `$XDG_DATA_HOME/myagent` falling back to `~/.local/share/myagent`.
- **De-duplicate** (case-insensitively on Windows) and return roots that may not exist; the app shows missing ones in the wizard as "would be here".
- Return as few roots as possible. Every root is watched.

Users can add extra roots per adapter in Settings, so a custom root may point straight at the sessions folder rather than at the agent's home. Accept both if you can (Codex does).

### 3. Confidence levels

Every adapter declares how well its format is known. Be honest: users see this.

| `confidence` | Means | Evidence it needs |
| --- | --- | --- |
| `'verified'` | Checked against a real installation. | You ran the agent, inspected its real files (structure and counts, not contents), and the parser handles what you saw. The header comment names the agent versions and OS you checked, and says which parts (if any) are still only from source. The fixture is an anonymised real session. |
| `'source'` | Checked against the agent's current source code, not a real install. | The header comment names the repository and the exact commit (or tag) you read, and the source files that define the paths and records. The fixture is synthesized from those definitions, and its README cites the same commit. Anything you inferred rather than read is marked `[UNVERIFIED]` in a comment. |
| `'best-effort'` | Neither: closed source and not installed (or only public write-ups). | The header comment says what you based it on and that it is experimental. Parse defensively, expect format changes, and keep the claims in `note` modest. |

Mixed cases are normal ("locations verified on Windows, record schema from source"). Pick the weaker level and say exactly which part is which in the header comment and in docs/PLAN.md.

### 4. `discover(roots, ctx)`: cheap, stat only

```ts
discover(roots: string[], ctx: DiscoverContext): Promise<SessionRef[]>
// ctx: { env, since, projectRoots, tempDir? }
```

`discover` runs on start, when roots change and when new files appear, and the first-run wizard uses it to count runs. It must be fast on a large history:

- **Use `readdir` and `stat` only.** Do not read session contents. The exceptions are a small index file, or a whole-file format where the session list is only available inside one file (a SQLite database); keep those reads minimal.
- **Honour `ctx.since`.** Skip sessions whose mtime is older than `ctx.since` (epoch ms; `0` means everything). This is how "show runs from the last N days" stays fast.
- **Limit the walk.** Know the layout and walk only as deep as it goes; never recurse through an unknown tree.
- **Missing or unreadable roots are not errors.** Catch and skip them quietly.
- **Return one `SessionRef` per run:**

  ```ts
  { agent: 'my-agent', path, subId?, mtimeMs, size, hint? }
  ```

  `path` is the file (or folder, or database) the run lives in. `subId` tells apart several runs stored in one file, such as many chats in one database. The run's id is a hash of `path` and `subId`, so keep both stable across calls. `hint` carries anything cheap you already learned (`project`, a parent path, the agent home) as strings; `parse` can reuse it, and `hint.project` names the run if parsing fails.
- If the same session can appear twice (a compressed copy, an archived copy, an older storage generation), de-duplicate here and keep the freshest.
- `ctx.projectRoots` are folders the user chose for per-project agents like Aider. Most adapters ignore it.
- The store gives up on a `discover` call after 30 seconds and a `parse` call after 60 seconds. Real calls should take milliseconds.

### 5. `parse(ref, prev, ctx)`: incremental

```ts
parse(ref: SessionRef, prev: ParseState | undefined, ctx: ParseContext): Promise<ParseState>
// ctx: { env, tempDir }
```

`parse` returns a `ParseState` holding the run so far (`ParsedRun`) plus whatever you need to continue next time. It does not decide the run's status; `src/core/status.ts` does that from what you report.

**State.** Start from `freshState()` and `emptyRun(projectName)` from `adapter.ts`. Keep your own data in `state.extra`. It must be plain data (it is cloned with `structuredClone`), and it should carry a version number so a state from an older build of your adapter is discarded rather than misread:

```ts
const STATE_VERSION = 1;
const continuing = !!prev && !prev.run.readError && prev.extra.v === STATE_VERSION && prev.offset <= ref.size;
```

**Do not mutate `prev`.** The store may still hold it. Copy the run (events array, tally, files) and `extra` before you change them, as `continueState` in the Codex adapter and `cloneState` in the Claude Code adapter do. Events themselves are shared between states, so replace an event object rather than editing it.

**Append-only JSONL.** Use `readJsonl(path, offset, onRecord)` from `src/core/jsonl.ts`. It reads from the byte offset you consumed last time to the end of the file, calls `onRecord` for each complete JSON line, counts invalid lines in `bad`, leaves a final line that is not yet complete JSON for the next read, and reports `restarted` if the file shrank below your offset. Store `offset`, `size` and `mtimeMs` from its result in the state. If the file was rewritten or shrank, start over from a fresh state. Huge lines you never show can be skipped unparsed with the `skipLine` option.

**Whole-file JSON, SQLite and other formats.** Re-read only when the file's size or mtime changed; if neither did, return `prev` unchanged. `readJson(path)` reads a JSON file read-only and strips a byte-order mark.

**Building the run.** Add events with `pushEvent(run, event)` from `src/core/events.ts`, never by pushing to `run.events` yourself. It clips long text, keeps the tallies (events, messages, tool calls, errors) and the changed-files table current, updates `startedAt` / `lastEventAt` from event timestamps, takes the title from the first user message, and caps memory at `MAX_EVENTS` (older events are counted in `dropped`). Useful helpers in the same file: `ev()` (in `adapter.ts`) to build an event, `toolKind(name)` to classify a tool as run / edit / read / search / web / agent / other, `toolInputSummary(input)` and `toolFilePath(input)` for tool calls, `textOf`, `toMs` for timestamps, `makeTitle`, and `baseName` for project names.

Event kinds are `user`, `assistant`, `reasoning`, `tool_call`, `tool_result`, `file_change`, `error` and `system`. Give tool calls and results a `toolCallId` when the format has one so the UI can pair them, and set `isError` on failed results. Give file edits a `filePath` and `fileOp` (`create`, `edit`, `delete`).

Also fill in what the format offers: `projectPath` and `projectName` (last segment of the working directory), `gitBranch`, `model`, `inputTokens` / `outputTokens`, and `parentPath` for a sub-run whose parent is another session file.

**Turn and open tool.** These two fields drive the status:

- `run.turn`: how the last turn stands.
  - `'in_progress'`: the agent was mid-turn at the last record.
  - `'completed'`: the last turn ended normally (shown as idle for 3 minutes, then done).
  - `'waiting_input'`: the agent asked the user for approval or an answer.
  - `'error'`: the last turn ended in an error (shown as failed).
  - `'aborted'`: the user interrupted or cancelled.
  - `'unknown'`: the format does not say (a recently written file then counts as running).
- `run.turnDetail`: plain words for an error or wait, for example "API error: overloaded" or "Waiting for approval to run a command". It is shown to the user.
- `run.openTool`: the tool call that is still open at the end, as `{ name, kind, since }`, or `undefined`. A shell call open for 12 minutes, or any tool open for 65 minutes, with no writes reads as stuck; clear it when the result arrives.

If the format only lets you infer a wait (an unanswered tool call on a quiet file), say so in `turnDetail` ("probably waiting for approval") rather than claiming certainty.

### 6. The read-only rule

The app promises users it never changes their agent files. Your adapter may only:

- list folders (`readdir`), `stat` files, and open files with read flags (`open(path, 'r')`, `readFile`, `createReadStream`);
- write into `ctx.tempDir` (a scratch folder the app owns), and nowhere else.

It must never call `writeFile`, `appendFile`, `rename`, `unlink`, `rm`, `mkdir`, `chmod`, `utimes` or `copyFile` with a destination on an agent path, never create lock files, and never keep a file handle open after a parse (on Windows an open handle can block the agent from renaming or archiving its own file). Close handles in `finally`. Reviewers check imports in `src/core/adapters` for writing `fs` APIs. Tests may write freely, but only into temporary folders.

Do not read files that hold credentials even if they sit next to the sessions (for example an agent's `secrets.json`, `auth.json` or account tables). Say in a comment that you skip them.

**SQLite.** Never open the user's database with a SQLite engine. Even a read-only open can create a `-shm` file next to it or checkpoint its write-ahead log. Use the shared helper in `src/core/sqlite.ts` (the Cursor and OpenCode adapters do): `openSnapshot` / `readOnce` copy the database and its `-wal` (never the `-shm`) into a fresh subfolder of the temp dir you are given (`ctx.tempDir`, or `DiscoverContext.tempDir` during discovery), check the source did not change during the copy, open the copy with `node:sqlite` read-only, and delete the whole subfolder when done. SQLite replays the copied `-wal`, so rows not yet checkpointed are seen. Databases over the size limit are refused with a plain-words error. `src/core/sqlite.ts` is the only file in `src/core` allowed to write, and only there; `src/core/readonly.test.ts` fails if any other parsing code uses a writing file API.

Query only the tables you need using key ranges, not `LIKE` scans.

### 7. Graceful failure and format changes

Agents change their formats without notice. A new version must make your adapter degrade, never crash the app or hide other runs.

- **`safeParse` is your safety net.** The store wraps every `parse` call in `safeParse` (`src/core/build.ts`). Any throw becomes a run with status "unreadable" and a one-line reason chosen by `describeError` (file gone, no permission, file locked, invalid JSON, or the error message). Throwing on a missing or unreadable file is fine.
- **But do not throw on odd records.** Handle each record inside a `try`/`catch` (Codex's `safeHandle`) and count anything you do not recognise in `run.skipped`. Unknown record types, unknown fields and unexpected shapes are skipped and counted. Invalid JSON lines reported by `readJsonl` (`bad`) are added to `skipped` too.
- **Recognised bookkeeping is not "unknown".** Records you understand but do not show (titles, cost summaries, snapshots) count as recognised. Keep a `recognised` counter in `extra`.
- **Nothing recognisable at all means the format changed.** If a file had content but no record you recognised, set
  `run.readError = 'No records this app recognises; the agent may have changed its format.'`
  and clear it again (`delete run.readError`) once a later read finds recognisable records. The run then shows as "couldn't read this run" with that reason, which is what prompts users to file a [format changed](#reporting-a-changed-format) report.
- **A partial last line is normal.** Agents write while you read. Leave it for the next read rather than counting it as corrupt (`readJsonl` does this for you).

### 8. Fixtures

Fixtures live in `test/fixtures/<agent>/` and are committed byte-for-byte (`.gitattributes` marks them `-text`, so line endings are never converted; keep CRLF files CRLF if the agent writes CRLF).

- **If you have the agent installed**, base the main fixture on a real session you created for the purpose, with a toy project and toy prompts, then anonymise it: replace your home folder with `C:\Users\alex` / `/home/alex` / `/Users/alex`, replace every name, e-mail, host, repository URL and token, regenerate ids in the same shape, and keep the structure exactly as the agent wrote it. Re-read the whole file afterwards. Then run `npm run scan-secrets` with your `ARM_PRIVATE_TERMS` file.
- **If you do not**, synthesize the fixture by hand from the agent's source code: build each record from the type definitions, and cite the repository and commit you used. Mark anything you guessed, such as the exact order of records inside a turn.
- **Always add, as well:**
  - a **corrupt fixture**: a few good records, a garbage line, a blank line, and a final record cut off with no newline (see `test/fixtures/codex/codex-corrupt.jsonl`);
  - an **unknown-types fixture**: a file made only of record types the adapter does not know (see `test/fixtures/claude-code/unknown-types.jsonl`). It can also be written by the test itself.
- **For SQLite formats**, commit the schema and rows as a `.sql` text file and build the database in a temporary folder at test time (see `test/fixtures/opencode/v2.sql`). Never commit a binary database.
- **Write a `README.txt`** in the fixture folder saying, for each file, whether it is anonymised real data or synthesized, the agent version or source commit, and what scenario it covers (see `test/fixtures/codex/README.txt`).

Cover the scenarios that matter for status: a completed turn, a failed turn, an interrupted turn, a pending approval or question if the agent has one, tool calls with results (including a failed one), file edits, and a run cut off mid-turn with a tool still open.

### 9. Required tests

Put them in `src/core/adapters/<agent>/<agent>.test.ts`. Build `Env` values by hand (for example `{ platform: 'win32', home: 'C:\\Users\\alex', vars: {} }`) and write any temporary files under `os.tmpdir()`, cleaned up in `afterAll`. The existing adapters cover at least the following; yours should too:

Roots and discovery

- exports the adapter (or adapter family) with the right id and `confidence`;
- `defaultRoots` for Windows, macOS and Linux, with the agent's env override, and a blank override ignored;
- `discover` finds the fixture sessions (and sub-runs, if any), one ref per run;
- `discover` honours `since` and returns nothing, without throwing, for missing roots;
- `discover` accepts a custom root that points straight at the sessions folder (where that makes sense).

Parsing

- the main fixture gives the right title, project name and path, model, branch and token counts;
- records become the right event kinds and counts;
- every tool call is paired with its result, and failed results are errors;
- edited files are counted, with created files marked as created;
- each turn state the format can express: completed (idle, then done via `judgeStatus`), failed, waiting for input, aborted, and in progress with an open tool (running).

Bad input

- the corrupt fixture: the garbage line is counted in `skipped`, good records are kept, `readError` stays unset, and the cut-off last line is left for the next read (`offset` less than the file size);
- a file of only unknown record types sets `readError` to the "No records this app recognises" message, reads as `unreadable` through `judgeStatus`, and does not throw;
- unknown types inside otherwise known records are skipped, not fatal;
- a missing or unreadable file goes through `safeParse` to an unreadable run.

Incremental parsing (for append-only formats)

- feeding the file in pieces, including a line split across two writes, gives the same run as one full parse;
- a file that shrank or was rewritten starts over;
- for whole-file formats: an unchanged file returns `prev`, and (for SQLite) no files are left behind in the temp folder and none are created next to the original.

### 10. Register the adapter

1. **`src/shared/schema.ts`**: add the id to `AGENT_IDS` and its display name to `AGENT_NAMES`. The id is lower-case kebab-case and never changes once released, because run ids and user settings contain it.
2. **`src/core/all-adapters.ts`**: import your module and add it to `MODULES`. Order matters only for display. The registry skips malformed or duplicate adapters with a warning (printed to the terminal as `[arm] ...` under `npm run dev`), so a broken module cannot take the others down. Start the app once and check the first-run wizard lists your agent.
3. **Hooks, if they apply:**
   - `isRelevantChange(path)`: return false for watched paths that can never affect a run (caches, backups, snapshots), so busy folders do not trigger re-discovery. Default: every change is relevant.
   - `isLiveSignal(path)`: return true for side files that change a live run's state without touching its session file (Claude Code's `sessions/<pid>.json`, which records "waiting for approval"). The store then re-parses this adapter's active runs.
4. If the agent's data sits deeper below a root than the default watch depth (6 levels), pass a `watchDepth` entry for your agent where `src/main/index.ts` creates the `RunStore`.
5. The renderer's demo data and command-palette search (`src/renderer/src/backend/demoData.ts`, `fixture.ts`, `features/palette/search.ts`) list agents too. Add a demo run and a search alias so the new agent appears in the browser demo and can be found by name.

### 11. Update the docs

- **README.md**: add a row to the supported agents table (agent, where it reads on each OS, confidence).
- **docs/PLAN.md section 4.1**: add a row with the confidence (and the versions or commit), default roots and overrides, what it reads, and its status signals. If you add an agent from 4.2 ("candidates not built yet"), remove it there.
- **CHANGELOG.md**: add a line under `[Unreleased]`, `Added`.

### 12. Checklist

- [ ] `src/core/adapters/<agent>/` with `index.ts` exporting `adapter` and/or `adapters`, and a header comment recording provenance (versions checked, or repository and commit, and what is unverified).
- [ ] `confidence` matches the evidence; `note` says what is read and how sure we are.
- [ ] `defaultRoots` uses only the `Env` passed in, honours the agent's own override, and covers Windows, macOS and Linux.
- [ ] `discover` reads no session contents (beyond a small index), honours `since`, limits its walk, and ignores missing roots.
- [ ] `parse` is incremental for append-only files (`readJsonl` plus offset) and skips unchanged whole files; it never mutates `prev`; `extra` is plain, versioned data.
- [ ] Events go through `pushEvent`; tool calls carry ids where available; `turn`, `turnDetail` and `openTool` are set.
- [ ] Unknown records are skipped and counted; a file with nothing recognisable sets `readError`; nothing throws on odd shapes.
- [ ] Read-only: no writing `fs` calls on agent paths, handles closed, credential files never read, SQLite read only through `src/core/sqlite.ts`.
- [ ] Fixtures: main fixture (anonymised real or synthesized with the commit cited), corrupt fixture, unknown-types fixture, `README.txt`; no binary databases.
- [ ] All tests from step 9 pass; `npm test` and `npm run typecheck` pass.
- [ ] Registered in `AGENT_IDS`, `AGENT_NAMES` and `MODULES`; hooks added if needed; demo data and search alias added.
- [ ] README table, docs/PLAN.md section 4 and CHANGELOG updated.
- [ ] `npm run scan-secrets` is clean (with your `ARM_PRIVATE_TERMS`).

## Reporting a changed format

If a run shows "couldn't read this run", or a run looks wrong after you updated an agent, the agent has probably changed its format. Please open a **[Format changed](https://github.com/PastFumbler/agent-run-monitor/issues/new?template=format_changed.yml)** issue with:

- the agent and its version, and your OS;
- the exact message the app shows;
- the **structure** of the new records (record types, field names, nesting), with every value removed or replaced.

Please do not attach session files or paste their contents: they contain your code, your paths and possibly secrets. A shape like `{"type": "turn_end", "payload": {"status": "<string>", "usage": {"input": <n>}}}` is all we need.

To request support for an agent the app does not know yet, use the **[Adapter request](https://github.com/PastFumbler/agent-run-monitor/issues/new?template=adapter_request.yml)** template.

## Pull requests

- Keep each pull request to one change, and explain why as well as what.
- Fill in the checklist in the pull request template.
- Add or update tests with every behaviour change.
- For UI changes, add a before/after screenshot taken from the fixture backend (`npm run dev:web`).
- By contributing you agree that your contribution is licensed under the MIT licence of this project, and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
