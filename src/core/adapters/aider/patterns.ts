// The line grammar of .aider.chat.history.md, from aider/io.py and friends (aider main 5dc9490,
// v0.86.x; core prefixes unchanged since v0.10). Key on prefixes, not exact suffixes.

/** Session start; written by InputOutput.__init__ in local time with no time zone. */
export const HEADER = /^# aider chat started at (\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\s*$/;
export const HEADER_PREFIX = Buffer.from('# aider chat started at ');
/** User input: one "#### " line per input line (io.user_input). */
export const USER = /^####(?: (.*))?$/;
/** Tool output / errors / approvals: "> text" plus a Markdown hard break ("  "). */
export const TOOL = /^>(?: (.*))?$/;
export const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
export const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

export const ARGV_AIDER = /aider/i;
export const ARGV_MODEL = /(?:^|\s)--model[=\s]+(\S+)/;
export const VERSION = /^Aider v(\S+)/;
export const MODEL = /^(?:Main model|Model): (\S+)(?: (?:with|using) (\S+) edit format)?/;
export const GIT_DIR = /^Git working dir: (.+)$/;
export const TOKENS =
  /^Tokens: ([\d.,]+k?) sent(?:, ([\d.,]+k?) cache write)?(?:, ([\d.,]+k?) cache hit)?, ([\d.,]+k?) received\./;
export const APPLIED = /^Applied edit to (.+?)\s*$/;
export const DID_NOT_APPLY = /^Did not apply edit to (.+?)(?: \(--dry-run\))?\s*$/;
export const COMMIT = /^Commit ([0-9a-f]{7,40}) (.*)$/;
export const RUNNING = /^Running (.+)$/;
export const ADDED_OUTPUT = /^Added \d+ lines? of output to the chat/;
export const RETRY = /^Retrying in [\d.]+ seconds/;
export const CTRL_C_ONCE = /^\^C again to exit/;
export const CTRL_C_EXIT = /^\^C KeyboardInterrupt/;

/**
 * confirm_ask's history line, written only after the user answers:
 * "Add file to the chat? (Y)es/(N)o/(D)on't ask again [Yes]: y" (current), "...? y" (v0.50),
 * "...? yes" (v0.30).
 */
export const CONFIRM_FULL = /^(.+?\?) (?:\(Y\)es[^[]*)?\[[^\]]*\]:\s*([a-z']+)$/i;
export const CONFIRM_OLD = /^(.+?\?) (y|n|yes|no)$/i;

/** Errors that end the turn (API, limits, crash tracebacks). */
export const TURN_ERRORS = [
  /^litellm\.\w+/,
  /^The API provider\b/,
  /has hit a token limit!/,
  /possibly exhausted context window/,
  /^Empty response received from LLM/,
  /^Only \d+ reflections allowed/,
  /^Traceback \(most recent call last\)/,
];
/** Edit failures: Aider reflects them back to the model, so the turn carries on. */
export const EDIT_ERRORS = [
  /did not conform to the edit format/,
  /SEARCH\/REPLACE blocks? failed to match/,
  /^Exception while updating files/,
];
/** Errors worth flagging that neither end the turn nor trigger a reflection. */
export const OTHER_ERRORS = [/^Unable to (commit|add|complete undo)/, /^Failed to generate commit message/];

/** Approvals after which Aider sends another message to the model (a "reflection"). */
export const REFLECTING_CONFIRMS = /^(Add file to the chat|Add URL to the chat|Attempt to fix (lint|test) errors|Edit the files|Try to proceed anyway)\?/i;
export const SHELL_OUTPUT_CONFIRM = /^Add (?:[\d.]+k tokens of )?command output to the chat\?/i;

/** Streamed reasoning, written verbatim inside the assistant text since v0.76. */
export const REASONING =
  /^<(thinking-content-[0-9a-f]+|think|reasoning)>\s*([\s\S]*?)\s*<\/(?:thinking-content-[0-9a-f]+|think|reasoning)>\s*/;

// Edit blocks inside assistant text, by edit format (aider/coders/*).
export const SEARCH = /^<{5,9} SEARCH>?\s*$/;
export const DIVIDER = /^={5,9}\s*$/;
export const UDIFF_OLD = /^--- (.+)$/;
export const UDIFF_NEW = /^\+\+\+ (.+)$/;
export const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

/** "3.1k" -> 3100, "1,234" -> 1234 (Aider's format_tokens is lossy above 1000). */
export function tokenCount(s: string | undefined): number {
  if (!s) return 0;
  const k = s.endsWith('k');
  const n = parseFloat(s.replace(/,/g, '').replace(/k$/, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(k ? n * 1000 : n);
}

/** The header's local time as epoch ms (the file records no time zone). */
export function headerTime(line: string): number | undefined {
  const m = HEADER.exec(line);
  if (!m) return undefined;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isNaN(t) ? undefined : t;
}
