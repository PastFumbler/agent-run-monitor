// Masks likely secrets in text before it is shown. On by default (Settings > Privacy).
// It errs on the side of masking: a hidden harmless string costs little, a shown key costs a lot.
// Masking happens in the main process, so with it on the renderer never receives the secret.

const DOTS = '••••';

interface Rule {
  label: string;
  re: RegExp;
  /** Build the replacement from the match. Default: keep a short identifying prefix. */
  replace?: (m: string, ...groups: string[]) => string;
  /** Characters of the match to keep visible as a hint (default 0). */
  keep?: number;
}

const keepPrefix = (keep: number, label: string) => (m: string) => `${m.slice(0, keep)}${DOTS}[${label}]`;

// Order matters: specific providers before generic patterns.
const RULES: Rule[] = [
  {
    label: 'private key',
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: () => `-----BEGIN PRIVATE KEY-----${DOTS}[private key]-----END PRIVATE KEY-----`, // scan-secrets:allow
  },
  { label: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, keep: 7 },
  { label: 'OpenAI key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, keep: 3 },
  { label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g, keep: 4 },
  { label: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g, keep: 6 },
  { label: 'Slack token', re: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, keep: 5 },
  { label: 'Slack webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, replace: () => `https://hooks.slack.com/services/${DOTS}[Slack webhook]` },
  { label: 'Stripe key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, keep: 8 },
  { label: 'AWS access key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g, keep: 4 },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}/g, keep: 4 },
  { label: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,}/g, keep: 3 },
  { label: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g, keep: 4 },
  { label: 'SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, keep: 3 },
  { label: 'Twilio key', re: /\bSK[0-9a-f]{32}\b/g, keep: 2 },
  { label: 'xAI key', re: /\bxai-[A-Za-z0-9]{40,}/g, keep: 4 },
  { label: 'Groq key', re: /\bgsk_[A-Za-z0-9]{40,}/g, keep: 4 },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, keep: 3 },
  {
    label: 'auth header',
    re: /\b(Authorization|Proxy-Authorization|X-Api-Key|Api-Key|X-Auth-Token)(["']?\s*[:=]\s*["']?)(Bearer\s+|Basic\s+|Token\s+)?([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_m, name, sep, scheme) => `${name}${sep}${scheme ?? ''}${DOTS}[credential]`,
  },
  {
    label: 'bearer token',
    re: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g,
    replace: (_m, scheme) => `${scheme}${DOTS}[token]`,
  },
  {
    // scheme://user:password@host — keep the user and host, hide the password.
    label: 'URL password',
    re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"]{0,200}:)([^\s@/'"]{1,200})(@)/gi,
    replace: (_m, head, _pw, at) => `${head}${DOTS}${at}`,
  },
  {
    // ADO.NET / ODBC style: Password=...; Pwd=...; AccountKey=...; SharedAccessKey=...
    label: 'connection string secret',
    re: /\b(Password|Pwd|AccountKey|SharedAccessKey|SharedAccessSignature|ClientSecret)(\s*=\s*)("[^"]*"|'[^']*'|[^;'"\s]+)/gi,
    replace: (m, key, eq, value) => (looksLikeReference(value.replace(/^["']|["']$/g, '')) ? m : `${key}${eq}${DOTS}`),
  },
  {
    // KEY=value / "key": "value" for names that say they are secret.
    label: 'secret assignment',
    re: /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|passwd|password|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"',;()<>{}\[\]]{8,})/gi,
    replace: (m, key, sep, value) => (looksLikeReference(value) ? m : `${key}${sep}${DOTS}`),
  },
];

/** Values that point at a secret rather than being one: env lookups, placeholders, code. */
function looksLikeReference(v: string): boolean {
  return (
    /^(process\.env|os\.environ|env\.|import\.meta|\$\{|\$[A-Za-z_]|%[A-Za-z_]+%|getenv|true$|false$|null$|undefined$|none$|nil$)/i.test(v) ||
    /^[a-z]+(?:[A-Z][a-z]+)+$/.test(v) || // camelCase identifiers: getToken, readPassword
    /^[a-z]+(?:_[a-z]+)+$/.test(v) || // snake_case identifiers
    /^<.*>$/.test(v) ||
    /^(x{6,}|\*{6,}|•+|\.{3,}|your[_-]|example|placeholder|redacted|changeme)/i.test(v) ||
    v.includes(DOTS)
  );
}

export interface MaskResult {
  text: string;
  count: number;
}

export function maskSecretsDetailed(text: string): MaskResult {
  if (!text) return { text, count: 0 };
  let count = 0;
  let out = text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (...args: unknown[]) => {
      const m = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      const replaced = rule.replace ? rule.replace(m, ...groups) : keepPrefix(rule.keep ?? 0, rule.label)(m);
      if (replaced !== m) count++;
      return replaced;
    });
  }
  return { text: out, count };
}

export function maskSecrets(text: string): string {
  return maskSecretsDetailed(text).text;
}
