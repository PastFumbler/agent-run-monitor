// The optional AI summary (Overview): providers, default models and the shapes that cross IPC.
// Off by default. The API key lives only in the main process (src/main/ai.ts); the renderer only
// learns whether one is saved. Requests are made from main, with run text masked first.

export const AI_PROVIDERS = ['anthropic', 'openai'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const PROVIDER_NAMES: Record<AiProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

/** Used when the model field is left empty. */
export const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-4o-mini',
};

export const MAX_MODEL_NAME = 100;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

/** A model name as typed, or '' (use the provider's default) when it is empty or not a plausible name. */
export function cleanModelName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const v = raw.trim();
  return v.length <= MAX_MODEL_NAME && MODEL_NAME.test(v) ? v : '';
}

export function modelFor(provider: AiProvider, model: string): string {
  return model || DEFAULT_MODELS[provider];
}

/** What the renderer may know about the saved keys: whether one exists, never the key itself. */
export interface AiStatus {
  keys: Record<AiProvider, boolean>;
  /**
   * True when keys are stored encrypted by the operating system (Electron safeStorage). False when
   * this system offers no secure storage: a key is then kept in memory for this session only.
   */
  secure: boolean;
  /** Set when the last change was refused or could not be saved, in plain words. */
  error?: string;
}

export interface AiSummaryResult {
  /** The summary; absent when `error` is set. */
  text?: string;
  provider?: AiProvider;
  model?: string;
  /** True when the same run content was summarised before and the saved summary was reused. */
  cached?: boolean;
  /** Plain words; the Overview then shows the local summary with this as a short note. */
  error?: string;
}

export const MIN_KEY_LENGTH = 8;
export const MAX_KEY_LENGTH = 500;

/** A pasted key, trimmed; null when it cannot be a key (too short or long, spaces or control characters). */
export function cleanApiKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length < MIN_KEY_LENGTH || v.length > MAX_KEY_LENGTH) return null;
  return /^[\x21-\x7e]+$/.test(v) ? v : null;
}
