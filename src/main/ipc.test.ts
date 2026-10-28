import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared/settings';
import { BadRequest, mergeSettings, validApiKey, validProvider } from './ipc';

describe('AI summary IPC arguments', () => {
  it('accept known providers only', () => {
    expect(validProvider('anthropic')).toBe('anthropic');
    expect(validProvider('openai')).toBe('openai');
    expect(() => validProvider('evil')).toThrow(BadRequest);
    expect(() => validProvider(undefined)).toThrow(BadRequest);
  });

  it('accept a plausible key or null, and never echo the value in the error', () => {
    expect(validApiKey(null)).toBeNull();
    expect(validApiKey(' abcdefgh12345 ')).toBe('abcdefgh12345');
    for (const bad of ['short', 'with spaces inside', 42, undefined, {}]) {
      let msg = '';
      try {
        validApiKey(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequest);
        msg = (e as Error).message;
      }
      expect(msg).toBe('bad api key');
    }
  });

  it('a settings patch that changes the provider turns AI summaries off', () => {
    const on = { ...defaultSettings(), aiSummaries: true };
    expect(mergeSettings(on, { aiProvider: 'openai' }).aiSummaries).toBe(false);
    expect(mergeSettings(on, { aiProvider: 'openai', aiSummaries: true }).aiSummaries).toBe(true);
    expect(mergeSettings(on, { aiModel: 'claude-x' })).toMatchObject({ aiSummaries: true, aiModel: 'claude-x' });
  });
});
