# Security policy

Agent Run Monitor reads files that can contain private source code, command output and secrets. We take reports about anything that could expose that data, or let a file or web page make the app do something it should not, seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's private vulnerability reporting:

1. Go to https://github.com/OWNER/agent-run-monitor/security/advisories/new
   (or open the repository's **Security** tab and choose **Report a vulnerability**).
2. Describe the problem, the version of the app and your OS, and the steps to reproduce it.
3. If a session file is needed to trigger the problem, build a minimal **synthetic** one by hand. Do not send real session files; they may contain your code and secrets.

Only the maintainers can see the report. We aim to acknowledge it within 7 days, agree on a fix and a disclosure date with you, and credit you in the advisory and the changelog unless you prefer otherwise.

Please also report privately if you find real personal data (a real session, a username, a private path or a key) anywhere in the repository or its history.

## Supported versions

This is a young project. Security fixes go into the latest release only. Please check that a problem still exists in the latest release before reporting it.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## Security model

What the app is designed to guarantee, so you can tell what counts as a vulnerability.

**Read-only.** The app only lists, stats and reads agent session files. Adapters never write, rename, delete, create folders, change permissions or create lock files on agent paths, and they close every file handle after reading. SQLite databases (Cursor, OpenCode) are never opened by a SQLite engine in place: they are copied (with their write-ahead log) into the app's temporary folder and read there, or read as bytes into memory, so no `-shm` or `-wal` file is ever created next to the original. Files that hold agent credentials are not read.

**Local-only.** The app has no server, no account, no telemetry, no analytics and no crash reporter.

- The main process installs a network guard on the window's session that cancels every request that is not for the app's own local files. The window uses a direct connection with no proxy auto-discovery.
- The spellchecker, which would download dictionaries, is turned off. Fonts and icons are bundled.
- The **only** network call is the optional update check, which is **off by default**. When you turn it on, the main process makes a single GET request, without cookies or credentials, to the GitHub Releases API for this project, from a separate session that allows only that one URL while the request runs. It sends nothing about you or your runs.
- Links are opened in your browser only if they point at this project's GitHub pages. Every other navigation, pop-up and redirect is blocked.

**Sandboxed renderer.** The window runs with context isolation, the Chromium sandbox, no Node.js integration (including workers and sub-frames), no `<webview>` tags and web security on. The renderer reaches the backend only through a small typed API exposed by the preload script, and the main process accepts IPC calls only from the app's own pages. The renderer never sees raw agent files, only the common run format.

**Content Security Policy.** Packaged builds use a strict CSP: `default-src 'self'`, `script-src 'self'` (no inline or remote scripts), `connect-src 'self'`, `object-src 'none'`, `frame-src 'none'`, `base-uri 'none'` and `form-action 'none'`. Only the app's own files are served; a `file:` URL outside the app's folder returns 404, so session content cannot load local files as images or scripts.

**Permissions.** Every web permission (camera, microphone, location, notifications from web content, device access, screen capture) is denied. The single exception is writing text to the clipboard when you click a "copy" button.

**Secret masking.** With "Mask likely secrets" on (the default), text from session files passes through a masking step in the main process before it reaches the window. It covers common provider API keys, bearer and basic auth headers, JWTs, private key blocks, `password=` style assignments and connection strings with embedded passwords. Masking is a convenience that reduces accidental exposure on screen, for example while screen sharing. It is pattern based and cannot catch every secret, so a secret it misses is a bug worth reporting but not a breach of the read-only or local-only guarantees.

**No child processes, no native modules.** The app starts no other programs and loads no native `.node` modules.

## What we consider a vulnerability

Examples:

- any way for a session file, or anything inside it, to run code, load remote content, make a network request, or escape the renderer sandbox;
- the app writing to, locking or otherwise changing agent files or folders;
- a network request made without the update check turned on, or to any other destination;
- the update check sending anything beyond the single request described above;
- secrets that should be masked by the documented patterns showing unmasked;
- crashes or hangs caused by crafted session files that stop the app from working (a single run showing "couldn't read this run" is expected behaviour, not a vulnerability).

Out of scope: attacks that already require control of your user account or the app's install folder, and the contents of agent session files themselves (the agents write those, not us).
