// Codex tool helpers: tool names and kinds, tool output decoding, error sniffing and apply_patch
// header parsing. Provenance (see records.ts header): checked against openai/codex source, not a
// real installation.

import type { ToolKind } from '@shared/schema';
import { countDiffLines, diffTexts, newFileDiff, type PatchFile } from '../../changes';
import { isObj, textOf, toolKind } from '../../events';

/** Codex-specific tool names that the shared classifier does not know. */
const CODEX_KINDS: Record<string, ToolKind> = {
  shell_command: 'run',
  write_stdin: 'run',
  unified_exec: 'run',
  view_image: 'read',
  tool_search: 'search',
  web_search: 'web',
  apply_patch: 'edit',
  spawn_agent: 'agent',
  send_input: 'agent',
};

/** MCP tools carry `namespace: "mcp__<server>"` (current) or a flattened `<server>__<tool>` name (older). */
export function toolName(name: unknown, namespace: unknown): string {
  const n = typeof name === 'string' && name ? name : 'tool';
  if (typeof namespace !== 'string' || !namespace) return n;
  return namespace.startsWith('mcp__') ? `${namespace}__${n}` : `${namespace}.${n}`;
}

/** The bare tool name, without an MCP namespace or `functions.` prefix. */
export function bareName(name: string): string {
  return name.replace(/^mcp__.+?__/, '').replace(/^functions\./, '');
}

export function codexKind(name: string): ToolKind {
  return CODEX_KINDS[bareName(name)] ?? toolKind(name);
}

/** function_call.arguments is a JSON string; fall back to the raw string. */
export function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Tool output is a string, or an array of content items ({type:"input_text",text} / images).
 * 2025-era `shell` output is itself JSON: {"output":"...","metadata":{"exit_code":n}} [UNVERIFIED].
 */
export function decodeOutput(raw: unknown): { text: string; exitCode?: number } {
  if (Array.isArray(raw)) {
    const parts = raw.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : isObj(c) && /image/.test(String(c.type)) ? '[image]' : ''));
    return { text: parts.filter(Boolean).join('\n') };
  }
  if (isObj(raw) && typeof raw.content === 'string') return { text: raw.content };
  const text = typeof raw === 'string' ? raw : textOf(raw);
  if (text.startsWith('{"output"')) {
    try {
      const o = JSON.parse(text) as { output?: unknown; metadata?: { exit_code?: unknown } };
      const exit = o.metadata?.exit_code;
      return { text: typeof o.output === 'string' ? o.output : text, exitCode: typeof exit === 'number' ? exit : undefined };
    } catch {
      /* not the JSON shell format after all */
    }
  }
  return { text };
}

/**
 * There is no persisted success flag on function_call_output [SRC], so errors are read from the text:
 * unified exec "Process exited with code N", classic "Exit code: N", interrupts, and MCP "err: ".
 */
export function looksLikeToolError(text: string): boolean {
  // Only the header Codex writes before "Output:" counts: the command's own output can say anything
  // (a log mentioning "Exit code: 1", a JSON file with "exit_code": 2, ...). The 2025 JSON shell
  // format's exit code is read by decodeOutput instead.
  const head = outputHeader(text);
  return (
    /^Process exited with code (?!0\b)-?\d+/m.test(head) ||
    /^Exit code: (?!0\b)-?\d+/m.test(head) ||
    /^(?:Wall time: [^\n]*\n)?aborted by user\b/.test(text) ||
    /^err: /.test(text)
  );
}

/** The exec header (Chunk ID / Wall time / exit code lines before "Output:"), else the first lines. */
function outputHeader(text: string): string {
  const i = text.search(/^Output:\r?$/m);
  return i >= 0 ? text.slice(0, i) : text.split('\n', 5).join('\n');
}

/** apply_patch failures that carry no exit code (verification errors, rejections). [SRC-INFER] */
export function looksLikePatchFailure(text: string): boolean {
  return /verification failed|failed to apply|patch rejected|^error:/im.test(text);
}

export { applyPatchFiles as patchFiles, type PatchFile } from '../../changes';

/**
 * patch_apply_end / FileChange `changes` map: absolute path -> {type:add|delete|update,
 * unified_diff? (update), content? (add, delete), move_path?}. [SRC]
 */
export function changeFiles(changes: unknown): PatchFile[] {
  if (!isObj(changes)) return [];
  const out: PatchFile[] = [];
  for (const [path, ch] of Object.entries(changes)) {
    const c = isObj(ch) ? ch : {};
    const type = c.type;
    const move = typeof c.move_path === 'string' && c.move_path ? c.move_path : undefined;
    const content = typeof c.content === 'string' ? c.content : undefined;
    const diff =
      typeof c.unified_diff === 'string'
        ? { diff: c.unified_diff.replace(/\r?\n$/, ''), ...countDiffLines(c.unified_diff) }
        : content !== undefined && type === 'add'
          ? newFileDiff(content)
          : content !== undefined && type === 'delete'
            ? diffTexts(content, '', 1)
            : undefined;
    if (move) {
      out.push({ path, op: 'delete', moved: true }, { path: move, op: 'create', diff });
    } else {
      out.push({ path, op: type === 'add' ? 'create' : type === 'delete' ? 'delete' : 'edit', diff });
    }
  }
  return out;
}

/** Patch header paths are relative to the turn's cwd; join them in the cwd's own separator style. */
export function resolveIn(cwd: string | undefined, p: string): string {
  if (!cwd || /^([a-zA-Z]:[\\/]|[\\/])/.test(p)) return p;
  const win = cwd.includes('\\') || /^[a-zA-Z]:/.test(cwd);
  const sep = win ? '\\' : '/';
  const rel = p.replace(/[\\/]+/g, sep).replace(/^\.[\\/]/, '');
  return cwd.replace(/[\\/]+$/, '') + sep + rel;
}
