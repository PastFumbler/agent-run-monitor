// Per-agent facts the renderer needs without importing the adapters (which use Node APIs).
// src/shared/agents.test.ts checks this against every adapter's own `confidence`, so they can't drift.

import type { AgentId, SourceStatus } from './schema';

export type AgentConfidence = SourceStatus['confidence'];

/**
 * How well each agent's format is known (see SourceStatus.confidence): 'verified' = checked against
 * a real installation; 'source' = checked against the tool's source code; 'best-effort' = neither.
 */
export const AGENT_CONFIDENCE: Record<AgentId, AgentConfidence> = {
  'claude-code': 'verified',
  codex: 'source',
  'gemini-cli': 'source',
  'qwen-code': 'source',
  'copilot-vscode': 'source',
  'copilot-cli': 'source',
  aider: 'source',
  cursor: 'best-effort',
  cline: 'source',
  'roo-code': 'source',
  opencode: 'source',
  continue: 'source',
};
