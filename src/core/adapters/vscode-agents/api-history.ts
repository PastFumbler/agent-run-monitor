// Cline 3.x / Roo Code api_conversation_history.json: Anthropic-style MessageParam[] with extra
// fields (ts, id, modelInfo, metrics). The UI transcript (ui_messages.json) has no tool-call ids,
// so this file supplies them, the tool results and their error flags [source: Cline
// shared/messages/content.ts at v3.89.2; Roo src/core/task-persistence/apiMessages.ts].
//
// Result quirks [source]:
// - Cline prefixes every result with "[<tool> for '<arg>'] Result:" and never sets is_error;
//   failures read "The tool execution failed with the following error: ...".
// - Roo sets is_error only for validation failures; other failures are the JSON text
//   {"status":"error","message":"The tool execution failed",...}.

import { blockText, isObj, looksFailed, nativePath, resultText, str, type Obj } from './common';
import { clip, toMs } from '../../events';

export interface ApiTool {
  id: string;
  name: string;
  input: unknown;
  /** Index of the assistant message holding the call (ui records point at it via conversationHistoryIndex). */
  msgIndex: number;
  ts?: number;
  consumed: boolean;
}

export interface ApiResult {
  text: string;
  isError: boolean;
  ts?: number;
}

export interface ApiIndex {
  tools: ApiTool[];
  results: Map<string, ApiResult>;
  model?: string;
  projectPath?: string;
}

const RESULT_PREFIX = /^\[[^\]\n]{1,300}\] Result:\s*\n?/;
const CWD = /# Current (?:Working|Workspace) Directory \(([^)\n]+)\) Files/;

export function emptyIndex(): ApiIndex {
  return { tools: [], results: new Map() };
}

export function indexApiHistory(messages: unknown): ApiIndex {
  const idx = emptyIndex();
  if (!Array.isArray(messages)) return idx;
  messages.forEach((m, i) => {
    if (!isObj(m)) return;
    const ts = toMs(m.ts);
    const blocks = Array.isArray(m.content) ? m.content.filter(isObj) : [];
    if (m.role === 'assistant') {
      const mi = isObj(m.modelInfo) ? m.modelInfo : undefined;
      if (mi && str(mi.modelId)) idx.model = String(mi.modelId);
      for (const b of blocks) {
        if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          idx.tools.push({ id: b.id, name: b.name, input: b.input, msgIndex: i, ts, consumed: false });
        }
      }
    } else if (m.role === 'user') {
      if (!idx.projectPath) idx.projectPath = cwdOf(m.content);
      for (const b of blocks) if (b.type === 'tool_result') addResult(idx, b, ts);
    }
  });
  return idx;
}

function addResult(idx: ApiIndex, b: Obj, ts: number | undefined): void {
  const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
  if (!id) return;
  const raw = clip(resultText(b.content));
  const text = raw.replace(RESULT_PREFIX, '');
  idx.results.set(id, { text, isError: b.is_error === true || looksFailed(raw), ts });
}

/** The workspace folder from the <environment_details> block of a user message. */
function cwdOf(content: unknown): string | undefined {
  const m = CWD.exec(blockText(content));
  return m ? nativePath(m[1].trim()) : undefined;
}
