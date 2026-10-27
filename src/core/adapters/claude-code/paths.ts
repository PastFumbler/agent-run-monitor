// Where Claude Code keeps its files, and what kind of run a path is.
//
// Root: `$CLAUDE_CONFIG_DIR`, else `<home>/.claude`, on every OS (the resolver in the v2.1.310
// bundle has no platform branch; Windows verified on a real install, macOS/Linux from that code).
// Community tools also scan the XDG `~/.config/claude` that one 1.0.x release reportedly used;
// that one is unverified and only listed off Windows.

import { basename, dirname, join, posix, win32 } from 'node:path';
import type { Env, SessionRef } from '../../adapter';

export type ClaudeRunKind = 'session' | 'subagent' | 'workflow' | 'workflow-agent';

export function defaultRoots(env: Env): string[] {
  const p = env.platform === 'win32' ? win32 : posix;
  const roots: string[] = [];
  const override = env.vars.CLAUDE_CONFIG_DIR?.trim();
  if (override) roots.push(override);
  roots.push(p.join(env.home, '.claude'));
  if (env.platform !== 'win32') {
    const xdg = env.vars.XDG_CONFIG_HOME?.trim() || p.join(env.home, '.config');
    roots.push(p.join(xdg, 'claude'));
  }
  const seen = new Set<string>();
  return roots
    .map((r) => r.normalize('NFC'))
    .filter((r) => {
      const key = env.platform === 'win32' ? r.toLowerCase() : r;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The kind of run, from discover()'s hint or, failing that, from the path layout. */
export function kindOf(ref: SessionRef): ClaudeRunKind {
  const k = ref.hint?.kind;
  if (k === 'session' || k === 'subagent' || k === 'workflow' || k === 'workflow-agent') return k;
  const name = basename(ref.path);
  const dir = dirname(ref.path);
  if (name === 'journal.jsonl' && basename(dir).startsWith('wf_')) return 'workflow';
  if (/^agent-.+\.jsonl$/.test(name)) return basename(dir).startsWith('wf_') ? 'workflow-agent' : 'subagent';
  return 'session';
}

/**
 * The parent run's file:
 *   <sid>/subagents/agent-x.jsonl              -> <sid>.jsonl
 *   <sid>/subagents/workflows/wf_x/journal.jsonl -> <sid>.jsonl
 *   <sid>/subagents/workflows/wf_x/agent-x.jsonl -> the journal next to it
 */
export function parentOf(ref: SessionRef, kind: ClaudeRunKind): string | undefined {
  if (ref.hint?.parent) return ref.hint.parent;
  const dir = dirname(ref.path);
  if (kind === 'subagent') return `${dirname(dir)}.jsonl`;
  if (kind === 'workflow') return `${dirname(dirname(dirname(dir)))}.jsonl`;
  if (kind === 'workflow-agent') return join(dir, 'journal.jsonl');
  return undefined;
}

/** `<root>` for a main session file at `<root>/projects/<enc>/<sid>.jsonl`. */
export function rootOfSession(path: string): string | undefined {
  const projects = dirname(dirname(path));
  return basename(projects) === 'projects' ? dirname(projects) : undefined;
}
