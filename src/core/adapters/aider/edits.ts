// Finds the files an Aider reply proposes to edit. Aider has no tool-call records: edits are blocks
// inside the assistant Markdown, in the shape of the session's edit format (aider/coders/*):
//   diff / editor-diff     path line, fence, <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE, fence
//   diff-fenced            fence, path line, SEARCH ...
//   whole / editor-whole   path line, fence holding the whole file
//   udiff                  ```diff with --- a/path / +++ b/path hunks
//   patch                  *** Add|Update|Delete File: path
// The authoritative "it happened" signal is "> Applied edit to <path>", handled by the parser.

import type { FileOp } from '@shared/schema';
import { applyPatchFiles, capDiff, countDiffLines, diffTexts, type DiffText } from '../../changes';
import { DIVIDER, FENCE_OPEN, PATCH_FILE, REPLACE, SEARCH, UDIFF_NEW, UDIFF_OLD } from './patterns';

export interface ProposedEdit {
  path: string;
  op: FileOp;
  blocks: number;
  /**
   * What the blocks change, when they show it (SEARCH/REPLACE, udiff, patch; a "whole" file
   * replacement does not show the old text). Capped: it waits in parse state for "Applied edit".
   */
  diff?: DiffText;
}

function cleanPath(line: string | undefined): string | undefined {
  if (!line) return undefined;
  const p = line
    .trim()
    .replace(/^[*`#\s]+|[*`:\s]+$/g, '')
    .replace(/^(?:a|b)\/(?=\S)/, '');
  if (!p || p.length > 300 || /^[<=>]/.test(p)) return undefined;
  return p;
}

const looksLikeFile = (p: string | undefined): p is string => !!p && !/\s/.test(p) && /[./\\]/.test(p);

function add(found: Map<string, ProposedEdit>, path: string | undefined, op: FileOp, diff?: DiffText): void {
  if (!path) return;
  const cur = found.get(path);
  if (cur) {
    cur.blocks++;
    // Every block must show its change, else the file's counts are unknown.
    cur.diff = cur.diff && diff ? capDiff({ diff: `${cur.diff.diff}\n${diff.diff}`, added: cur.diff.added + diff.added, removed: cur.diff.removed + diff.removed }) : undefined;
  } else found.set(path, { path, op, blocks: 1, diff: capDiff(diff) });
}

/** The old and new lines of the SEARCH block starting at line i, as a diff. */
function searchBlock(lines: string[], i: number): DiffText | undefined {
  let j = i + 1;
  while (j < lines.length && !DIVIDER.test(lines[j])) j++;
  let k = j + 1;
  while (k < lines.length && !REPLACE.test(lines[k])) k++;
  if (k >= lines.length) return undefined;
  return diffTexts(lines.slice(i + 1, j).join('\n'), lines.slice(j + 1, k).join('\n'));
}

/** The hunk lines after a udiff "+++" header at line i, up to the first line that is not diff. */
function udiffHunks(lines: string[], i: number): DiffText | undefined {
  const body: string[] = [];
  for (let j = i + 1; j < lines.length && /^(@@|[ +-]|\\)/.test(lines[j]) && !UDIFF_OLD.test(lines[j]); j++) body.push(lines[j]);
  if (!body.some((l) => l.startsWith('@@'))) return undefined;
  const diff = body.join('\n');
  return { diff, ...countDiffLines(diff) };
}

/** The files a reply proposes to change, in order of first mention, one entry per file. */
export function extractEdits(text: string, editFormat: string | undefined): ProposedEdit[] {
  if (editFormat && /^(ask|context|help)$/.test(editFormat)) return [];
  const lines = text.split('\n');
  const found = new Map<string, ProposedEdit>();
  const whole = !!editFormat && editFormat.includes('whole');
  const patched = new Map(applyPatchFiles(text).map((f) => [f.path, f.diff]));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SEARCH.test(line)) {
      // diff: path, fence, SEARCH. diff-fenced: fence, path, SEARCH.
      let cand = lines[i - 1];
      if (cand !== undefined && FENCE_OPEN.test(cand)) cand = lines[i - 2];
      add(found, cleanPath(cand), DIVIDER.test(lines[i + 1] ?? '') ? 'create' : 'edit', searchBlock(lines, i));
      continue;
    }
    const pf = PATCH_FILE.exec(line);
    if (pf) {
      add(found, cleanPath(pf[2]), pf[1] === 'Add' ? 'create' : pf[1] === 'Delete' ? 'delete' : 'edit', patched.get(pf[2].trim()));
      continue;
    }
    const nu = UDIFF_NEW.exec(line);
    const old = nu && UDIFF_OLD.exec(lines[i - 1] ?? '');
    if (nu && old) {
      const from = old[1].trim();
      const to = nu[1].trim();
      if (to === '/dev/null') add(found, cleanPath(from), 'delete', udiffHunks(lines, i));
      else add(found, cleanPath(to), from === '/dev/null' ? 'create' : 'edit', udiffHunks(lines, i));
      continue;
    }
    if (whole && FENCE_OPEN.test(lines[i + 1] ?? '')) {
      const p = cleanPath(line);
      if (looksLikeFile(p)) add(found, p, 'edit');
    }
  }
  return [...found.values()];
}
