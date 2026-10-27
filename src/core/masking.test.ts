import { describe, expect, it } from 'vitest';
import { maskSecrets, maskSecretsDetailed } from './masking';

// Fake keys are assembled at runtime so that no realistic-looking secret is ever committed:
// GitHub push protection and the repo's own scanner would (rightly) flag literal ones.
const rep = (c: string, n: number) => c.repeat(n);
const mix = (n: number) => 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z'.repeat(4).slice(0, n);

const PLANTED: Record<string, string> = {
  anthropic: 'sk-' + 'ant-api03-' + mix(40),
  openai: 'sk-' + 'proj-' + mix(48),
  openaiLegacy: 'sk-' + mix(48),
  github: 'gh' + 'p_' + mix(36),
  githubFine: 'github' + '_pat_' + mix(30),
  gitlab: 'gl' + 'pat-' + mix(20),
  slack: 'xo' + 'xb-' + '1234567890-' + mix(24),
  stripe: 'sk' + '_live_' + mix(24),
  aws: 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP',
  google: 'AI' + 'za' + mix(35),
  huggingface: 'hf' + '_' + mix(34),
  npm: 'np' + 'm_' + mix(36),
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9.' + 'ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0.' + mix(32),
};

describe('maskSecrets: provider keys', () => {
  for (const [name, key] of Object.entries(PLANTED)) {
    it(`masks a planted ${name} key in prose, JSON and env lines`, () => {
      for (const text of [
        `here is the key ${key} thanks`,
        JSON.stringify({ headers: { note: key } }),
        `EXPORTED_VALUE=${key}`,
      ]) {
        const out = maskSecrets(text);
        expect(out).not.toContain(key);
        // No long run of the secret's tail survives either.
        expect(out).not.toContain(key.slice(-12));
        expect(out).toContain('••••');
      }
    });
  }
});

describe('maskSecrets: credentials in context', () => {
  it('masks bearer and basic auth headers', () => {
    const tok = mix(40);
    expect(maskSecrets(`curl -H "Authorization: Bearer ${tok}" https://api.example.com`)).not.toContain(tok);
    expect(maskSecrets(`Authorization: Basic ${mix(24)}==`)).not.toContain(mix(24));
    expect(maskSecrets(`x-api-key: ${tok}`)).not.toContain(tok);
  });

  it('masks passwords in connection-string URLs and keeps user and host', () => {
    const pw = 'S3cr3t' + 'Pass!' + rep('9', 4);
    const out = maskSecrets(`DATABASE_URL=postgres://app_user:${pw}@db.internal:5432/app`);
    expect(out).not.toContain(pw);
    expect(out).toContain('postgres://app_user:••••@db.internal:5432/app');
    expect(maskSecrets(`mongodb+srv://admin:${pw}@cluster0.example.net/test`)).not.toContain(pw);
    expect(maskSecrets(`redis://:${pw}@localhost:6379`)).not.toContain(pw);
  });

  it('masks ADO.NET / ODBC style connection strings', () => {
    const pw = 'Hunter' + '2' + mix(6);
    const out = maskSecrets(`Server=tcp:sql.example.com,1433;Database=app;User Id=sa;Password=${pw};Encrypt=True`);
    expect(out).not.toContain(pw);
    expect(out).toContain('Server=tcp:sql.example.com,1433');
    expect(maskSecrets(`DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${mix(40)}==;`)).not.toContain(mix(40));
  });

  it('masks private key blocks', () => {
    const body = mix(64);
    const kind = 'RSA PRIVATE' + ' KEY';
    const pem = `-----BEGIN ${kind}-----\n${body}\n${body}\n-----END ${kind}-----`;
    const out = maskSecrets(`key:\n${pem}\nafter`);
    expect(out).not.toContain(body);
    expect(out).toContain('after');
  });

  it('masks secret-named assignments in env files, YAML and JSON', () => {
    const v = 'q7Lp' + mix(16);
    for (const line of [`API_KEY=${v}`, `client_secret: ${v}`, `"password": "${v}"`, `export GITHUB_TOKEN="${v}"`, `db_pwd = '${v}'`]) {
      expect(maskSecrets(line)).not.toContain(v);
    }
  });
});

describe('maskSecrets: leaves ordinary text alone', () => {
  it('does not mask code that only mentions secrets', () => {
    for (const s of [
      'const token = getToken();',
      'password = process.env.DB_PASSWORD',
      'api_key: ${API_KEY}',
      'Set OPENAI_API_KEY in your shell, then run the tests.',
      'The tokenizer splits text into tokens.',
      'function readPassword(prompt) {}',
      'secret = os.environ["APP_SECRET"]',
      'see https://example.com/docs/auth for details',
    ]) {
      expect(maskSecrets(s)).toBe(s);
    }
  });

  it('counts what it masked', () => {
    const r = maskSecretsDetailed(`${PLANTED.github} and ${PLANTED.stripe}`);
    expect(r.count).toBe(2);
  });

  it('is idempotent', () => {
    const once = maskSecrets(`API_KEY=${mix(24)} ${PLANTED.openai}`);
    expect(maskSecrets(once)).toBe(once);
  });
});
