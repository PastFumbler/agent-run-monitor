// Optional AI summaries (off by default), main process only. Keeps the user's API keys, makes the
// provider request and caches the result. A key is encrypted with Electron safeStorage and written
// to <userData>/ai-keys.json; where the OS offers no secure storage it is kept in memory for this
// session only. Keys are never sent to the renderer and never logged. Summaries are cached in memory
// and in <userData>/ai-summaries.json, keyed by run id + a fingerprint of the (masked) run content.

import { safeStorage } from 'electron';
import path from 'node:path';
import { AI_PROVIDERS, modelFor, PROVIDER_NAMES, type AiProvider, type AiStatus, type AiSummaryResult } from '@shared/ai';
import type { RunDetail } from '@shared/schema';
import type { Settings } from '@shared/settings';
import { Summarizer, SummaryCache, type FetchLike } from '@core/aiSummary';
import { readJsonFile, writeJsonAtomic } from './files';
import { aiSession, withAllowedUrl } from './security';

const KEYS_FILE = 'ai-keys.json';
const CACHE_FILE = 'ai-summaries.json';

type Keys = Partial<Record<AiProvider, string>>;

export class AiService {
  /** Encrypted keys as saved (base64). */
  private stored: Keys = {};
  /** Plain keys kept for this session only, when the OS has no secure storage. */
  private memory: Keys = {};
  private loaded?: Promise<void>;
  private cacheLoaded?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly summarizer: Summarizer;

  constructor(
    private readonly dir: string,
    private readonly log: (m: string) => void,
    fetch?: FetchLike,
  ) {
    this.summarizer = new Summarizer(fetch ?? this.providerFetch, new SummaryCache(), () => this.saveCache());
  }

  /** Requests go through their own guarded session, allowed one URL at a time. */
  private providerFetch: FetchLike = (url, init) => {
    const ses = aiSession({ log: this.log });
    return withAllowedUrl(url, () => ses.fetch(url, { ...init, credentials: 'omit', cache: 'no-store' }));
  };

  private async secure(): Promise<boolean> {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
      // Linux without a keyring falls back to a fixed password: not secure enough for a key.
      return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
    } catch {
      return false;
    }
  }

  private load(): Promise<void> {
    this.loaded ??= readJsonFile(path.join(this.dir, KEYS_FILE)).then((r) => {
      const d = r.data as Record<string, unknown> | undefined;
      if (!d || typeof d !== 'object') return;
      for (const p of AI_PROVIDERS) if (typeof d[p] === 'string' && (d[p] as string).length < 4096) this.stored[p] = d[p] as string;
    });
    return this.loaded;
  }

  async status(error?: string): Promise<AiStatus> {
    await this.load();
    const keys = {} as Record<AiProvider, boolean>;
    for (const p of AI_PROVIDERS) keys[p] = !!(this.stored[p] || this.memory[p]);
    return { keys, secure: await this.secure(), ...(error ? { error } : {}) };
  }

  /** Saves (or with null removes) the key for one provider. `key` is already validated. */
  async setKey(provider: AiProvider, key: string | null): Promise<AiStatus> {
    await this.load();
    const secure = await this.secure();
    const next: Keys = { ...this.stored };
    delete this.memory[provider];
    if (key === null) delete next[provider];
    else if (secure) {
      try {
        next[provider] = (await safeStorage.encryptStringAsync(key)).toString('base64');
      } catch {
        return this.status("Couldn't encrypt the key. It was not saved.");
      }
    } else {
      delete next[provider];
      this.memory[provider] = key;
    }
    if (JSON.stringify(next) !== JSON.stringify(this.stored)) {
      try {
        await this.queue(() => writeJsonAtomic(this.dir, KEYS_FILE, { version: 1, ...next }));
      } catch (e) {
        this.log(`ai keys: could not save (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
        return this.status("Couldn't save the key. Try again.");
      }
      this.stored = next;
    }
    return this.status();
  }

  private async key(provider: AiProvider): Promise<string | undefined> {
    await this.load();
    if (this.memory[provider]) return this.memory[provider];
    const enc = this.stored[provider];
    if (!enc) return undefined;
    try {
      return (await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))).result || undefined;
    } catch {
      return undefined;
    }
  }

  private loadCache(): Promise<void> {
    this.cacheLoaded ??= readJsonFile(path.join(this.dir, CACHE_FILE)).then((r) => {
      const saved = SummaryCache.from(r.data);
      // Anything summarised before the file was read wins over the saved copy.
      for (const e of saved.toJSON().entries) if (!this.summarizer.cache.get(e.runId, e.fp)) this.summarizer.cache.set(e);
    });
    return this.cacheLoaded;
  }

  private saveCache(): void {
    void this.queue(() => writeJsonAtomic(this.dir, CACHE_FILE, this.summarizer.cache.toJSON())).catch((e) =>
      this.log(`ai summaries: could not save the cache (${(e as NodeJS.ErrnoException).code ?? 'error'})`),
    );
  }

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writes.then(fn, fn);
    this.writes = run.catch(() => undefined);
    return run;
  }

  /**
   * The AI summary of a run, only when the setting is on. `detail` must be built with masking on
   * (store.maskedDetail); the prompt is masked again before it is sent.
   */
  async summarize(detail: RunDetail | null, s: Settings): Promise<AiSummaryResult> {
    if (!s.aiSummaries) return { error: 'AI summaries are off in Settings.' };
    const provider = s.aiProvider;
    const key = await this.key(provider);
    if (!key) return { error: `No ${PROVIDER_NAMES[provider]} API key is saved. Add one in Settings > AI summary.` };
    if (!detail) return { error: 'That run is no longer available.' };
    if (detail.summary.status === 'unreadable') return { error: "This run couldn't be read." };
    await this.loadCache().catch(() => {});
    return this.summarizer.summarize(detail, { provider, model: modelFor(provider, s.aiModel), key });
  }
}
