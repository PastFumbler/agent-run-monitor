# Agent Run Monitor

Agent Run Monitor is a desktop app for Windows, macOS and Linux that shows what your coding agents are doing. Claude Code, Codex, Gemini CLI, GitHub Copilot, Aider, Cursor and others save each session to a file on your computer. The app reads those files and shows every session as a **run**: what it is doing now, what it did, which files it changed, and whether it finished, failed, is waiting for you or looks stuck. It only reads. It never controls an agent, and it never changes an agent's files.

![A live run updating, stepping between runs with the arrow keys, searching with Ctrl+K and opening the multiviewer](docs/images/demo.gif)

All pictures on this page come from the app's built-in demo, which uses made-up runs.

## Privacy

- **Read-only.** The app opens agent files for reading only. It never writes, renames, moves or deletes anything in any agent's folders. Two agents (Cursor and OpenCode) keep their sessions in a database. For those, the app copies the database into its own temporary folder and reads the copy, so the original is never opened by a database engine. A test in the code fails the build if any other parsing code uses a file-writing function.
- **Local-only.** Everything stays on your computer. There is no account, no telemetry, no analytics and no crash reporting. The app makes no network calls. It blocks every web request that is not for its own files, and the spellchecker (which would download dictionaries) is switched off.
- **One optional exception: the update check.** It is **off** by default. If you turn it on (Settings > Privacy > Check for updates), the app sends one request to GitHub Releases to see whether a newer version exists. Nothing about you or your runs is sent.
- **Secrets are masked on screen.** "Mask likely secrets" is **on** by default. Before any text reaches the window, the app replaces things that look like secrets with `••••` and a label, for example `sk-…••••[OpenAI key]`. It covers API keys and tokens from OpenAI, Anthropic, Google, GitHub, GitLab, Slack, Stripe, AWS, npm, Hugging Face, SendGrid, Twilio, xAI, Groq and others; bearer and basic auth headers; JWTs; private key blocks; `password=` and `secret=` style settings; and connection strings or URLs with a password in them. Masking only changes what you see; your files stay as they are. It works by recognising patterns, so it can miss an unusual secret. Take care when you share screenshots.
- **Sandboxed window.** The window runs in Chromium's sandbox with context isolation and no Node.js access. It cannot load anything from the internet, and it only gets runs in the app's own common format, never raw agent files.

More detail: [SECURITY.md](SECURITY.md) and section 3.4 of [the plan](docs/PLAN.md#34-privacy-and-security-model).

## Contents

- [Supported agents](#supported-agents)
- [What can't be monitored](#what-cant-be-monitored)
- [Install](#install)
- [First launch](#first-launch)
- [Connecting each agent](#connecting-each-agent)
- [Where each agent stores its sessions](#where-each-agent-stores-its-sessions)
- [Using the app](#using-the-app)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Build from source](#build-from-source)
- [Contributing](#contributing)
- [Licence](#licence)

## Supported agents

"Verified" means checked against a real installation. "Checked against source" means checked against the agent's published source code, but not against a real installation yet. "Experimental" means neither was possible (the agent is closed source and was not installed); expect gaps.

| Agent | Status | What it reads |
| --- | --- | --- |
| Claude Code (CLI, IDE extensions, desktop app) | Verified on a real install (Windows; macOS and Linux paths come from Claude Code's own code) | Session transcripts, sub-agents and workflow runs in `~/.claude/projects`, plus `~/.claude/sessions` for "waiting for approval" |
| Codex (CLI, `codex exec`, IDE extension, desktop app, ChatGPT's Codex) | Checked against source | Rollout files in `~/.codex/sessions` and `~/.codex/archived_sessions` |
| Gemini CLI | Checked against source | `~/.gemini/tmp/<project>/chats` |
| Qwen Code | Checked against source | `~/.qwen/projects/<project>/chats` |
| GitHub Copilot in VS Code (ask, edit and agent mode) | Checked against source (folder locations seen on a real Windows install) | VS Code's saved chat sessions (`workspaceStorage/*/chatSessions` and chats from windows with no folder) |
| GitHub Copilot CLI | Checked against source | `~/.copilot/session-state/<id>/events.jsonl` |
| Aider | Checked against source | `.aider.chat.history.md` in the project folders you choose, and in your home folder |
| Cursor | Experimental | Cursor's chat database (a temporary copy), cursor-agent CLI sessions and agent transcripts |
| Cline | Checked against source | Tasks in your editor's extension storage (VS Code, Insiders, VSCodium, Cursor, Windsurf) and Cline 4.x sessions in `~/.cline/data`. Never reads `secrets.json` |
| Roo Code | Checked against source | Tasks in your editor's extension storage |
| Continue | Checked against source | `~/.continue/sessions` |
| OpenCode | Checked against source | `~/.local/share/opencode`: its database (a temporary copy) and older JSON files |

The exact folders for each operating system are in [Where each agent stores its sessions](#where-each-agent-stores-its-sessions). The same information is shown in the app under Settings > Sources. Goose and Crush are the next agents planned; see [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-source-adapter) if you want to help.

## What can't be monitored

- **ChatGPT web and desktop apps.** Ordinary ChatGPT chats write no run data to your computer, so there is nothing to read. ChatGPT's coding agent is different: it is Codex, and Codex is supported (it writes its sessions to `~/.codex`).
- **Windsurf.** Its Cascade sessions are stored encrypted, so they can't be read. (Cline or Roo Code running *inside* Windsurf are supported.)
- **Cloud-only agents**, such as Codex cloud tasks, the Copilot coding agent on github.com, Devin and Jules. They run on someone else's computer and leave nothing on yours.
- **"Waiting for approval" is not always certain.** Only Claude Code and Copilot CLI record that they are waiting for you. For the other agents the app works it out from a tool call with no answer and a file that has gone quiet, so it can be wrong.
- **Exact times for every message.** Aider records only when a session started, and Continue keeps no per-message times. Their events are shown in order, without exact times.

## Install

Download the latest version from the [releases page](https://github.com/OWNER/agent-run-monitor/releases).

### Windows

Two choices:

- **Installer** (`agent-run-monitor-<version>-setup-x64.exe` for most PCs, or `-setup-arm64.exe` for Arm PCs). Double-click it. It asks no questions: it installs for your user account only, never asks for administrator rights, and is done in a few seconds. It installs into `%LOCALAPPDATA%\Programs\agent-run-monitor`, adds an **Agent Run Monitor** shortcut to the Start menu and the desktop, and starts the app when done. To remove the app, see [Uninstall](#uninstall).
- **Portable zip** (`agent-run-monitor-<version>-win-x64.zip`, or `-win-arm64.zip`). Right-click > Extract All, then run `Agent Run Monitor.exe` from the extracted folder. Nothing is installed, but your settings are still saved in `%APPDATA%\Agent Run Monitor` (see [Uninstall](#uninstall)).

**Windows may warn you.** Builds are not code-signed until the project has a signing certificate set up (see [docs/BLOCK-TEST.md](docs/BLOCK-TEST.md)).

- *SmartScreen* may say "Windows protected your PC". Click **More info**, then **Run anyway**.
- *Smart App Control*, if it is switched on, blocks unsigned apps and has no "run anyway" button. In that case wait for a signed release.

### macOS

Download the `.dmg` (`arm64` for Apple silicon Macs, `x64` for Intel Macs), open it and drag **Agent Run Monitor** to Applications.

The app is not signed or notarised yet, so macOS stops it the first time:

- Control-click (or right-click) the app in Applications, choose **Open**, then **Open** again.
- If that doesn't offer an Open button (macOS 15 and later), try to open the app once, then go to **System Settings > Privacy & Security**, scroll down and click **Open Anyway**.

### Linux

- **AppImage**: make it executable, then run it.

  ```sh
  chmod +x agent-run-monitor-<version>-linux-<arch>.AppImage
  ./agent-run-monitor-<version>-linux-<arch>.AppImage
  ```

  Some distributions need the FUSE 2 library for AppImages (on Ubuntu, the `libfuse2` package).

- **Debian or Ubuntu package**:

  ```sh
  sudo apt install ./agent-run-monitor-<version>-linux-<arch>.deb
  ```

## First launch

The first time you start the app, a short setup wizard opens. It has four steps:

1. **Welcome**, with the privacy promise.
2. **Find your agents.** The app checks the usual folder of every supported agent and shows what it found: the folder and how many runs are in it, or where the agent's folder would be if it isn't installed. You can switch any agent off, or add a folder if an agent keeps its sessions somewhere else. For Aider you add your project folders here.
3. **Look & feel**: pick a theme, choose whether to reduce motion, and whether you want the fun extras.
4. **Done.** Click **Open my latest run** and the app opens on your most recent run. With a large history the list keeps filling for a few seconds ("Reading runs…" in the status bar). If no runs were found, the button says **Start watching** and the list stays empty until an agent writes a session; see [My runs don't appear](#my-runs-dont-appear).

Use **Next** to go through the steps, or **Skip setup** to jump to the end.

![The "Find your agents" step of the setup wizard](docs/images/wizard-detect.png)

You can change all of this later in Settings (Ctrl+, or ⌘, on a Mac).

## Connecting each agent

For most agents there is nothing to do: if the agent is installed and has saved at least one session, the app finds it.

**A note on environment variables.** Some agents let you move their data with an environment variable (listed below). The app honours these, but only if it can see them. If you set one in your terminal profile only, the app may not see it when you start it from the Start menu, Dock or launcher. The simple fix is to add the folder by hand: Settings > Sources > the agent > **Add folder**.

### Claude Code

Nothing to do. Covers the CLI, the IDE extensions and the desktop app's Code tab. If you use `CLAUDE_CONFIG_DIR`, the app reads that folder too.

### Codex

Nothing to do. Covers the CLI, `codex exec`, the IDE extension, the desktop app and Codex inside ChatGPT. If you use `CODEX_HOME`, the app reads that folder instead of `~/.codex`.

### Gemini CLI

Nothing to do. If you use `GEMINI_CLI_HOME`, the app looks for `.gemini` inside that folder instead of your home folder.

### Qwen Code

Nothing to do. `QWEN_HOME` and `QWEN_RUNTIME_DIR` are honoured.

### GitHub Copilot in VS Code

Nothing to do. The app reads the chats that VS Code (and VS Code Insiders or VSCodium) saves. A portable VS Code is found through `VSCODE_PORTABLE`; otherwise add its `user-data/User` folder by hand. See also [VS Code Copilot chats](#vs-code-copilot-chats-dont-appear).

### GitHub Copilot CLI

Nothing to do. If you use `COPILOT_HOME`, the app reads that folder.

### Aider

Aider has no central folder. It writes `.aider.chat.history.md` into each project (in the git root, or the folder you started it in). So **tell the app where your projects are**: Settings > Sources > **Project folders** > Add project folder (or in the setup wizard). Add the folder that holds your projects, for example your `code` folder. The app searches it up to 4 levels deep and skips folders like `node_modules` and `.git`. The history file in your home folder is read automatically, and so is the file named by `AIDER_CHAT_HISTORY_FILE` if it is a full path.

### Cursor

Nothing to do. Support is experimental. The app reads a temporary copy of Cursor's chat database (databases over 2 GB are skipped), plus cursor-agent CLI sessions and agent transcripts in `~/.cursor`. If you run the app inside WSL, add the Windows-side folder (`/mnt/c/Users/<you>/AppData/Roaming/Cursor/User`) by hand.

### Cline

Nothing to do. The app looks in the extension storage of VS Code, VS Code Insiders, VSCodium, Cursor and Windsurf, and in `~/.cline/data` for Cline 4.x. `CLINE_DIR` and `CLINE_DATA_DIR` are honoured. Cline's `secrets.json` is never read.

### Roo Code

Nothing to do, unless you set Roo Code's own "custom storage path" setting. In that case add that folder by hand in Settings > Sources > Roo Code.

### Continue

Nothing to do. Covers the VS Code and JetBrains extensions and the `cn` CLI. If you use `CONTINUE_GLOBAL_DIR`, the app reads `sessions` inside that folder.

### OpenCode

Nothing to do. OpenCode uses the same folder layout on every system, Windows included. If you use `XDG_DATA_HOME`, the app looks for `opencode` inside it. A database named with `OPENCODE_DB` is read too.

## Where each agent stores its sessions

These are the places the app looks by default. `~` means your home folder. On Windows, `%USERPROFILE%` is your home folder (usually `C:\Users\<you>`) and `%APPDATA%` is `%USERPROFILE%\AppData\Roaming`.

| Agent | Windows | macOS | Linux | Moved by |
| --- | --- | --- | --- | --- |
| Claude Code | `%USERPROFILE%\.claude` | `~/.claude` (also `~/.config/claude`) | `~/.claude` (also `~/.config/claude`) | `CLAUDE_CONFIG_DIR`; on macOS and Linux `XDG_CONFIG_HOME` (for `~/.config/claude`) |
| Codex | `%USERPROFILE%\.codex` | `~/.codex` | `~/.codex` | `CODEX_HOME` |
| Gemini CLI | `%USERPROFILE%\.gemini` | `~/.gemini` (also `~/.cache/.gemini` for sandboxed runs) | `~/.gemini` | `GEMINI_CLI_HOME` |
| Qwen Code | `%USERPROFILE%\.qwen` | `~/.qwen` | `~/.qwen` | `QWEN_HOME`, `QWEN_RUNTIME_DIR` |
| Copilot in VS Code | `%APPDATA%\Code\User` | `~/Library/Application Support/Code/User` | `~/.config/Code/User` | `VSCODE_APPDATA`, `VSCODE_PORTABLE`; on Linux `XDG_CONFIG_HOME` |
| Copilot CLI | `%USERPROFILE%\.copilot\session-state` | `~/.copilot/session-state` | `~/.copilot/session-state` | `COPILOT_HOME`; `XDG_CONFIG_HOME` (unverified: the app also looks under it) |
| Aider | `.aider.chat.history.md` in each project, and `%USERPROFILE%` | the same, and `~` | the same, and `~` | `AIDER_CHAT_HISTORY_FILE` |
| Cursor | `%APPDATA%\Cursor\User` and `%USERPROFILE%\.cursor` | `~/Library/Application Support/Cursor/User` and `~/.cursor` | `~/.config/Cursor/User`, `~/.cursor` and `~/.config/cursor` | on Linux `XDG_CONFIG_HOME` |
| Cline | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev` and `%USERPROFILE%\.cline\data` | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev` and `~/.cline/data` | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev` and `~/.cline/data` | `CLINE_DIR`, `CLINE_DATA_DIR`, `CLINE_SESSION_DATA_DIR`, `VSCODE_PORTABLE`; on Linux `XDG_CONFIG_HOME` |
| Roo Code | `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline` | `~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline` | `~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline` | `VSCODE_PORTABLE`; on Linux `XDG_CONFIG_HOME`; Roo Code's custom storage path (add it by hand) |
| Continue | `%USERPROFILE%\.continue\sessions` | `~/.continue/sessions` | `~/.continue/sessions` | `CONTINUE_GLOBAL_DIR` |
| OpenCode | `%USERPROFILE%\.local\share\opencode` | `~/.local/share/opencode` | `~/.local/share/opencode` | `XDG_DATA_HOME`, `OPENCODE_DB` |

Notes:

- **VS Code variants.** For Copilot in VS Code, the app also looks in `Code - Insiders` and `VSCodium` in place of `Code`. For Cline and Roo Code it also looks in `Code - Insiders`, `VSCodium`, `Cursor` and `Windsurf`. On Linux it also checks the Flatpak VSCodium folder and the remote-server folders (`~/.vscode-server/data/User` and similar) for Cline and Roo Code, so it works when the app runs on the remote machine.
- **`XDG_CONFIG_HOME`.** If it is set, it replaces `~/.config` in the Linux paths above, and in Claude Code's `~/.config/claude` on macOS too.
- **`VSCODE_APPDATA`.** If it is set, Copilot in VS Code is looked for under it in place of the usual application data folder (`%APPDATA%`, `~/Library/Application Support` or `~/.config`).
- **The exact list for your computer** is in Settings > Sources, under "Where it looks", with a mark showing whether each folder exists.

## Using the app

![The main window: the run list on the left, a live Claude Code run on the right](docs/images/run-view-paper.png)

### The run list

The left side lists your runs, newest first.

- **Search** with the box at the top (press `/` to jump to it). Words that name an agent, a status or a time become filters. For example `codex failed yesterday` finds Codex runs that failed yesterday, and `weather stuck` finds stuck runs in a project called weather-api. Time words: `today`, `yesterday`, `last hour`, `this week`, `last week`.
- **Filter chips** under the search box filter by status and by agent. "Clear filters" resets them.
- **Sections.** *Pinned* runs stay at the top (pin with `p` or the pin button). *Recent* shows the last 5 runs you opened. Then *Today*, *Yesterday* and *Earlier*.
- **Statuses.** Every status has its own shape and a word, so colour is never the only signal.

| Status | Meaning |
| --- | --- |
| Running | The agent is working right now. |
| Waiting for you | The agent stopped to ask you something, such as approving a command. |
| Idle | The last turn finished recently; the session may continue. |
| Done | Finished and quiet for a while (3 minutes after a completed turn). |
| Failed | The last turn ended in an error, such as an API error or a crash. |
| Stuck | It looked busy, but nothing has happened for too long (for example 20 minutes of silence, or a shell command open for over 12 minutes). |
| Couldn't read this run | The file could not be understood. See [below](#a-run-shows-couldnt-read-this-run). |

### Run views

Each run has five views. Switch with the tabs or the keys `1` to `5`:

1. **Activity**: messages, reasoning steps, tool calls and their results, as they happen.
2. **Overview**: status, counts, project, branch, model, start time, duration, token use, and the source file with a "Reveal in folder" button.
3. **Files**: the files the run created, edited or deleted.
4. **Tools**: every tool call, with its result and how long it took.
5. **Timeline**: the run over time.

The default view is a setting (Settings > Runs & refresh).

Here is the same window in the dark Harbor theme:

![The run view in the dark Harbor theme](docs/images/run-view-harbor.png)

### Getting around

Use `←` and `→` (or `[` and `]`) to go to the previous or next run in the list. `Ctrl+K` (`⌘K` on a Mac) opens the **command palette**. It searches runs the same way as the search box and also runs commands, such as switching the theme, opening settings or turning low GPU mode on or off.

![The command palette searching for "codex failed"](docs/images/palette.png)

Press `?` at any time for the list of shortcuts (it is also linked from the status bar).

![The keyboard shortcuts sheet](docs/images/cheat-sheet.png)

| Keys | What they do |
| --- | --- |
| `←` or `[` | Previous run |
| `→` or `]` | Next run |
| `j` | Move list selection down |
| `k` | Move list selection up |
| `Enter` | Open selected run |
| `p` | Pin or unpin run |
| `/` | Search runs |
| `1` | Activity view |
| `2` | Overview |
| `3` | Files view |
| `4` | Tools view |
| `5` | Timeline view |
| `m` | Add or remove run from the multiviewer |
| `g` then `m` | Open the multiviewer |
| `f` | Maximise focused tile |
| `←` or `→` (in the multiviewer) | Focus the previous or next tile |
| `1` to `5` (in the multiviewer) | Switch the view of the focused tile |
| `PageUp` or `PageDown` | Previous or next page of tiles |
| `Ctrl+K` (`⌘K` on a Mac) | Command palette |
| `Ctrl+,` (`⌘,` on a Mac) | Settings |
| `?` | Keyboard shortcuts |
| `Esc` | Close overlays, restore tiles |

Shortcuts are ignored while you type in a text box.

### Multiviewer

The multiviewer shows several runs side by side, each updating live.

- **Choose runs** with `m`, the "Add to multiviewer" button, Ctrl-click (⌘-click on a Mac) or Shift-click in the list, or "Add runs" inside the multiviewer.
- **Open it** with `g` then `m`, the "Open multiviewer" button above the list, or the command palette.
- **Up to 12 tiles per page.** The grid follows the number of runs: 2 side by side, up to 4 in a 2 × 2 grid, up to 6 in 3 × 2, up to 9 in 3 × 3, up to 12 in 4 × 3. More runs go on further pages (`PageUp` / `PageDown`). You can lower the limit in Settings > Runs & refresh.
- **Each tile** has its own view tabs, a maximise button (`f`; `Esc` restores) and a remove button. Drag a tile by its handle to reorder (this also works with the keyboard).
- **Layouts.** "Save layout" stores the current set of runs under a name. Open it again from "Layouts".

![The multiviewer with 4 runs](docs/images/multiviewer-4.png)

![The multiviewer with 12 runs](docs/images/multiviewer-12.png)

### Settings

Open with `Ctrl+,` (`⌘,` on a Mac) or the gear button. Changes apply straight away.

- **Sources**: switch agents on or off, see where each one looks, add extra folders, add Aider project folders, and **Rescan**.
- **Runs & refresh**: how often live runs are checked (default every 2 seconds), how far back to show runs (default 2 weeks), the default run view and the tiles per multiviewer page.
- **Notifications**: a desktop notification when a run finishes, and when one fails or gets stuck.
- **Appearance**: six themes (Paper, Sage and Dawn are light; Dusk, Moss and Harbor are dark), text size, density and time format.
- **Motion & performance**: see below.
- **Fun**: see below.
- **Privacy**: secret masking and the update check.
- **System**: start the app when you sign in.

**Reduce motion and low GPU mode are two different settings.**

- **Reduce motion** is for comfort and accessibility. It stops movement such as spinning marks, sliding panels and rotating words; changes happen instantly. *Auto* (the default) follows your system's "reduce motion" setting.
- **Low GPU usage mode** is for speed and battery life. It keeps animations short and simple, turns off shadows and blur, never loops an animation, and refreshes live views less often (once a second, and every 3 seconds for tiles you are not looking at). What you see stays the same. *Auto* (the default) turns it on when the computer runs on battery.

You can use either, both or neither. When the window is minimised or hidden, all animation stops anyway.

![Settings: Motion & performance, and the Fun section](docs/images/settings-motion.png)

### The fun parts

Two small extras are on by default:

- **Synonyms instead of "Working".** A running run's label cycles through words like Cogitating, Percolating and Noodling. Screen readers always hear the real status, and failed or stuck runs always show plain words.
- **Totally fake progress bar.** Running runs get a progress bar with a wildly precise, completely made-up time left. It says "totally fake progress bar" right underneath, and it never appears on finished or failed runs.

Turn either off in Settings > Fun, or from the command palette (type "synonyms" or "fake").

## Troubleshooting

### My runs don't appear

Work through this list:

1. **Is the agent switched on?** Settings > Sources: the switch next to the agent must be on.
2. **Does its folder exist?** Under "Where it looks", each folder is marked **Found** or **Not there**. If you have just installed the agent or used it for the first time, click **Rescan** (top of Settings > Sources). The agent's run count, next to its name, is then up to date.
3. **Is the run older than the history window?** Settings > Runs & refresh > "How far back to show runs" is 2 weeks by default. Choose a longer time, or All. The window goes by when the agent last wrote to the session, not when it started.
4. **Does the agent save somewhere else?** If you moved its data with an environment variable such as `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `COPILOT_HOME`, `CONTINUE_GLOBAL_DIR` or `XDG_DATA_HOME`, the app may not see that variable. Add the folder by hand: Settings > Sources > the agent's card > "Your extra folders" > **Add folder**, and pick the folder in the file picker. Pick the agent's own data folder, the one that plays the part of the folder in [Where each agent stores its sessions](#where-each-agent-stores-its-sessions) (the folder the environment variable points to), not a single project or session folder inside it. For Claude Code that is the folder that contains `projects` (a moved `.claude`), or the `projects` folder itself; a folder inside `projects` finds nothing. When the folder is right, the agent's run count goes up and its runs appear in the list within a few seconds, without restarting the app.
5. **Aider?** Add the folders that hold your projects under Settings > Sources > **Project folders**. Aider writes its history inside each project, so the app can't find it otherwise. Projects more than 4 levels below the folder you add are not searched; add a folder closer to them.
6. **VS Code Copilot?** See [VS Code Copilot chats don't appear](#vs-code-copilot-chats-dont-appear).
7. **Permissions.** The app needs permission to read the folders. On macOS, if your projects are in Documents, Desktop or Downloads, macOS may ask whether the app may access that folder; allow it (or later in System Settings > Privacy & Security > Files and Folders). On Linux, check that the folders belong to your user.
8. **Give it a moment.** With a very large history, the first scan can take a few seconds. Runs appear as they are read.
9. **Still stuck?** [Open a bug report](https://github.com/OWNER/agent-run-monitor/issues/new?template=bug_report.yml). Say which agent and version, your operating system, and what Settings > Sources shows for that agent. **Never paste session contents or attach session files**: they can contain your code, file paths and secrets.

### VS Code Copilot chats don't appear

- The app can only show chats that VS Code has saved to disk. VS Code saves a chat once it has at least one message, and it writes in the background, so a brand-new chat can take a moment to show up.
- Chats from a VS Code window with no folder open are saved in a separate place. The app reads those too.
- If you use VS Code Insiders, VSCodium or a portable VS Code, check that its folder is listed under Copilot (VS Code) in Settings > Sources. If not, add it by hand.
- If VS Code closes in the middle of a reply, it saves that request as cancelled, so the run may show as idle or done.

### A run shows "Couldn't read this run"

![An unreadable run: a calm card with the reason and the file path](docs/images/unreadable.png)

This means the app found the file but could not understand it. The reason is shown on the card. Common causes:

- The agent was updated and changed how it saves sessions.
- The file is locked by another program or is only half written. The app keeps watching the file, so the run fixes itself if the file becomes readable.
- The file is damaged.

Nothing on disk was changed. The rest of the app keeps working.

If many runs from one agent show this after an update, please [report a changed format](https://github.com/OWNER/agent-run-monitor/issues/new?template=format_changed.yml). The form asks for the agent, its version and the message on the card. Describe only the *structure* (record types and field names, with every value replaced by a placeholder such as `<string>`). **Do not paste session contents or attach session files.**

### The app uses a lot of GPU or CPU

- Turn on **Low GPU usage mode** (Settings > Motion & performance > On). It cuts most of the drawing work and refreshes live views less often.
- In Settings > Runs & refresh, choose a slower refresh rate (5 or 10 seconds) and a shorter history window.
- Show fewer tiles in the multiviewer. Tiles you can't see already pause.
- Reduce motion also helps, because it stops all movement.

## Uninstall

Removing the app never touches your agents' session files. If you turned on Settings > System > **Start with the operating system**, turn it off first, so no startup entry is left behind for the removed app.

### Windows

**Installer version:**

1. Quit the app.
2. Open **Settings > Apps > Installed apps**, find **Agent Run Monitor** (listed with its version, for example "Agent Run Monitor 0.1.0"), click **⋯** > **Uninstall**, and confirm.
3. The uninstaller asks "Are you sure you want to uninstall Agent Run Monitor?". Click **OK**. It finishes in a few seconds, without asking for administrator rights.

This removes the program folder (`%LOCALAPPDATA%\Programs\agent-run-monitor`), the Start menu and desktop shortcuts, the app's entry in Installed apps, and the copy of the installer that the installer keeps in `%LOCALAPPDATA%\agent-run-monitor-updater`. One folder stays behind on purpose, so a reinstall keeps your settings: `%APPDATA%\Agent Run Monitor`, which holds your settings, saved layouts, window position and the window's cache. To remove everything, delete it too (paste the path into the File Explorer address bar).

**Portable zip:** delete the extracted folder, and `%APPDATA%\Agent Run Monitor` if you want your settings gone too.

### macOS

Quit the app and drag **Agent Run Monitor** from Applications to the Bin. Your settings are in `~/Library/Application Support/Agent Run Monitor`; delete that folder to remove them.

### Linux

Delete the AppImage, or remove the Debian package with `sudo apt remove agent-run-monitor`. Your settings are in `~/.config/Agent Run Monitor` (or under `XDG_CONFIG_HOME` if you set it); delete that folder to remove them.

Settings > About shows the exact path of your settings file.

## Build from source

You need [Node.js](https://nodejs.org/) 24 and Git.

```sh
git clone https://github.com/OWNER/agent-run-monitor.git
cd agent-run-monitor
npm ci
npx install-electron
npm run dev
```

- `npx install-electron` downloads Electron itself; `npm ci` does not run install scripts.
- `npm run dev` starts the app with hot reload. It reads your real agent session files, read-only.
- `npm run dev:web` runs only the user interface in your browser at http://localhost:5317, with made-up demo runs and nothing from your disk.
- `npm run dist` builds the installers for your operating system into `release/`. They are unsigned unless signing is set up (see `electron-builder.yml`).
- If Electron starts as plain Node and no window opens, your shell has `ELECTRON_RUN_AS_NODE` set. Unset it first.

The README pictures are made from the demo with `node scripts/make-screenshots.mjs` and `node scripts/make-gif.mjs`.

## Contributing

Bug reports, fixes and new agents are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains the setup, the tests, the privacy rules for contributors and how to add an agent. Report security problems privately, as described in [SECURITY.md](SECURITY.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md). What was tested before the release, and what could not be, is in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Licence

Agent Run Monitor is open source under the [MIT licence](LICENSE).

It includes a few components adapted from [React Bits](https://github.com/DavidHDev/react-bits) (only components from its free, public repository). Those files, in `src/renderer/src/vendor/react-bits/`, keep their own licence: MIT with the Commons Clause, which means they may not be sold or redistributed on their own. The full text, and the licences of every other package the app ships with, are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
