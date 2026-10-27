# Changelog

All notable changes to Agent Run Monitor are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Run folders**: create, rename and delete folders in Settings > Folders. They are kept in the app's own settings, never in agent files; deleting a folder returns its runs to Unfiled.
- **All runs**: a full-width list of every run grouped by start time (Today, Yesterday, This week, Earlier this month, then by month), with checkboxes, Shift-click ranges and Move to folder. Each run shows its folder. Open it from the sidebar, the command palette or `g` then `a`.
- **Dashboard**: the app now opens on a home screen with a section for every status, each listing its 3 most recent runs and a "See all (n)" link to All runs filtered to that status. Agent chips filter every section, and clicking a run opens it. Reach it from the sidebar, the command palette or `g` then `d`.
- **Token usage, code changes and reasoning in the run data**: every adapter now reports input, output and prompt-cache tokens separately (per message and per day where the agent records them, "not reported" where it does not, never estimated), each applied edit with its line counts and diff, and whether a run has readable reasoning. Overview shows the token split.

## [0.1.0] - Not released yet

The first public release.

### Added

- **Runs from every agent in one window.** The app watches the session files coding agents write to disk and shows each session as a run: what it is doing now, what it did, which files it touched, and whether it finished, failed, is waiting for you or is stuck.
- **Source adapters** for:
  - Claude Code (CLI, IDE extensions and Desktop), including sub-agents and workflow runs, and live "waiting for approval" from its session registry. Verified on a real install.
  - OpenAI Codex (CLI, `codex exec`, IDE extension and desktop app), including compressed `.jsonl.zst` rollouts, archived sessions and sub-agent threads.
  - Gemini CLI and Qwen Code.
  - GitHub Copilot agent mode in VS Code (also VS Code Insiders and VSCodium) and the Copilot CLI.
  - Aider, from the chat history in the project folders you choose.
  - Cursor (experimental: closed source and not checked against a real install).
  - Cline, Roo Code and Continue.
  - OpenCode, across its SQLite and older JSON storage generations.
- **Status for every run**: running, waiting, idle, done, failed, stuck or unreadable, each with its own shape and plain words, never colour alone. Quiet and stuck runs are detected from silence and long-open tool calls, and re-judged every few seconds without new writes.
- **Run view** with Activity, Overview, Files, Tools and Timeline views.
- **Run list** with search, agent and status filters, pinned runs, and runs grouped by day.
- **Multiviewer**: watch up to 12 runs side by side in a grid, with per-tile views, maximise, drag to reorder and saved layouts.
- **Keyboard navigation** throughout, a command palette (`Ctrl+K`) that understands searches like "codex failed yesterday", and a cheat sheet (`?`).
- **First-run wizard** that finds installed agents by itself, shows where each one keeps its sessions, and lets you add custom folders.
- **Settings** for sources and custom paths, refresh rate, notifications on finish and failure, history window, theme, text size, density, time format and start with the OS.
- **Six soft themes**, three light (Paper, Sage, Dawn) and three dark (Dusk, Moss, Harbor), each checked automatically for text and UI contrast.
- **Comfortable to leave open**: a reduced-motion setting that follows the OS, a low-GPU mode that turns on by itself when the computer runs on battery, and no animation at all while the window is hidden.
- **Fun parts**, both optional: rotating synonyms for "running" and a totally fake progress bar.
- **Notifications** when a run finishes or fails.
- **Optional update check**, off by default: one request to this project's GitHub Releases page.
- **Installers** for Windows (per-user NSIS, no administrator rights needed, one installer each for x64 and Arm64, plus portable zips), macOS (DMG) and Linux (AppImage and deb).

### Security

- Read-only access to agent files. SQLite databases are read from a temporary copy or from memory, never opened in place.
- Local-only: a network guard blocks every request except the opt-in update check; no telemetry, analytics or crash reporting.
- Sandboxed renderer with context isolation, no Node.js integration, a strict Content Security Policy, blocked navigation and pop-ups, and every web permission denied.
- Likely secrets (API keys, tokens, passwords, private keys, connection strings) are masked on screen by default.
- A secret scan (`npm run scan-secrets`) checks the tree and full history for keys and personal paths before publishing.

### Verification

- What was tested for this release, the GPU and CPU numbers, and what could not be verified (Smart App Control enforcement, macOS and Linux installs, agents other than Claude Code on real data) are in [docs/VERIFICATION.md](docs/VERIFICATION.md).

[Unreleased]: https://github.com/PastFumbler/agent-run-monitor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/PastFumbler/agent-run-monitor/releases/tag/v0.1.0
