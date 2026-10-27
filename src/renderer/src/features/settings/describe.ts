// Plain-words helpers for the settings screen and the first-run wizard. Pure (no React, no store) so
// they can be unit-tested: labels for choices, the "why is this on" sentences for the two motion
// settings, source/folder list edits and the detection summary.

import type { PowerState, UpdateInfo } from '@shared/ipc';
import { AGENT_IDS, type AgentId, type SourceStatus } from '@shared/schema';
import type { SourceSettings, TriState } from '@shared/settings';

export type Confidence = SourceStatus['confidence'];

/** Badge text and the plain-words explanation for each adapter confidence level. */
export const CONFIDENCE: Record<Confidence, { label: string; explain: string }> = {
  verified: { label: 'Verified', explain: 'Verified on a real install' },
  source: { label: 'Source-checked', explain: "Checked against the tool's source code" },
  'best-effort': { label: 'Experimental', explain: 'Best effort — experimental' },
};

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? word : many}`;
}

export function refreshLabel(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

export function historyLabel(days: number): string {
  if (days <= 0) return 'All';
  if (days === 7) return '1 week';
  if (days === 14) return '2 weeks';
  return plural(days, 'day');
}

/**
 * Why low-GPU mode is on or off right now. `effective` is the motion policy's answer; the sentence
 * explains it from the setting and the power state.
 */
export function lowGpuStateText(setting: TriState, power: PowerState | null, effective: boolean): string {
  const state = effective ? 'ON' : 'OFF';
  if (setting === 'on') return `Low GPU mode is currently ${state} because you turned it on.`;
  if (setting === 'off') return `Low GPU mode is currently ${state} because you turned it off.`;
  if (effective) {
    if (power?.onBattery) return "Low GPU mode is currently ON because you're on battery.";
    if (power?.powerSaver) return 'Low GPU mode is currently ON because energy saver is on.';
    return 'Low GPU mode is currently ON.';
  }
  if (!power || !power.known) {
    return "Low GPU mode is currently OFF: this computer doesn't say whether it's on battery, so Auto stays off.";
  }
  return "Low GPU mode is currently OFF because you're plugged in.";
}

/** Why motion is reduced or not right now. `effective` is the motion policy's `reduce`. */
export function reduceMotionStateText(setting: TriState, effective: boolean): string {
  if (setting === 'on') return 'Motion is currently reduced because you turned this on.';
  if (setting === 'off') return 'Motion is currently on because you turned this off (your system setting is ignored).';
  return effective
    ? 'Motion is currently reduced because your system asks for less motion.'
    : "Motion is currently on: your system doesn't ask for less motion.";
}

/** One sentence for the result of "Check now". */
export function updateResultText(info: UpdateInfo): string {
  if (info.error) return info.error;
  if (info.latest && info.latest !== info.current) return `Version ${info.latest} is available (you have ${info.current}).`;
  return `You're up to date (version ${info.current}).`;
}

/** A full sources record with one agent changed (full records merge the same way everywhere). */
export function patchSource(
  sources: Record<AgentId, SourceSettings>,
  agent: AgentId,
  patch: Partial<SourceSettings>,
): Record<AgentId, SourceSettings> {
  const next = {} as Record<AgentId, SourceSettings>;
  for (const id of AGENT_IDS) {
    const cur = sources[id] ?? { enabled: true, customRoots: [] };
    next[id] = id === agent ? { ...cur, ...patch, customRoots: [...(patch.customRoots ?? cur.customRoots)] } : { ...cur, customRoots: [...cur.customRoots] };
  }
  return next;
}

/** Adds a folder unless it is empty or already listed (same path, ignoring a trailing slash). */
export function addFolder(list: string[], folder: string | null | undefined): string[] {
  const f = (folder ?? '').trim();
  if (!f) return list;
  const norm = (p: string) => p.replace(/[\\/]+$/, '');
  if (list.some((p) => norm(p) === norm(f))) return list;
  return [...list, f];
}

export function removeFolder(list: string[], folder: string): string[] {
  return list.filter((p) => p !== folder);
}

/** Something is at one of the places this agent writes to. */
export function isFound(s: SourceStatus): boolean {
  return s.runCount > 0 || s.defaultRoots.some((r) => r.exists) || s.customRoots.some((r) => r.exists);
}

/** "We found N runs from K agents": runs across found agents, and the agents with at least one run. */
export function detectionSummary(list: SourceStatus[]): { runs: number; agents: number; text: string } {
  const withRuns = list.filter((s) => s.runCount > 0);
  const runs = withRuns.reduce((n, s) => n + s.runCount, 0);
  const agents = withRuns.length;
  const text =
    runs === 0
      ? 'We found no runs yet. That is fine: start a session in any supported agent and it appears here within seconds.'
      : `We found ${plural(runs, 'run')} from ${plural(agents, 'agent')}.`;
  return { runs, agents, text };
}
