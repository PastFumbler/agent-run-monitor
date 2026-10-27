# Verification

What was checked before the first release (0.1.0), how, and what could not be checked. Phase 8 of
[PLAN.md](PLAN.md) §9. All runs were on one Windows 11 laptop (20 logical processors, Intel
integrated graphics plus a discrete GPU the app did not use), with no administrator rights.
Unless a section says otherwise, the app only saw synthetic sessions (`ARM_HOME` pointed at a
temporary home), never real data.

## Automated tests

| Suite | Command | Result |
| --- | --- | --- |
| Typecheck (src, tests, e2e, e2e-electron, scripts) | `npm run typecheck` | clean |
| Unit tests (Vitest) | `npm test` | 32 files, 491 tests passed |
| Renderer end to end (Playwright, Chrome, fixture backend) | `npx playwright test` | 72 passed |
| Real Electron app (Playwright `_electron`) | `npm run test:electron` | 10 passed, 1 skipped (the live test below) |
| Live Claude Code run on a real profile (local only) | `ARM_REAL_CLAUDE=1 npm run test:electron` | passed |

CI runs the typecheck, unit tests, renderer e2e, build and an unpacked package on Windows, macOS and
Linux, the Electron e2e on Windows and Linux (under `xvfb-run`), and the secret scan over the full
history. The release workflow runs the typecheck and unit tests again before it packages anything.

Highlights of what the tests cover:

- **Adapters.** Each adapter has parser tests over its fixtures, including corrupt and unknown
  records: Claude Code 38, Codex 32, Gemini CLI and Qwen Code 41, Copilot 26, Aider 20, Cursor 25,
  Cline/Roo Code/Continue 42, OpenCode 32. A throwing adapter turns its run into "Couldn't read this
  run" without stopping the others. Only the Claude Code fixture comes from a real (anonymised)
  install; the others are synthesized from each tool's source code and say so in their folder.
- **Read-only.** `readonly.test.ts` (7 tests) checks that no adapter opens agent files for writing.
- **Contrast.** `contrast.test.ts` (26 tests): for each of the 6 themes, text at least 4.5:1, UI
  at least 3:1, and every pair of status colours at least ΔE2000 15 apart. A failing theme fails CI.
- **Masking.** 21 unit tests, plus an Electron test that plants 8 kinds of secret (OpenAI, Anthropic,
  GitHub, AWS, a postgres URL password, a connection-string password, a Bearer token, a PEM private
  key): with masking on, 0 leaks in Activity, Overview, Tools, Files, Timeline, the command palette and
  the raw IPC payloads; with masking off, all of them show.
- **Navigation and multiviewer** (real app): ← / →, Ctrl+K and `?`; grids for 1-12 tiles (1x1, 2x1,
  2x2, 2x2, 3x2, 3x2, 3x3 ×3, 4x3 ×3); 13 tiles page to "Page 2 of 2"; all 5 views inside a tile;
  maximise and Esc; low-GPU badges on unfocused tiles.
- **Low-GPU pushes** (real app, `watch-priority.spec.ts`): with 4 live tiles, in 9 s the focused tile
  got 9 detail pushes and each unfocused tile 3, never closer than 3 s apart, all in one
  `runDetails` message per flush.
- **Hidden window** (real app): minimised, updates reach the window at most once per 5 s (measured
  gaps 5001-5013 ms) and `data-hidden` stops every animation; restoring resumes at once.
- **Reduced motion** (real app): 0 running infinite animations with the OS switch on Auto, and with
  the setting On; the control without either animates.
- **Status words.** The rotating synonyms are `aria-hidden` and the live region reads the real status;
  failed runs switch to plain words at once; the fake progress bar shows only while running. A wait
  inferred from a quiet open tool call reads "Probably waiting for you".
- **Notifications and start with the OS** (unit tests): which outcome follows which setting, sub-runs
  skipped, the 20 s per-run cooldown, notice text without the run's title; the Linux autostart
  `.desktop` file (contents, `XDG_CONFIG_HOME`, removal, quoting).

## Live Claude Code run (real profile, counts only)

The local-only Electron test points the app at the real home, completes the first-run wizard and
follows a session file that is being written. It prints counts and statuses only, never titles,
paths or content. On the test machine: 553 runs listed, all Claude Code; the live run stayed
`running` and its event count rose by 21 over 80 s; sub-runs and "Part of" links matched the
files. The test now prefers a top-level session over a sub-agent transcript and records whether
the run was ever seen idle.

## GPU and CPU

Measured with `scripts/measure-gpu.mjs`: the same Windows `GPU Engine` counters Task Manager reads,
sampled once a second for the app's process tree, with 12 synthetic sessions being written all the
time. The app rendered on the integrated GPU. **The machine was not quiet**: another session ran
5-10 headless browsers during most conditions, so treat the numbers as indicative.

| Condition | GPU (busiest engine, mean) | CPU, % of one core | Run-detail pushes/s |
| --- | --- | --- | --- |
| 12 tiles, low GPU off | 31.4% | 175 | 12.8 |
| 12 tiles, low GPU on | 4.9% | 47-75 | 4.7 |
| Minimised (12 tiles) | 0.01% | | batched every 5 s |
| One run open, low GPU off | 9.8-10.0% | 34-43 | 1.1-1.2 |

Before the last round of fixes the same conditions measured 52.8% (12 tiles, low GPU off) and 21.7%
(one run open, which ran an infinite animation on every running row of the list), and main sent
10.5 run details a second in low-GPU mode. Now only the open run's row animates, and in low-GPU mode
main sends the unfocused tiles' details at most every 3 s.

## Install and uninstall (Windows)

- **Following the README as a stranger**: the x64 installer ran with no questions and no UAC prompt,
  installed into `%LOCALAPPDATA%\Programs\agent-run-monitor`, added Start menu and desktop shortcuts
  and started the app. The wizard found the installed agent and its runs. Four README steps that were
  wrong or unclear were fixed.
- **Uninstall** removes the program folder, the shortcuts, the Installed apps entry and the
  installer copy in `%LOCALAPPDATA%\agent-run-monitor-updater`; an update install keeps that copy.
  Settings in `%APPDATA%\Agent Run Monitor` stay on purpose.
- **Only per-architecture installers** are built (x64 and arm64), so every published installer is
  one the Smart App Control check audits.

## Smart App Control

`scripts/check-blocks.ps1` (static audit) and `scripts/runtime-modules.mjs --strict` (runtime pass)
are described in [BLOCK-TEST.md](BLOCK-TEST.md). On an unsigned local build:

- x64: 144 files checked. Ours: 34, unsigned (no certificate configured), 2 of them `.lnk` shortcuts
  that cannot be signed. The only third-party file we ship, `d3dcompiler_47.dll`, carries a valid
  Microsoft signature. The rest are Windows files, all valid.
- `app.asar` holds 17 files and no executables (only the main process's own dependency is packed;
  the UI is bundled).
- Runtime pass: 7 of 7 steps (wizard, run list, each run view, multiviewer, settings), 4 processes,
  112 modules, no executable files created; every runtime-only module first loaded at launch.
- The "fail when signing is configured and our file is unsigned" path was proven with a self-signed
  certificate (fails unsigned, passes signed, a tampered file reports a hash mismatch).

## Not verified

- **Smart App Control enforcement.** SAC is off on the test machine, so no real allow/block decision
  was observed. Needs a trusted signature and a machine (or VM) with SAC on.
- **SmartScreen** on a downloaded installer (Mark of the Web), and the Settings > Apps flyout wording.
- **A truly fresh Windows user profile.** Simulated with empty `ARM_HOME` / `ARM_USER_DATA` folders.
- **macOS and Linux installers** (dmg, AppImage, deb): built in CI only, never installed.
- **Other agents on real data.** Only Claude Code was installed. Codex, Gemini CLI, Qwen Code,
  Copilot, Aider, Cursor, Cline, Roo Code, Continue and OpenCode are checked against their source
  code (Cursor against neither, so it is marked experimental).
- **Notifications and start with the OS end to end.** The rules and the Linux autostart file are
  unit-tested; the Windows Run key and the macOS login item (both through Electron) are not.
- **The arm64 build at run time** (no Windows on Arm machine).
- **CI and the release workflow on GitHub** until the repository is pushed.
