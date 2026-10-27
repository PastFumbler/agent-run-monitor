#!/usr/bin/env node
// Points every link in the project at your GitHub repository.
//   npm run set-repo -- your-name/agent-run-monitor
// Replaces OWNER/agent-run-monitor in the files that mention it.

import { readFileSync, writeFileSync } from 'node:fs';

const target = process.argv[2];
if (!target || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(target)) {
  console.error('usage: npm run set-repo -- <owner>/<repo>');
  process.exit(1);
}
const FILES = [
  'package.json',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'electron-builder.yml',
  'src/shared/project.ts',
  'docs/BLOCK-TEST.md',
  '.github/ISSUE_TEMPLATE/config.yml',
];
let changed = 0;
for (const f of FILES) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const next = text.replaceAll('OWNER/agent-run-monitor', target);
  if (next !== text) {
    writeFileSync(f, next);
    changed++;
    console.log(`updated ${f}`);
  }
}
console.log(changed ? `Done: ${changed} file(s) now point at ${target}.` : 'Nothing to change.');
