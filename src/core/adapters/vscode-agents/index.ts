// VS Code agent extensions: three adapters in one family.
//   cline      Cline: editor globalStorage/saoudrizwan.claude-dev tasks (up to 3.89) and
//              ~/.cline/data (4.x SDK sessions, and pre-4.0 CLI / JetBrains tasks)
//   roo-code   Roo Code: editor globalStorage/rooveterinaryinc.roo-cline tasks (Cline's 3.x layout)
//   continue   Continue: ~/.continue/sessions/<id>.json (CONTINUE_GLOBAL_DIR overrides)
// Editors searched: VS Code, Code - Insiders, VSCodium, Cursor, Windsurf.
//
// Provenance (research/vscode-agents.md, 2026-10-27): none of the three is installed on the
// development machine, so every format was checked against source only (cline/cline @ 775d039
// and tag v3.89.2, RooCodeInc/Roo-Code @ b867ec9, continuedev/continue @ 5522c6f). Fixtures are
// synthesized from those definitions. Confidence is therefore 'source' for all three; editor
// folder locations other than VS Code on Windows are best-effort.

import type { SourceAdapter } from '../../adapter';
import { parseClineSdk } from './cline-sdk';
import { parseContinue } from './continue';
import { isRelevantChange } from './common';
import { discoverContinue, discoverTaskAgent } from './discover';
import { clineRoots, continueRoots, rooRoots } from './paths';
import { parseTask } from './tasks';

export const clineAdapter: SourceAdapter = {
  id: 'cline',
  displayName: 'Cline',
  confidence: 'source',
  note:
    'Reads Cline tasks (tasks/<id>/ui_messages.json + api_conversation_history.json, up to 3.89) from each editor\'s globalStorage, and 4.x sessions from ~/.cline/data/sessions (CLINE_DIR, CLINE_DATA_DIR). Never reads secrets.json. Checked against Cline 3.89.2 and 4.1.26 source; no real install was available to verify.',
  defaultRoots: clineRoots,
  isRelevantChange,
  discover: (roots, ctx) => discoverTaskAgent('cline', roots, ctx),
  parse: (ref, prev) => (ref.hint?.kind === 'sdk' ? parseClineSdk(ref, prev) : parseTask('cline', ref, prev)),
};

export const rooCodeAdapter: SourceAdapter = {
  id: 'roo-code',
  displayName: 'Roo Code',
  confidence: 'source',
  note:
    'Reads Roo Code tasks (tasks/<id>/ui_messages.json + api_conversation_history.json + history_item.json) from each editor\'s globalStorage/rooveterinaryinc.roo-cline. A custom roo-cline.customStoragePath must be added as a custom path. Checked against Roo Code 3.53 source; no real install was available to verify.',
  defaultRoots: rooRoots,
  isRelevantChange,
  discover: (roots, ctx) => discoverTaskAgent('roo-code', roots, ctx),
  parse: (ref, prev) => parseTask('roo-code', ref, prev),
};

export const continueAdapter: SourceAdapter = {
  id: 'continue',
  displayName: 'Continue',
  confidence: 'source',
  note:
    'Reads Continue sessions (~/.continue/sessions/<id>.json, CONTINUE_GLOBAL_DIR overrides) written by the VS Code and JetBrains extensions and the cn CLI. Sessions keep no per-message times. Checked against Continue 1.3.40 source; no real install was available to verify.',
  defaultRoots: continueRoots,
  isRelevantChange,
  discover: (roots, ctx) => discoverContinue(roots, ctx),
  parse: (ref, prev) => parseContinue(ref, prev),
};

export const adapters: SourceAdapter[] = [clineAdapter, rooCodeAdapter, continueAdapter];
