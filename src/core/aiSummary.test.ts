import { describe, expect, it, vi } from 'vitest';
import type { RunDetail, RunEvent } from '@shared/schema';
import {
  buildPrompt,
  buildRequest,
  ENDPOINTS,
  fingerprint,
  httpErrorText,
  MAX_CACHED,
  MAX_PROMPT,
  MAX_REPLY,
  readReply,
  SummaryCache,
  Summarizer,
  SYSTEM_PROMPT,
  type FetchLike,
} from './aiSummary';

// Fake keys are assembled at runtime (see masking.test.ts): no realistic secret is ever committed.
const mix = (n: number) => 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z'.repeat(4).slice(0, n);
const PLANTED = 'gh' + 'p_' + mix(36);
const API_KEY = 'sk-' + 'ant-api03-' + mix(40);

function detail(events: Partial<RunEvent>[] = [], over: Partial<RunDetail> = {}): RunDetail {
  const evs = events.map((e, i) => ({ seq: i, kind: 'assistant', text: '', ...e }) as RunEvent);
  return {
    summary: {
      id: 'codex:run1',
      agent: 'codex',
      title: 'Cache forecast responses',
      projectName: 'weather-api',
      startedAt: 0,
      updatedAt: 1,
      status: 'done',
      counts: { events: evs.length, messages: 1, toolCalls: 2, errors: 0, filesChanged: 1 },
      sourcePath: '/x.jsonl',
    },
    events: evs,
    totalEvents: evs.length,
    files: [{ path: 'src/cache.ts', ops: ['edit'], count: 2 }],
    tools: [],
    changes: [],
    totalChanges: 2,
    ...over,
  };
}

const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const anthropicReply = (text: string) => res(200, { content: [{ type: 'text', text }] });

describe('buildPrompt', () => {
  it('carries the request, status, files and recent activity, without tool output or reasoning', () => {
    const p = buildPrompt(
      detail([
        { kind: 'user', text: 'Cache forecast responses for ten minutes' },
        { kind: 'reasoning', text: 'private chain of thought' },
        { kind: 'tool_call', toolName: 'shell', text: 'npm test' },
        { kind: 'tool_result', text: 'FILE CONTENTS' },
        { kind: 'assistant', text: 'Done: added a TTL cache.' },
      ]),
    );
    expect(p).toContain('Agent: Codex');
    expect(p).toContain('Project: weather-api');
    expect(p).toContain('Status: Done');
    expect(p).toContain('Request: Cache forecast responses for ten minutes');
    expect(p).toContain('Files changed (1): src/cache.ts');
    expect(p).toContain('[tool shell] npm test');
    expect(p).toContain('[agent] Done: added a TTL cache.');
    expect(p).not.toContain('private chain of thought');
    expect(p).not.toContain('FILE CONTENTS');
  });

  it('masks secrets in every field, whatever the display setting', () => {
    const p = buildPrompt(
      detail([{ kind: 'user', text: `use ${PLANTED}` }, { kind: 'tool_call', toolName: 'Bash', text: `export TOKEN=${PLANTED}` }], {
        files: [{ path: `/tmp/${PLANTED}.txt`, ops: ['edit'], count: 1 }],
      }),
    );
    expect(p).not.toContain(PLANTED);
    expect(p).not.toContain(PLANTED.slice(-12));
    expect(p).toContain('••••');
  });

  it('masks before clipping, so a secret cut at the line limit cannot slip through', () => {
    const text = `${'x'.repeat(260)} ${PLANTED}`;
    const p = buildPrompt(detail([{ kind: 'assistant', text }]));
    expect(p).not.toContain(PLANTED.slice(0, 15));
  });

  it('stays within MAX_PROMPT, keeping the newest activity', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ kind: 'assistant' as const, text: `step ${i} ${'y'.repeat(200)}` }));
    const p = buildPrompt(detail(many));
    expect(p.length).toBeLessThanOrEqual(MAX_PROMPT);
    expect(p).toContain('step 399 ');
    expect(p).not.toContain('step 0 ');
  });

  it('uses the title when the first request is outside the loaded events', () => {
    const d = detail([{ kind: 'user', text: 'a later message' }]);
    d.events[0].seq = 50;
    expect(buildPrompt(d)).toContain('Request: Cache forecast responses\n');
  });

  it('fingerprints the same content the same way', () => {
    expect(fingerprint(buildPrompt(detail()))).toBe(fingerprint(buildPrompt(detail())));
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
    expect(fingerprint('a')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('buildRequest', () => {
  it('Anthropic: Messages API with the key in x-api-key', () => {
    const r = buildRequest('anthropic', 'claude-haiku-5-5', API_KEY, 'PROMPT');
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.init.headers['x-api-key']).toBe(API_KEY);
    expect(r.init.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(r.init.body);
    expect(body).toMatchObject({ model: 'claude-haiku-5-5', system: SYSTEM_PROMPT, messages: [{ role: 'user', content: 'PROMPT' }] });
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('OpenAI: Chat Completions with a bearer key', () => {
    const r = buildRequest('openai', 'gpt-4o-mini', 'k-123456789', 'PROMPT');
    expect(r.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(r.init.headers.authorization).toBe('Bearer k-123456789');
    const body = JSON.parse(r.init.body);
    expect(body.messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'PROMPT' },
    ]);
    expect(body.max_completion_tokens).toBeGreaterThan(0);
  });
});

describe('readReply', () => {
  it('reads each provider and tidies the text', () => {
    expect(readReply('anthropic', { content: [{ type: 'text', text: '  The agent **added** a\ncache.  ' }] })).toBe('The agent added a cache.');
    expect(readReply('openai', { choices: [{ message: { content: 'It fixed `add_task`.' } }] })).toBe('It fixed add_task.');
    expect(readReply('openai', { choices: [] })).toBeUndefined();
    expect(readReply('anthropic', 'nope')).toBeUndefined();
  });

  it('masks and caps what comes back', () => {
    expect(readReply('anthropic', { content: [{ type: 'text', text: `key ${PLANTED}` }] })).not.toContain(PLANTED);
    expect(readReply('anthropic', { content: [{ type: 'text', text: 'z'.repeat(5000) }] })!.length).toBe(MAX_REPLY);
  });
});

describe('httpErrorText', () => {
  it('explains common failures in plain words', () => {
    expect(httpErrorText('anthropic', 401, {})).toMatch(/Anthropic refused the API key/);
    expect(httpErrorText('openai', 404, { error: { message: 'The model `x` does not exist' } })).toMatch(/couldn't find that model.*does not exist/);
    expect(httpErrorText('openai', 429, {})).toMatch(/limiting requests/);
    expect(httpErrorText('anthropic', 529, {})).toMatch(/had a problem \(529\)/);
  });
});

describe('Summarizer (stubbed fetch, no network)', () => {
  const cfg = { provider: 'anthropic' as const, model: 'claude-haiku-5-5', key: API_KEY };

  it('sends the masked prompt once and reuses the summary for the same content', async () => {
    const fetch = vi.fn<FetchLike>(async () => anthropicReply('It added a TTL cache.'));
    const onCached = vi.fn();
    const s = new Summarizer(fetch, new SummaryCache(), onCached, () => 42);
    const d = detail([{ kind: 'user', text: `secret ${PLANTED}` }]);

    expect(await s.summarize(d, cfg)).toEqual({ text: 'It added a TTL cache.', provider: 'anthropic', model: 'claude-haiku-5-5', cached: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(ENDPOINTS.anthropic);
    expect(init.body).not.toContain(PLANTED);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(onCached).toHaveBeenCalledTimes(1);

    expect(await s.summarize(detail([{ kind: 'user', text: `secret ${PLANTED}` }]), cfg)).toMatchObject({ cached: true, text: 'It added a TTL cache.' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(s.cache.toJSON().entries[0]).toMatchObject({ runId: 'codex:run1', at: 42 });
  });

  it('asks again when the run content changed', async () => {
    const fetch = vi.fn<FetchLike>(async () => anthropicReply('ok'));
    const s = new Summarizer(fetch);
    await s.summarize(detail([{ kind: 'user', text: 'one' }]), cfg);
    await s.summarize(detail([{ kind: 'user', text: 'one' }, { kind: 'assistant', text: 'two' }]), cfg);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(s.cache.size).toBe(1);
  });

  it('does not ask again when only the clock moved (status detail such as "Quiet for n minutes")', async () => {
    const fetch = vi.fn<FetchLike>(async () => anthropicReply('ok'));
    const s = new Summarizer(fetch);
    const quiet = (detailText: string) => {
      const d = detail([{ kind: 'user', text: 'one' }]);
      return { ...d, summary: { ...d.summary, status: 'running' as const, statusDetail: detailText } };
    };
    await s.summarize(quiet('Quiet for 4 minutes'), cfg);
    expect(fetch.mock.calls[0][1].body).toContain('Quiet for 4 minutes');
    expect(await s.summarize(quiet('Quiet for 9 minutes'), cfg)).toMatchObject({ cached: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shares one request between simultaneous asks', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = vi.fn<FetchLike>(async () => {
      await gate;
      return anthropicReply('once');
    });
    const s = new Summarizer(fetch);
    const a = s.summarize(detail(), cfg);
    const b = s.summarize(detail(), cfg);
    release();
    expect((await a).text).toBe('once');
    expect((await b).text).toBe('once');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns plain-words errors, never the key, and caches nothing', async () => {
    const cases: [FetchLike, RegExp][] = [
      [async () => res(401, { error: { message: `invalid x-api-key ${API_KEY}` } }), /refused the API key/],
      [async () => res(400, { error: { message: `bad key ${API_KEY}` } }), /turned the request down \(400\)/],
      [async () => res(200, { content: [] }), /sent back no summary/],
      [async () => ({ ok: true, status: 200, text: async () => 'not json' }), /sent back no summary/],
      [
        async () => {
          throw new Error(`connect failed for ${API_KEY}`);
        },
        /Couldn't reach Anthropic/,
      ],
      [
        async () => {
          throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        },
        /took too long/,
      ],
    ];
    for (const [fetch, re] of cases) {
      const s = new Summarizer(fetch);
      const r = await s.summarize(detail(), cfg);
      expect(r.error).toMatch(re);
      expect(r.error).not.toContain(API_KEY);
      expect(r.error).not.toContain(API_KEY.slice(-12));
      expect(r.text).toBeUndefined();
      expect(s.cache.size).toBe(0);
    }
  });

  it('reads OpenAI replies', async () => {
    const fetch = vi.fn<FetchLike>(async () => res(200, { choices: [{ message: { content: 'Done.' } }] }));
    const r = await new Summarizer(fetch).summarize(detail(), { provider: 'openai', model: 'gpt-4o-mini', key: 'k-123456789' });
    expect(r).toMatchObject({ text: 'Done.', provider: 'openai', model: 'gpt-4o-mini' });
    expect(fetch.mock.calls[0][0]).toBe(ENDPOINTS.openai);
  });
});

describe('SummaryCache', () => {
  const entry = (i: number) => ({ runId: `r${i}`, fp: fingerprint(String(i)), text: `t${i}`, provider: 'openai' as const, model: 'm', at: i });

  it('keeps one summary per run and drops the least recently used past the cap', () => {
    const c = new SummaryCache();
    for (let i = 0; i < MAX_CACHED + 5; i++) c.set(entry(i));
    expect(c.size).toBe(MAX_CACHED);
    expect(c.get('r0', entry(0).fp)).toBeUndefined();
    expect(c.get('r5', entry(5).fp)?.text).toBe('t5');
    c.set({ ...entry(5), fp: fingerprint('new') });
    expect(c.get('r5', entry(5).fp)).toBeUndefined();
  });

  it('round-trips through JSON and drops malformed entries', () => {
    const c = new SummaryCache();
    c.set(entry(1));
    const raw = JSON.parse(JSON.stringify(c.toJSON()));
    raw.entries.push({ runId: 'x', fp: 'nothex', text: 't', provider: 'openai', model: 'm' });
    raw.entries.push({ runId: 'y', fp: fingerprint('y'), text: 't', provider: 'someone-else', model: 'm' });
    raw.entries.push('junk');
    const back = SummaryCache.from(raw);
    expect(back.size).toBe(1);
    expect(back.get('r1', entry(1).fp)?.text).toBe('t1');
    expect(SummaryCache.from(undefined).size).toBe(0);
    expect(SummaryCache.from({ entries: 'nope' }).size).toBe(0);
  });
});
