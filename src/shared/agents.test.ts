import { describe, expect, it } from 'vitest';
import { ALL_ADAPTERS } from '../core/all-adapters';
import { AGENT_CONFIDENCE } from './agents';
import { AGENT_IDS } from './schema';

describe('AGENT_CONFIDENCE', () => {
  it("matches every adapter's own confidence", () => {
    const fromAdapters = Object.fromEntries(ALL_ADAPTERS.map((a) => [a.id, a.confidence]));
    expect(AGENT_CONFIDENCE).toEqual(fromAdapters);
  });

  it('covers every agent id, and every agent has an adapter', () => {
    expect(Object.keys(AGENT_CONFIDENCE).sort()).toEqual([...AGENT_IDS].sort());
    expect(ALL_ADAPTERS.map((a) => a.id).sort()).toEqual([...AGENT_IDS].sort());
  });
});
