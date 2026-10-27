// The adapters the app ships with. Each module under ./adapters exports `adapters` (every agent it
// covers) and/or `adapter` (its single agent). Add new ones to MODULES.
//
// TODO(adapters): import these once they land, then delete them from this list:
//   ./adapters/vscode-agents  -> adapters: [cline, roo-code, continue]
//   ./adapters/opencode       -> adapter                              (opencode)

import type { SourceAdapter } from './adapter';
import * as aider from './adapters/aider';
import * as claudeCode from './adapters/claude-code';
import * as codex from './adapters/codex';
import * as copilot from './adapters/copilot';
import * as cursor from './adapters/cursor';
import * as gemini from './adapters/gemini';

type AdapterModule = { adapter?: SourceAdapter; adapters?: readonly SourceAdapter[] };

const MODULES: AdapterModule[] = [claudeCode, codex, gemini, copilot, aider, cursor];

/** Every shipped adapter, flattened. createRegistry() drops malformed or duplicate entries. */
export const ALL_ADAPTERS: SourceAdapter[] = MODULES.flatMap((m) => (m.adapters ? [...m.adapters] : m.adapter ? [m.adapter] : []));
