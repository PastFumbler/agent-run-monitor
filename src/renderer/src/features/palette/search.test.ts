import { describe, expect, it } from 'vitest';
import type { AgentId, RunStatus, RunSummary } from '@shared/schema';
import { matchRun, parseQuery, searchRuns } from './search';

const NOW = new Date(2026, 9, 27, 15, 30).getTime(); // local time, Tuesday
const H = 3_600_000;

let n = 0;
function run(agent: AgentId, status: RunStatus, project: string, updatedAgo: number, title = 'Some task'): RunSummary {
  n++;
  return {
    id: `${agent}:${n}`,
    agent,
    title,
    projectName: project,
    startedAt: NOW - updatedAgo - H,
    updatedAt: NOW - updatedAgo,
    status,
    counts: { events: 1, messages: 1, toolCalls: 0, errors: 0, filesChanged: 0 },
    sourcePath: `/home/demo/${n}.jsonl`,
  };
}

const runs = [
  run('codex', 'failed', 'weather-api', 26 * H, 'Cache forecast responses'), // yesterday 13:30
  run('codex', 'failed', 'todo-cli', 0.2 * H), // today
  run('codex', 'done', 'weather-api', 25 * H), // yesterday
  run('claude-code', 'failed', 'blog-engine', 27 * H), // yesterday
  run('claude-code', 'running', 'todo-cli', 0.01 * H, 'Add a --due flag'),
  run('gemini-cli', 'stuck', 'pixel-editor', 0.5 * H),
  run('copilot-cli', 'waiting', 'chess-engine', 3 * 24 * H),
  run('copilot-vscode', 'done', 'chess-engine', 2 * H),
];

describe('parseQuery', () => {
  it('splits agent, status and time words from free text', () => {
    expect(parseQuery('codex failed yesterday')).toEqual({ agents: ['codex'], statuses: ['failed'], times: ['yesterday'], words: [] });
    expect(parseQuery('Claude Code running todo')).toEqual({ agents: ['claude-code'], statuses: ['running'], times: [], words: ['todo'] });
    expect(parseQuery('errors last hour')).toMatchObject({ statuses: ['failed'], times: ['last-hour'] });
    expect(parseQuery('copilot this week')).toMatchObject({ agents: ['copilot-vscode', 'copilot-cli'], times: ['this-week'] });
    expect(parseQuery('weather-api')).toMatchObject({ words: ['weather-api'] });
  });
});

describe('searchRuns', () => {
  const ids = (q: string) => searchRuns(runs, q, NOW).map((r) => r.id);

  it('"codex failed yesterday" finds only Codex runs that failed yesterday', () => {
    expect(ids('codex failed yesterday')).toEqual([runs[0].id]);
  });

  it('project + status', () => {
    expect(ids('weather failed')).toEqual([runs[0].id]);
    expect(ids('todo running')).toEqual([runs[4].id]);
  });

  it('agent only, newest first', () => {
    expect(ids('codex')).toEqual([runs[1].id, runs[2].id, runs[0].id]);
  });

  it('time words', () => {
    expect(ids('today')).toEqual([runs[4].id, runs[1].id, runs[5].id, runs[7].id]);
    expect(ids('last hour')).toEqual([runs[4].id, runs[1].id, runs[5].id]);
    expect(ids('this week stuck')).toEqual([runs[5].id]);
  });

  it('free words match title and project', () => {
    expect(ids('forecast')).toEqual([runs[0].id]);
    expect(ids('due flag')).toEqual([runs[4].id]);
    expect(ids('nothing-like-this')).toEqual([]);
  });

  it('synonyms for statuses', () => {
    expect(ids('hung')).toEqual([runs[5].id]);
    expect(ids('error claude')).toEqual([runs[3].id]);
  });

  it('matchRun with an empty query matches everything', () => {
    expect(runs.every((r) => matchRun(r, parseQuery(''), NOW))).toBe(true);
  });
});
