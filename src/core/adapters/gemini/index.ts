// Gemini CLI and Qwen Code. Qwen forked Gemini CLI in 2025, so one parser family serves both:
// Gemini's JSONL snapshot/patch log and legacy single-JSON sessions (gemini-log.ts), and Qwen's
// append-only record log (qwen-log.ts). The format is sniffed from the first record.
//
// Provenance: neither tool was installed on the build machine, so no real session file was
// read. Every format claim comes from the tools' source code (google-gemini/gemini-cli @363a131,
// 2026-10-26; QwenLM/qwen-code @067090d, 2026-10-27), read by the research pass. Hence
// confidence 'source'. Fixtures are synthetic, written to those TypeScript types.

import { stat } from 'node:fs/promises';
import type { Env, ParseContext, ParsedRun, ParseState, SessionRef, SourceAdapter } from '../../adapter';
import { emptyRun } from '../../adapter';
import { isObj } from '../../events';
import { readJson, readJsonl } from '../../jsonl';
import { expandHome, pathApi } from './common';
import { discoverGemini, discoverQwen } from './discover';
import { applyGeminiRecord, buildGeminiRun, loadLegacyDocument, newGeminiState, type GeminiState } from './gemini-log';
import { applyQwenRecord, finishQwenRun, newQwenState, type QwenState } from './qwen-log';

export const NO_RECORDS = 'No records this app recognises; the agent may have changed its format.';

type Format = 'gemini' | 'qwen' | 'legacy';

/** ParseState.extra for this family. */
interface Extra {
  format?: Format;
  gemini?: GeminiState;
  qwen?: QwenState;
  /** Lines that were not JSON. */
  bad: number;
  /** Records seen before the format was known (all non-objects). */
  early: number;
}

function geminiRoots(env: Env): string[] {
  const p = pathApi(env);
  // GEMINI_CLI_HOME replaces the home folder; `.gemini` is still appended (utils/paths.ts).
  const home = env.vars.GEMINI_CLI_HOME ? expandHome(env.vars.GEMINI_CLI_HOME, env) : env.home;
  const roots = [p.join(home, '.gemini')];
  // macOS Seatbelt sandbox runs (SANDBOX=sandbox-exec) keep their runtime dir in ~/.cache/.gemini.
  if (env.platform === 'darwin') roots.push(p.join(home, '.cache', '.gemini'));
  return roots;
}

function qwenRoots(env: Env): string[] {
  const p = pathApi(env);
  const roots = [env.vars.QWEN_HOME ? expandHome(env.vars.QWEN_HOME, env) : p.join(env.home, '.qwen')];
  if (env.vars.QWEN_RUNTIME_DIR) roots.push(expandHome(env.vars.QWEN_RUNTIME_DIR, env));
  return [...new Set(roots)];
}

/** Gemini JSONL vs Qwen JSONL, from the first object record. */
function sniff(r: Record<string, unknown>): Format {
  return typeof r.uuid === 'string' && typeof r.type === 'string' && !('$set' in r) ? 'qwen' : 'gemini';
}

function cloneExtra(prev: ParseState): Extra {
  return structuredClone(prev.extra) as unknown as Extra;
}

function startRun(ref: SessionRef): ParsedRun {
  return emptyRun(ref.hint?.project || 'Unknown project');
}

/** Rebuilds or completes the run after a batch of records. */
function finish(ref: SessionRef, extra: Extra, qwenRun: ParsedRun | undefined): ParsedRun {
  let run: ParsedRun;
  let recognised = 0;
  if (extra.format === 'qwen' && extra.qwen && qwenRun) {
    run = qwenRun;
    finishQwenRun(run, extra.qwen);
    run.skipped = extra.qwen.skipped + extra.bad + extra.early;
    recognised = extra.qwen.recognised;
  } else {
    run = extra.gemini ? buildGeminiRun(extra.gemini, ref) : startRun(ref);
    run.skipped += extra.bad + extra.early;
    recognised = extra.gemini?.recognised ?? 0;
  }
  if (ref.hint?.parentPath) run.parentPath = ref.hint.parentPath;
  const sawSomething = run.skipped > 0 || recognised > 0;
  run.readError = recognised === 0 && sawSomething ? NO_RECORDS : undefined;
  return run;
}

async function parseJsonl(ref: SessionRef, prev: ParseState | undefined): Promise<ParseState> {
  const st = await stat(ref.path);
  const prevExtra = prev?.extra as Partial<Extra> | undefined;
  const canResume = !!prev && prevExtra?.format !== 'legacy' && typeof prevExtra?.bad === 'number' && st.size >= prev.offset;
  if (canResume && st.size === prev!.size && st.mtimeMs === prev!.mtimeMs) return prev!;

  const extra: Extra = canResume ? cloneExtra(prev!) : { bad: 0, early: 0 };
  // Qwen runs grow record by record; Gemini runs are rebuilt from the reduced state.
  let qwenRun: ParsedRun | undefined = canResume && extra.format === 'qwen' ? structuredClone(prev!.run) : undefined;

  const onRecord = (r: unknown) => {
    if (!extra.format) {
      if (!isObj(r)) {
        extra.early++;
        return;
      }
      extra.format = sniff(r);
      if (extra.format === 'qwen') {
        extra.qwen = newQwenState();
        qwenRun = startRun(ref);
      } else extra.gemini = newGeminiState();
    }
    if (extra.format === 'qwen') applyQwenRecord(qwenRun!, extra.qwen!, r);
    else applyGeminiRecord(extra.gemini!, r);
  };

  const res = await readJsonl(ref.path, canResume ? prev!.offset : 0, onRecord);
  // The file shrank between our stat and the read (rewritten): start over.
  if (res.restarted && canResume) return parseJsonl(ref, undefined);
  extra.bad += res.bad;
  const run = finish(ref, extra, qwenRun);
  return { offset: res.offset, size: res.size, mtimeMs: res.mtimeMs, run, extra: extra as unknown as Record<string, unknown> };
}

/** Legacy whole-file sessions: re-read only when size or mtime changed. */
async function parseLegacy(ref: SessionRef, prev: ParseState | undefined): Promise<ParseState> {
  const st = await stat(ref.path);
  if (prev && prev.extra.format === 'legacy' && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev;
  // Throws on invalid JSON (e.g. caught mid-rewrite); safeParse reports it and we retry next change.
  const doc = await readJson(ref.path);
  const extra: Extra = { format: 'legacy', gemini: loadLegacyDocument(doc), bad: 0, early: 0 };
  const run = finish(ref, extra, undefined);
  return { offset: st.size, size: st.size, mtimeMs: st.mtimeMs, run, extra: extra as unknown as Record<string, unknown> };
}

async function parse(ref: SessionRef, prev: ParseState | undefined, _ctx: ParseContext): Promise<ParseState> {
  return /\.json$/i.test(ref.path) ? parseLegacy(ref, prev) : parseJsonl(ref, prev);
}

export const geminiAdapter: SourceAdapter = {
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  confidence: 'source',
  note: 'Reads ~/.gemini/tmp/<project>/chats/session-*.jsonl (and legacy .json). Format checked against the Gemini CLI source, not a real install.',
  defaultRoots: geminiRoots,
  discover: discoverGemini,
  parse,
};

export const qwenAdapter: SourceAdapter = {
  id: 'qwen-code',
  displayName: 'Qwen Code',
  confidence: 'source',
  note: 'Reads ~/.qwen/projects/<project>/chats/<session>.jsonl (and legacy tmp/*/chats). Format checked against the Qwen Code source, not a real install.',
  defaultRoots: qwenRoots,
  discover: discoverQwen,
  parse,
};

export const adapters: SourceAdapter[] = [geminiAdapter, qwenAdapter];
