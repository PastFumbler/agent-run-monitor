// Run search used by the command palette and the sidebar search box.
// A query is split into words. Words that name an agent, a status or a time ("today", "yesterday",
// "last hour", "this week") become filters; everything else must appear in the run's title,
// project, branch, model or agent name. So "codex failed yesterday" finds Codex runs that failed
// and were last updated yesterday, and "weather stuck" finds stuck runs in weather-api.

import { AGENT_IDS, AGENT_NAMES, RUN_STATUSES, STATUS_LABELS, type AgentId, type RunStatus, type RunSummary } from '@shared/schema';
import { startOfDay, TIME } from '../../lib/time';

export type TimeWord = 'today' | 'yesterday' | 'last-hour' | 'this-week' | 'last-week';

export interface ParsedQuery {
  agents: AgentId[];
  statuses: RunStatus[];
  times: TimeWord[];
  words: string[];
}

const STATUS_WORDS: Record<string, RunStatus> = {
  running: 'running',
  active: 'running',
  working: 'running',
  live: 'running',
  waiting: 'waiting',
  approval: 'waiting',
  blocked: 'waiting',
  idle: 'idle',
  done: 'done',
  finished: 'done',
  complete: 'done',
  completed: 'done',
  failed: 'failed',
  fail: 'failed',
  failing: 'failed',
  error: 'failed',
  errored: 'failed',
  errors: 'failed',
  stuck: 'stuck',
  hung: 'stuck',
  stalled: 'stuck',
  unreadable: 'unreadable',
  corrupt: 'unreadable',
  broken: 'unreadable',
};

/** Single words that name an agent. Multi-word names are matched as phrases first. */
const AGENT_WORDS: Record<string, AgentId[]> = {
  claude: ['claude-code'],
  'claude-code': ['claude-code'],
  claudecode: ['claude-code'],
  codex: ['codex'],
  gemini: ['gemini-cli'],
  'gemini-cli': ['gemini-cli'],
  qwen: ['qwen-code'],
  'qwen-code': ['qwen-code'],
  copilot: ['copilot-vscode', 'copilot-cli'],
  'copilot-vscode': ['copilot-vscode'],
  'copilot-cli': ['copilot-cli'],
  aider: ['aider'],
  cursor: ['cursor'],
  cline: ['cline'],
  roo: ['roo-code'],
  'roo-code': ['roo-code'],
  opencode: ['opencode'],
  continue: ['continue'],
};

const PHRASES: [RegExp, (q: ParsedQuery) => void][] = [
  [/\blast hour\b/g, (q) => q.times.push('last-hour')],
  [/\bpast hour\b/g, (q) => q.times.push('last-hour')],
  [/\bthis week\b/g, (q) => q.times.push('this-week')],
  [/\blast week\b/g, (q) => q.times.push('last-week')],
  [/\bclaude code\b/g, (q) => q.agents.push('claude-code')],
  [/\bgemini cli\b/g, (q) => q.agents.push('gemini-cli')],
  [/\bqwen code\b/g, (q) => q.agents.push('qwen-code')],
  [/\bcopilot cli\b/g, (q) => q.agents.push('copilot-cli')],
  [/\bcopilot (?:vs ?code|vscode)\b/g, (q) => q.agents.push('copilot-vscode')],
  [/\broo code\b/g, (q) => q.agents.push('roo-code')],
  [/\bwaiting for you\b/g, (q) => q.statuses.push('waiting')],
  [/\bcouldn'?t read\b/g, (q) => q.statuses.push('unreadable')],
];

export function parseQuery(input: string): ParsedQuery {
  const q: ParsedQuery = { agents: [], statuses: [], times: [], words: [] };
  let rest = ` ${input.toLowerCase().trim()} `;
  for (const [re, apply] of PHRASES) {
    rest = rest.replace(re, () => {
      apply(q);
      return ' ';
    });
  }
  for (const raw of rest.split(/\s+/)) {
    const w = raw.replace(/^[^\w-]+|[^\w-]+$/g, '');
    if (!w) continue;
    if (w === 'today') q.times.push('today');
    else if (w === 'yesterday') q.times.push('yesterday');
    else if (STATUS_WORDS[w]) q.statuses.push(STATUS_WORDS[w]);
    else if (AGENT_WORDS[w]) q.agents.push(...AGENT_WORDS[w]);
    else q.words.push(w);
  }
  q.agents = [...new Set(q.agents)];
  q.statuses = [...new Set(q.statuses)];
  q.times = [...new Set(q.times)];
  return q;
}

export function isEmptyQuery(q: ParsedQuery): boolean {
  return !q.agents.length && !q.statuses.length && !q.times.length && !q.words.length;
}

function inTime(ts: number, t: TimeWord, now: number): boolean {
  const today = startOfDay(now);
  switch (t) {
    case 'today':
      return ts >= today;
    case 'yesterday':
      return ts >= today - TIME.DAY && ts < today;
    case 'last-hour':
      return ts >= now - TIME.HOUR;
    case 'this-week': {
      const d = new Date(today);
      const monday = today - ((d.getDay() + 6) % 7) * TIME.DAY;
      return ts >= monday;
    }
    case 'last-week': {
      const d = new Date(today);
      const monday = today - ((d.getDay() + 6) % 7) * TIME.DAY;
      return ts >= monday - 7 * TIME.DAY && ts < monday;
    }
  }
}

export function haystack(r: RunSummary): string {
  return [r.title || 'untitled run', r.projectName, r.gitBranch, r.model, AGENT_NAMES[r.agent], r.agent, r.projectPath]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function matchRun(r: RunSummary, q: ParsedQuery, now: number): boolean {
  if (q.agents.length && !q.agents.includes(r.agent)) return false;
  if (q.statuses.length && !q.statuses.includes(r.status)) return false;
  if (q.times.length && !q.times.some((t) => inTime(r.updatedAt, t, now))) return false;
  if (q.words.length) {
    const h = haystack(r);
    if (!q.words.every((w) => h.includes(w))) return false;
  }
  return true;
}

/** Runs matching the query, newest first. */
export function searchRuns(runs: RunSummary[], input: string, now: number, limit = 50): RunSummary[] {
  const q = parseQuery(input);
  return runs
    .filter((r) => matchRun(r, q, now))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/** Human summary of what the query understood, e.g. "Codex · Failed · yesterday". */
export function describeQuery(q: ParsedQuery): string {
  const parts = [
    ...q.agents.map((a) => AGENT_NAMES[a]),
    ...q.statuses.map((s) => STATUS_LABELS[s]),
    ...q.times.map((t) => t.replace('-', ' ')),
    ...q.words.map((w) => `"${w}"`),
  ];
  return parts.join(' · ');
}

export { AGENT_IDS, RUN_STATUSES };
