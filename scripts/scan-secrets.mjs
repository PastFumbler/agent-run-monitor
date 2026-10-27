#!/usr/bin/env node
// Scans the working tree AND every commit in history for secrets and for strings that must
// never be published (personal paths, private names). Run before every push:
// (a line containing the marker scan-secrets:allow is skipped; use it only for reviewed false positives)
//   npm run scan-secrets
// Extra private terms can be supplied without committing them, one per line, in a file named
// by ARM_PRIVATE_TERMS (e.g. your employer's name, your username). Exit code 1 on any finding.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9]{32,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20}/],
  ['Slack token', /\bxox[abeprs]-\d{6,}-[A-Za-z0-9-]{10,}/],
  ['Stripe key', /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{34,}\b/],
  ['URL with password', /\b[a-z][a-z0-9+.-]+:\/\/[^\s:/@'"`$]+:[^\s@/'"`$<{]{6,}@(?!example\.|localhost|db\.internal|host)/i],
];

// Paths that commonly leak a developer's identity.
const IDENTITY_PATTERNS = [
  ['Windows user path', /[A-Za-z]:\\+Users\\+(?!alex\b|demo\b|user\b|USERNAME\b|<|%|\{|\$|you\b|runneradmin\b|Public\b)[A-Za-z][A-Za-z0-9._-]+/],
  ['macOS user path', /\/Users\/(?!alex\b|demo\b|user\b|you\b|<|\$|runner\b|Shared\b)[A-Za-z][A-Za-z0-9._-]+/],
  ['Linux home path', /\/home\/(?!alex\b|demo\b|user\b|you\b|<|\$|runner\b)[A-Za-z][A-Za-z0-9._-]+/],
];

const SKIP = [/^node_modules\//, /^package-lock\.json$/, /^out\//, /^release\//, /\.(png|gif|ico|icns|wasm|jpg|webp)$/i];

function privateTerms() {
  const f = process.env.ARM_PRIVATE_TERMS;
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .map((t) => [`private term "${t.slice(0, 2)}…"`, new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')]);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });

function scanText(label, text, patterns, findings) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // A deliberate, reviewed exception (e.g. the masking rules themselves) carries this marker.
    if (lines[i].includes('scan-secrets:allow')) continue;
    for (const [name, re] of patterns) {
      if (re.test(lines[i])) findings.push(`${label}:${i + 1}: ${name}`);
    }
  }
}

const patterns = [...SECRET_PATTERNS, ...IDENTITY_PATTERNS, ...privateTerms()];
const findings = [];

// 1. Working tree (tracked + untracked, not ignored).
const files = git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean);
for (const f of files) {
  if (SKIP.some((re) => re.test(f)) || !existsSync(f)) continue;
  scanText(f, readFileSync(f, 'utf8'), patterns, findings);
}

// 2. History: every blob ever committed, plus commit metadata (author names and e-mails).
let hasHistory = true;
try {
  git('rev-parse', 'HEAD');
} catch {
  hasHistory = false;
}
if (hasHistory) {
  const blobs = new Map();
  for (const line of git('rev-list', '--objects', '--all').split('\n')) {
    const [sha, ...rest] = line.split(' ');
    const path = rest.join(' ');
    if (sha && path && !SKIP.some((re) => re.test(path))) blobs.set(sha, path);
  }
  for (const [sha, path] of blobs) {
    let type;
    try {
      type = git('cat-file', '-t', sha).trim();
    } catch {
      continue;
    }
    if (type !== 'blob') continue;
    scanText(`history ${sha.slice(0, 8)} ${path}`, git('cat-file', '-p', sha), patterns, findings);
  }
  const meta = git('log', '--all', '--format=%H%x09%an <%ae>%x09%cn <%ce>%x09%s%n%b');
  scanText('commit metadata', meta, [...IDENTITY_PATTERNS, ...privateTerms()], findings);
}

const unique = [...new Set(findings)];
if (unique.length) {
  console.error(`scan-secrets: ${unique.length} finding(s):`);
  for (const f of unique) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`scan-secrets: clean (${files.length} files${hasHistory ? ' and full history' : ''} scanned).`);
