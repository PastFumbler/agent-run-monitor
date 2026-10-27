// Claude Code source adapter.
//
// Provenance (research dated 2026-10-27):
// - Verified on a real Windows install: the folder layout, every record kind used here and the
//   workflow journal, surveyed across CLI 2.1.293 to 2.1.309 (8 sessions, 12 sub-agents,
//   57 workflow runs, 418 workflow-agent transcripts; keys and counts only, no content).
// - Checked against the code bundled in v2.1.310: the root (`$CLAUDE_CONFIG_DIR` or `~/.claude`,
//   no per-OS branch, so macOS/Linux paths come from code, not from a real machine), the
//   interrupt markers and the live registry values.
// - Unverified: the legacy `~/.config/claude` root, inline sidechain records in old main files,
//   `MultiEdit`, and the journal's `error`/`skipped` records.
// Status thresholds live in core/status.ts (ported from an earlier private monitor).

import type { ParseContext, ParseState, SessionRef, SourceAdapter } from '../../adapter';
import { discover } from './discover';
import { defaultRoots, kindOf, parentOf } from './paths';
import { parseTranscript } from './transcript';
import { parseWorkflow } from './workflow';

export const adapter: SourceAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  confidence: 'verified',
  note:
    'Reads ~/.claude/projects (or $CLAUDE_CONFIG_DIR): session transcripts, sub-agents and workflow runs, plus sessions/<pid>.json for tool-approval waits. Verified on Windows; macOS/Linux paths from the bundled code.',
  defaultRoots,
  discover,
  async parse(ref: SessionRef, prev: ParseState | undefined, _ctx: ParseContext): Promise<ParseState> {
    const kind = kindOf(ref);
    const parent = parentOf(ref, kind);
    if (kind === 'workflow') return parseWorkflow(ref, prev, parent);
    return parseTranscript(ref, prev, kind, parent);
  },
};

export const adapters: SourceAdapter[] = [adapter];
