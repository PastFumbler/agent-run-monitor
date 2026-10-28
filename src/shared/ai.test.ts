import { describe, expect, it } from 'vitest';
import { cleanApiKey, cleanModelName, DEFAULT_MODELS, modelFor } from './ai';
import { defaultSettings, guardAiProvider, normalizeSettings } from './settings';

describe('AI summary settings', () => {
  it('are off by default, with Anthropic and its default model', () => {
    const d = defaultSettings();
    expect(d.aiSummaries).toBe(false);
    expect(d.aiProvider).toBe('anthropic');
    expect(d.aiModel).toBe('');
    expect(modelFor(d.aiProvider, d.aiModel)).toBe('claude-haiku-5-5');
    expect(DEFAULT_MODELS.openai).toBeTruthy();
  });

  it('fall back to defaults when invalid, never crash', () => {
    const s = normalizeSettings({ aiSummaries: 'yes', aiProvider: 'someone-else', aiModel: 'bad model name!' });
    expect(s).toMatchObject({ aiSummaries: false, aiProvider: 'anthropic', aiModel: '' });
    expect(normalizeSettings({ aiSummaries: true, aiProvider: 'openai', aiModel: ' gpt-4.1-mini ' })).toMatchObject({
      aiSummaries: true,
      aiProvider: 'openai',
      aiModel: 'gpt-4.1-mini',
    });
  });

  it('a provider change turns AI summaries off unless the same change confirms them', () => {
    const on = normalizeSettings({ aiSummaries: true });
    const switched = normalizeSettings({ ...on, aiProvider: 'openai' });
    expect(guardAiProvider(on, switched, { aiProvider: 'openai' }).aiSummaries).toBe(false);
    expect(guardAiProvider(on, switched, { aiProvider: 'openai', aiSummaries: true }).aiSummaries).toBe(true);
    expect(guardAiProvider(on, on, { aiModel: 'x' }).aiSummaries).toBe(true);
  });
});

describe('cleanModelName', () => {
  it('keeps plausible names and drops anything else', () => {
    expect(cleanModelName('claude-haiku-5-5')).toBe('claude-haiku-5-5');
    expect(cleanModelName('org/model:latest@v1.2_x')).toBe('org/model:latest@v1.2_x');
    expect(cleanModelName('')).toBe('');
    expect(cleanModelName('two words')).toBe('');
    expect(cleanModelName('-leading')).toBe('');
    expect(cleanModelName('x'.repeat(101))).toBe('');
    expect(cleanModelName(42)).toBe('');
  });
});

describe('cleanApiKey', () => {
  it('trims a pasted key and refuses what cannot be one', () => {
    expect(cleanApiKey('  abcdefgh12345 \n')).toBe('abcdefgh12345');
    expect(cleanApiKey('short')).toBeNull();
    expect(cleanApiKey('has a space in it')).toBeNull();
    expect(cleanApiKey('tab\there12345')).toBeNull();
    expect(cleanApiKey('x'.repeat(501))).toBeNull();
    expect(cleanApiKey(null)).toBeNull();
  });
});
