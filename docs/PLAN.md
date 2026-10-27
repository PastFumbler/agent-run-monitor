# Agent Run Monitor: plan

Agent Run Monitor is a desktop app that watches the session files coding agents write to disk and shows each session as a **run**: what it is doing now, what it did, which files it touched, and whether it finished, failed or is stuck. It reads those files. It never writes to them, never sends anything over the network, and never needs an account.

This document is the architecture and build plan. The README is the user guide.

## 1. Goals and non-goals

Goals

- One window that shows every agent run on the machine, live, across agents.
- Zero setup for the common case: the first-run wizard finds installed agents itself.
- Strict privacy: read-only, local-only, secrets masked on screen by default.
- Comfortable to leave open all day: soft themes, low CPU and GPU, quiet animation.
- Easy to extend: adding an agent means adding one small adapter and a fixture.

Non-goals

- Controlling agents (approving tools, stopping runs, sending prompts). The app is a viewer.
- Cloud sync, accounts, sharing, or any server component.
- Monitoring tools that keep no local record (see section 4.3).

## 2. Stack, and why Electron rather than Tauri

The brief preferred Tauri (smaller installer, Rust-side file watching). Tauri was blocked on the development machine, so the app uses **Electron**:

- Tauri on Windows needs the MSVC linker and Windows SDK (Visual Studio Build Tools). The build machine had neither, installing Build Tools needs administrator rights the build session did not have, and the no-admin route (downloading the compiler packages into a user folder) was refused by that machine's security policy. Without a working local Tauri build, none of the required local verification (installer test, GPU measurements, live-run tests) could happen.
- Electron needs only Node, which was present. All parsing, watching and masking live in plain TypeScript, so contributors can add an adapter without a Rust toolchain.

What we give up, and how we limit it:

| Tauri advantage | Electron mitigation |
| --- | --- |
| ~10 MB installer | Accept ~90 MB; ship NSIS (per-user, no admin), DMG, AppImage and deb. |
| Rust file watching | `chokidar` (pure JS, native `fs.watch` underneath) plus a polling safety net; incremental tail reads keep large files cheap. |
| Smaller attack surface | Context isolation, sandboxed renderer, no Node in the renderer, strict CSP, no remote content, all navigation blocked, all permissions denied, network blocked at the session layer (section 6). |

Moving to Tauri later stays possible: the renderer talks to the backend only through the typed `Backend` interface in `src/shared/ipc.ts`.

Libraries (all MIT or similar, all free):

- Shell: Electron, electron-vite (build), electron-builder (installers).
- UI: React 19, TypeScript, zustand (state), cmdk (command palette), @dnd-kit (tile drag), @tanstack/react-virtual (long lists), motion (animation, required by the React Bits components).
- Backend: chokidar (watching); Node's built-in `node:sqlite` (part of Electron's Node 24, so no native module) for Cursor; Node's built-in zstd for compressed Codex rollouts.
- Tests: Vitest (unit, parsers, contrast, masking), Playwright (end to end, against the renderer in a browser with a fixture backend, and against the packaged Electron app).

Only packages the main process loads at run time (chokidar) are `dependencies` in `package.json`. The UI libraries are `devDependencies`: Vite bundles them into `out/renderer`, so electron-builder does not also copy their `node_modules` folders into `app.asar` (which shrank it from about 54 MB and 13,000 files to about 2 MB).

## 3. Architecture

```
┌────────────────────────── main process (Node) ──────────────────────────┐
│ SourceRegistry ─ adapters/*  (one per agent: discover() + parse())      │
│        │                                                                │
│ RunStore  ← Watcher (chokidar + poll) ← incremental readers (byte tail) │
│        │      status clock (re-judges live runs every few seconds)      │
│        │      masking (secrets → •••• before anything leaves main)      │
│ Settings (JSON in userData) · Power (battery) · Notifications           │
│ Autostart · Update check (off by default, the only network call)        │
└────────┬────────────────────────────────────────────────────────────────┘
         │ typed IPC (preload contextBridge), batched + throttled
┌────────▼──────────────── renderer (React, sandboxed) ───────────────────┐
│ Backend interface  ── ElectronBackend │ FixtureBackend (tests, demo)    │
│ store (zustand) → Run list · Run view · Multiviewer · Palette · Wizard  │
│ theme tokens (CSS variables) · motion policy (reduce motion, low GPU)   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.1 The common schema (`src/shared/schema.ts`)

The renderer knows only these types. No adapter type and no raw agent format crosses the IPC boundary.

```ts
type AgentId = 'claude-code' | 'codex' | 'gemini-cli' | 'qwen-code' | 'copilot-vscode'
  | 'copilot-cli' | 'aider' | 'cursor' | 'cline' | 'roo-code' | 'opencode' | ...;

type RunStatus = 'running' | 'waiting' | 'idle' | 'done' | 'failed' | 'stuck' | 'unreadable';

interface RunSummary {
  id: string;               // stable: `${agent}:${hash(sourcePath + sub-id)}`
  agent: AgentId;
  title: string;            // first real user prompt, trimmed
  projectName: string;      // last path segment of the working directory
  projectPath?: string;
  gitBranch?: string;
  model?: string;
  startedAt: number;        // epoch ms
  updatedAt: number;        // last event or file mtime
  status: RunStatus;
  statusDetail?: string;    // plain words: "Waiting for tool approval", "API error 529"
  counts: { events: number; toolCalls: number; errors: number; filesChanged: number;
            inputTokens?: number; outputTokens?: number };
  sourcePath: string;       // shown in Overview, so users can find the file
  readError?: string;       // set when status === 'unreadable'
}

type EventKind = 'user' | 'assistant' | 'reasoning' | 'tool_call' | 'tool_result'
  | 'file_change' | 'error' | 'system';

interface RunEvent {
  seq: number;              // monotonic within a run
  ts?: number;
  kind: EventKind;
  text: string;             // masked when masking is on
  toolName?: string; toolCallId?: string; toolKind?: 'run' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'other';
  filePath?: string; fileOp?: 'create' | 'edit' | 'delete';
  isError?: boolean; durationMs?: number;
}
```

### 3.2 Adapters (`src/core/adapters/<agent>/`)

```ts
interface SourceAdapter {
  id: AgentId;
  displayName: string;
  defaultRoots(env: Env): string[];         // per OS, honouring the agent's own env overrides
  discover(roots: string[], since: number): Promise<SessionRef[]>;  // cheap: stat only
  parse(ref: SessionRef, prev?: ParseState): Promise<ParseResult>;  // incremental
}
```

- `discover` lists session files and their mtimes without reading content, so the first-run wizard can count runs on a large history in well under a second.
- `parse` is incremental. JSONL adapters remember the byte offset and the partial last line. JSON and SQLite adapters re-read when mtime or size changes, debounced.
- Every adapter is wrapped by `safeParse`: any throw, invalid JSON or unknown shape becomes a run with status `unreadable` and a one-line reason ("couldn't read this run"). The app never crashes on a bad file. Unknown record types are skipped and counted, never fatal, so a new agent version degrades gracefully instead of breaking.
- Status inference is shared (`src/core/status.ts`) with per-adapter hints. The thresholds come from the older run monitor this project grew out of: quiet after 5 minutes of silence, stuck after 20, a shell call still open after 12 minutes counts as stuck (shell tools time out at 10), any tool open after 65 minutes is stuck, and a run counts as done after 3 minutes of silence following a completed turn.

### 3.3 Watching and live updates

- chokidar watches each enabled root (depth-limited, `ignoreInitial`) with `awaitWriteFinish` off; changes mark a run dirty. A slow poll (every 10 s by default) covers network drives and editors that defeat file events.
- Dirty runs are parsed incrementally and pushed to the renderer in **batches**: at most every 250 ms normally, every 1000 ms in low-GPU mode, every 5 s while the window is hidden or minimised.
- A status clock re-judges live runs every few seconds so "quiet" and "stuck" appear without new writes.
- Only runs inside the "show runs from the last N days" window are parsed; older ones are listed lazily.

### 3.4 Privacy and security model

- **Read-only.** Files are opened with read flags only. No adapter calls write, rename, unlink, mkdir or chmod on agent paths; a unit test fails if `src/core` uses a writing `fs` API anywhere except the temporary-copy helper. SQLite databases (Cursor, OpenCode) are copied with their `-wal` file into a temporary folder and read there with `node:sqlite`, so the original database is never opened by a SQLite engine and no `-shm` or `-wal` file is ever created next to it. `src/core/sqlite.ts` is the only file in `src/core` allowed to write, and only into its own temporary folder; `src/core/readonly.test.ts` fails the build if any other parsing code uses a writing file API.
- **Local-only.** The main process installs a `webRequest` filter that cancels every request that is not to the app's own files. The renderer CSP has `connect-src 'self'`. The spellchecker (which would download dictionaries) is disabled. Fonts are bundled. The only network call is the optional update check (off by default), a single GET to the GitHub Releases API, made from main only while that setting is on.
- **Masking.** Before any text leaves the main process it passes through `maskSecrets` when "Mask likely secrets" is on (the default). It covers provider API keys (OpenAI, Anthropic, Google, GitHub, GitLab, Slack, Stripe, AWS, Azure, npm, Hugging Face and others), bearer and basic auth headers, JWTs, private key blocks, `password=` and `secret=` style assignments, and connection strings with an embedded password (`postgres://user:pass@`, `Server=...;Password=...`). Matches become `••••` plus a kind label, for example `sk-…••••[OpenAI key]`. Tests plant fake keys of every kind and check none survive.
- **No telemetry**, no analytics, no crash reporter.

## 4. Source adapters

Each storage format below was researched separately. **Verified** means checked against a real installation on the development machine. **Source** means checked against the tool's current source code, with the commit recorded in the adapter's header comment. **Best-effort** means neither (closed source and not installed); treat those adapters as experimental. Every adapter ships with a fixture (anonymised real data where the tool was installed, synthesized from the source definitions otherwise), parser tests, a corrupt-file test and an unknown-records test.

### 4.1 Supported agents

| Agent | Confidence | Where it reads (default; override) | What it reads | Status signals |
| --- | --- | --- | --- | --- |
| **Claude Code** (CLI, IDE extensions, Desktop "Code") | Verified (v2.1.293–2.1.310) | `~/.claude` on every OS; `CLAUDE_CONFIG_DIR` | `projects/<encoded-cwd>/<session>.jsonl`; sub-agents in `<session>/subagents/agent-*.jsonl`; workflow runs in `subagents/workflows/wf_*/journal.jsonl`; `sessions/<pid>.json` for live state | `sessions/<pid>.json` status (`busy`, `waiting` + `waitingFor`) when its process is alive; otherwise transcript tail: open tool calls, `isApiErrorMessage`, interrupt markers, silence thresholds |
| **OpenAI Codex** (CLI, `codex exec`, IDE extension, desktop app) | Source (openai/codex @ 2026-10-27) | `~/.codex`; `CODEX_HOME` | `sessions/YYYY/MM/DD/rollout-*.jsonl` (and `.jsonl.zst`), `archived_sessions/`, `session_index.jsonl` for names | `task_started` / `task_complete` (with `error`) / `turn_aborted`; open `call_id` with no output; a `thread-writer-locks/<id>.lock` is only stat-ed |
| **Gemini CLI** | Source (google-gemini/gemini-cli @ 2026-10-26) | `~/.gemini`; `GEMINI_CLI_HOME` | `tmp/<slug>/chats/session-*.jsonl` (append-only log with `$set`/`$patch`/`$rewindTo` edits), older `session-*.json`; project path from `.project_root` / `projects.json` | Tool call status (success/error/cancelled), last message role, silence |
| **Qwen Code** | Source (QwenLM/qwen-code @ 2026-10-27) | `~/.qwen`; `QWEN_HOME` | `projects/<sanitized-cwd>/chats/<uuid>.jsonl` (Claude-like records with cwd and branch) | `<uuid>.runtime.json` pid sidecar, tool results by id, silence |
| **GitHub Copilot, VS Code agent mode** | Verified locations, Source for the record schema (VS Code 1.143, Copilot Chat 0.71) | `%APPDATA%\Code\User` (and Insiders, VSCodium; `~/Library/Application Support/Code/User`, `~/.config/Code/User`) | `workspaceStorage/<hash>/chatSessions/*.jsonl` (mutation log) or `*.json`, `globalStorage/emptyWindowChatSessions/`; folder from `workspace.json` | Request result / error; `toolInvocationSerialized` parts; freshness (VS Code saves in-flight requests as cancelled) |
| **GitHub Copilot CLI** | Verified locations, Source for the schema (CLI 1.0.73) | `~/.copilot`; `COPILOT_HOME` | `session-state/<id>/events.jsonl` + `workspace.yaml` | `permission.requested` without `permission.completed` = waiting; `session.shutdown`; tool `success:false` |
| **Aider** | Source (Aider-AI/aider @ 2026-05-22) | No central folder: `.aider.chat.history.md` in each project's git root, plus `~`. The user adds project folders; scanned to depth 4 | Markdown history; one run per `# aider chat started at` header | Known error lines, unanswered confirmation at the end, `/exit`, a later session header, silence |
| **Cursor** | Best-effort (closed source, not installed) | `%APPDATA%\Cursor\User` (macOS/Linux equivalents), `~/.cursor` | `globalStorage/state.vscdb` (`composerData:*`, `bubbleId:*`), read from a temporary copy of the database and its `-wal`; agent transcripts under `~/.cursor/projects/*/agent-transcripts/` | `turn_ended` status, `errorDetails`, tool call without result + freshness |

| **Cline** | Source (cline/cline @ 2026-10-27, v4.1.26; old format @ v3.89.2) | Editor `globalStorage/saoudrizwan.claude-dev` (VS Code, Insiders, VSCodium, Cursor, Windsurf) and `~/.cline/data`; `CLINE_DIR`, `CLINE_DATA_DIR` | Up to 3.89: `tasks/<id>/ui_messages.json` + `api_conversation_history.json`; 4.x: `sessions/<id>/` manifest + messages. Never reads `secrets.json` | Last `ask` type (`completion_result`, `tool`/`command`/`followup` = waiting), `api_req_failed`; 4.x status field + pid |
| **Roo Code** | Source (RooCodeInc/Roo-Code @ 2026-05-15) | `globalStorage/rooveterinaryinc.roo-cline` | Cline's 3.x layout plus `history_item.json` | As Cline 3.x, honouring `isAnswered` |
| **Continue** | Source (continuedev/continue @ 2026-07-20; repo now archived) | `~/.continue`; `CONTINUE_GLOBAL_DIR` | `sessions/<id>.json` | Tool call state (`generated` = waiting); no timestamps per message |
| **OpenCode** | Source (sst/opencode @ 2026-10-27) | `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode` on every OS | `opencode.db` (two SQLite schema generations, read from a temporary copy) and the older `storage/session|message|part/*.json` tree, de-duplicated by session id. Never reads account tables | 2.x: `time_suspended` and idle rows; 1.x: last assistant message `error` / `finish` / `time.completed` |

### 4.2 Candidates not built yet

Goose (`sessions/sessions.db`, source-verified) and Crush (per-project `.crush/crush.db`) are well defined and are the next adapters to add; see CONTRIBUTING.md. Amp and Kiro are closed source and were not available to check; Amazon Q CLI is superseded by Kiro.

### 4.3 What cannot be monitored

- **ChatGPT web and desktop apps**: ordinary chats write no local run data. ChatGPT's coding agent is supported through Codex, which writes rollout files locally (Codex mode inside the ChatGPT desktop app is expected to use the same store, inferred from Codex source).
- **Windsurf**: Cascade sessions are stored as encrypted protobuf (`~/.codeium/windsurf/cascade/*.pb`). Not supported.
- **Cloud-only agents** (Codex cloud tasks, Copilot coding agent on github.com, Devin, Jules): they run on remote machines and leave nothing local.
- **Live "waiting for approval"** is only directly recorded by Claude Code (`sessions/<pid>.json`) and Copilot CLI. For the others it is inferred from an unanswered tool call and a quiet file, and the UI says so ("probably waiting").
- **Per-message timestamps**: Aider records only the session start; its events are shown in order without exact times.

## 5. UI

### 5.1 Layout

- Left: the **run list** with search, filter chips (agent, status), pinned runs, recent runs, and everything else grouped by day. Uses React Bits Animated List for insertions (reduced to a plain fade, or nothing, under the motion policy).
- Centre: the **run view**: header with Status Mark, title, agent, project, previous/next arrows and a view switcher (React Bits Rubber Segment): Activity, Overview, Files, Tools, Timeline.
- The **multiviewer** replaces the centre when two or more runs are selected.

### 5.2 Navigation

- ← / → (or `[` / `]`): previous / next run in the current list order. `j` / `k`: move the list selection. Enter: open. `p`: pin. `1`–`5`: switch view. `m`: add to the multiviewer selection. `g` then `m`: open the multiviewer. `f`: maximise focused tile. `Esc`: close overlays, restore tiles. `Ctrl+K`: command palette. `?`: cheat sheet. `Ctrl+,`: settings.
- The command palette searches runs by project, agent, status and time ("codex failed yesterday" works: tokens match agent names, statuses and relative dates) and also runs commands (switch theme, open settings, toggle low-GPU mode).
- The cheat sheet is always one key away and is linked from the status bar.

### 5.3 Multiviewer

- Grid by count: 1 full width; 2 side by side; 3–4 as 2×2; 5–6 as 3×2; 7–9 as 3×3; 10–12 as 4×3. More than 12 pages in sets of 12 (the cap is a setting, at most 12).
- Each tile has its own view switcher, maximise, remove and a drag handle (dnd-kit, keyboard accessible). Selections can be saved as named layouts.
- Performance: updates are batched per tile; lists are virtualised; tiles off-screen (IntersectionObserver) or hidden behind a maximised tile pause animation and stop rendering updates until visible; in low-GPU mode, unfocused tiles refresh every 3 s.

### 5.4 Status presentation

| Status | Shape | Words |
| --- | --- | --- |
| running | spinning ring segment (static ring under reduced motion) | Running (or a synonym, see 5.6) |
| waiting | pause bars | Waiting for you |
| idle | hollow circle | Idle |
| done | check | Done |
| failed | cross | Failed |
| stuck | clock with slash | Stuck: no activity for 23 min |
| unreadable | question mark in a dashed circle | Couldn't read this run |

Colour reinforces the shape; it is never the only signal. Screen readers get the plain status word through an `aria-live="polite"` region that changes only when the status changes.

### 5.5 Themes and contrast

Six soft presets, three light and three dark: Paper, Sage, Dawn (light); Dusk, Moss, Harbor (dark). Each theme is a token set (surface, raised, text, muted text, border, focus, accent, and a colour per status). `src/renderer/theme/contrast.test.ts` checks every theme automatically:

- text tokens against every surface they appear on: at least 4.5:1;
- UI tokens (borders of inputs, focus ring, status colours, icons) against surfaces: at least 3:1;
- status colours within a theme are pairwise distinguishable (CIEDE2000 ΔE ≥ 15).

A failing theme fails CI, so it cannot ship.

### 5.6 Motion, low-GPU mode and the fun parts

- **Motion policy** (`useMotionPolicy`): one hook that every animated component reads. Inputs: the "reduce motion" setting (Auto follows the OS `prefers-reduced-motion`), low-GPU mode, and window visibility. Outputs: `animate` (bool), `duration` (150–250 ms normally, about 120 ms in low-GPU mode), `allowInfinite`, `allowLayered` (shadows, blur, filters).
- **Reduce motion** (accessibility): no movement; state changes become instant or a short cross-fade.
- **Low-GPU mode** (performance; Off / On / Auto, default Auto). Auto turns it on when the computer runs on battery (Electron `powerMonitor.isOnBatteryPower()` and its `on-battery` / `on-ac` events). Battery only: Electron exposes no energy-saver flag, and reading the OS setting would need a native module or a child process, which the app avoids for Smart App Control reasons (it starts no child processes and loads no native modules, see §9 phase 9). When on: no backdrop-filter, blur, filters, layered shadows or canvas effects; animations are opacity/transform only, shorter and never infinite; live updates batch to once a second; unfocused multiviewer tiles update every 3 s.
- **Hidden window** (always on, not a setting): when minimised or hidden, all animation stops (a `data-hidden` attribute pauses every CSS animation and the motion policy stops JS animation) and updates batch every 5 s.
- **Synonyms**: an active run's label rotates through words like Cogitating, Percolating, Noodling (React Bits Rotating Text; under low-GPU mode a plain text swap with no 3D flip). The rotating word is `aria-hidden`; screen readers hear the real status. Failed, stuck and errored runs show plain words immediately. Toggle in settings, on by default.
- **Totally fake progress bar**: on running runs only, a bar with a confidently absurd ETA ("about 3 minutes and 14.159 seconds", lurching), captioned in small text "totally fake progress bar". It is never shown on finished or failed runs. Toggle in settings, on by default.

### 5.7 React Bits

Used deliberately, all from the free public repository (MIT + Commons Clause), never Pro: Status Mark (run state), Lattice Loader and Call Chip (live activity), Thought Line (reasoning steps), Rubber Segment (view switcher), Animated List (run list), Counter (stats), Rotating Text (synonyms). Each vendored file keeps the original copyright notice and a header naming its source and licence; `THIRD_PARTY_NOTICES.md` carries the full licence text. The Commons Clause forbids selling or redistributing the components on their own, which is why they stay inside the app source and are not published as a package. No WebGL backgrounds.

## 6. Settings

Stored as JSON in the Electron `userData` folder, validated on load (unknown or invalid values fall back to defaults, never crash):

sources and custom paths (per adapter: on/off, extra roots), refresh rate, default run view, grid tile limit, notifications on finish and on failure, reduce motion (Auto / On / Off), low-GPU mode (Auto / On / Off), synonyms, fake progress bar, theme, text size, density, time format (12 h / 24 h / relative), start with the OS, how far back to show runs, mask likely secrets, check for updates (off).

## 7. First run

The wizard runs when no settings file exists:

1. Welcome, with the privacy promise in three lines.
2. Detection: every adapter's default roots are checked; each found agent shows its path and run count; missing ones show where they would be. Each can be switched off; custom paths can be added with a folder picker.
3. Look: theme preview and the humour toggles.
4. Done: opens straight onto the most recent run.

## 8. Repository

`README.md` (setup guide, privacy, supported agents, troubleshooting, screenshots and GIF made from the fixture backend so no real data appears), `LICENSE` (MIT), `THIRD_PARTY_NOTICES.md`, `CONTRIBUTING.md` (including "Adding a source adapter"), `CHANGELOG.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/` (bug, adapter request, format changed), `.github/workflows/ci.yml` (typecheck, unit tests, contrast test, e2e on Windows, macOS and Linux on every push), `.github/workflows/release.yml` (on `v*` tags: build installers on the three OSes and attach them to a GitHub Release). `scripts/scan-secrets.mjs` scans the tree and history before any push.

## 9. Build phases

Each phase ends with a commit.

0. **Plan**: this document, licence, ignore files.
1. **Core**: schema, adapter interface, safeParse, status inference, masking with tests, settings model; Claude Code adapter with fixture and tests.
2. **Adapters**: Codex, Gemini CLI / Qwen Code, Copilot (VS Code and CLI), Aider, Cursor, Cline / Roo Code, OpenCode, Continue; fixtures and tests for each, including corrupt-file tests.
3. **Live backend**: Electron main, watcher, incremental readers, batching, IPC, network guard, power monitor, notifications, autostart, update check.
4. **UI foundation**: themes plus the contrast test, motion policy, run list, run view with all views, navigation, command palette, cheat sheet, vendored React Bits.
5. **Multiviewer**: grid, tiles, drag, maximise, layouts, pagination, performance work.
6. **Settings, wizard and fun parts**: settings screen, first-run wizard, low-GPU mode, synonyms, fake progress bar.
7. **Repo and release**: README guide with screenshots and GIF, CONTRIBUTING, CHANGELOG, templates, CI, release workflow, secret scan.
8. **Verification**: run the whole test suite, e2e at every grid size, reduced motion, masking, GPU measurements, a clean-profile install, a live Claude Code run; fix what fails; record results in `docs/VERIFICATION.md`.
9. **Smart App Control audit**: `scripts/check-blocks.ps1` enumerates every executable or loadable file in the built release (types taken from Microsoft's current Smart App Control documentation), checks each Authenticode signature, separates our files (must be signed by us when signing is configured) from third-party files (must carry their publisher's valid signature), and runs in the release workflow after signing. A runtime pass launches the app, drives the main features and records every child process and loaded module for the same check. `docs/BLOCK-TEST.md` gives the manual test on a machine with Smart App Control on. Design rule that keeps this small: the app starts no child processes and loads no native `.node` modules.
