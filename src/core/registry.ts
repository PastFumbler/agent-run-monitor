// The set of source adapters the store runs. The registry itself is just a validated list, so
// tests can build one from fake adapters; the real list lives in all-adapters.ts.

import type { AgentId } from '@shared/schema';
import type { SourceAdapter } from './adapter';

export interface Registry {
  /** Every adapter, in registration order. */
  all(): SourceAdapter[];
  get(id: AgentId | string): SourceAdapter | undefined;
  ids(): AgentId[];
}

function isAdapter(a: unknown): a is SourceAdapter {
  const x = a as SourceAdapter;
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.displayName === 'string' &&
    typeof x.defaultRoots === 'function' &&
    typeof x.discover === 'function' &&
    typeof x.parse === 'function'
  );
}

/**
 * Builds a registry. Anything that is not a well-formed adapter is skipped, and a second adapter
 * with an id already taken is ignored (the first wins), so one broken module cannot break the rest.
 */
export function createRegistry(adapters: readonly unknown[], warn: (msg: string) => void = () => {}): Registry {
  const byId = new Map<string, SourceAdapter>();
  for (const a of adapters) {
    if (!isAdapter(a)) {
      warn('skipped a malformed source adapter');
      continue;
    }
    if (byId.has(a.id)) {
      warn(`skipped a second adapter for ${a.id}`);
      continue;
    }
    byId.set(a.id, a);
  }
  const list = [...byId.values()];
  return {
    all: () => list,
    get: (id) => byId.get(id),
    ids: () => list.map((a) => a.id),
  };
}
