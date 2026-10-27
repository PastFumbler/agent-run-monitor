// GitHub Copilot: two adapters in one family.
//   copilot-vscode  Copilot Chat sessions in VS Code (Code, Code - Insiders, VSCodium)
//   copilot-cli     the standalone Copilot CLI session store (~/.copilot or COPILOT_HOME)
// Formats were read from shipped code, not from real sessions; see the headers of vscode.ts and cli.ts.

import type { SourceAdapter } from '../../adapter';
import { cliRoots, discoverCli, parseCli } from './cli';
import { discoverVscode, parseVscode, vscodeRoots } from './vscode';

export const copilotVscodeAdapter: SourceAdapter = {
  id: 'copilot-vscode',
  displayName: 'Copilot (VS Code)',
  confidence: 'source',
  note:
    'Reads VS Code chat sessions (workspaceStorage/*/chatSessions and empty-window chats), both the .jsonl change log and older .json files. Format checked against VS Code 1.143 and Copilot Chat 0.71 code; no real session was available to verify.',
  defaultRoots: vscodeRoots,
  discover: (roots, ctx) => discoverVscode(roots, ctx),
  parse: (ref, prev) => parseVscode(ref, prev),
};

export const copilotCliAdapter: SourceAdapter = {
  id: 'copilot-cli',
  displayName: 'Copilot CLI',
  confidence: 'source',
  note:
    'Reads Copilot CLI transcripts (session-state/<id>/events.jsonl under COPILOT_HOME or ~/.copilot) plus workspace.yaml titles. Format checked against the @github/copilot 1.0.73 code; no real session was available to verify.',
  defaultRoots: cliRoots,
  discover: (roots, ctx) => discoverCli(roots, ctx),
  parse: (ref, prev) => parseCli(ref, prev),
};

export const adapters: SourceAdapter[] = [copilotVscodeAdapter, copilotCliAdapter];
