import type { NostrFilter } from '../types.js';
import type { StorageBackend, StoredEvent } from './interface.js';
import { matchesFilter } from '../core/filter-matcher.js';

const DEFAULT_BUDGETS: Record<number, number> = {
  0: 5000,
  1: 30000,
  7: 10000,
};
const DEFAULT_BUDGET_FALLBACK = 5000;

export interface MemoryBackendOptions {
  maxEvents?: number;
  eviction?: {
    strategy: 'lru';
    budgets?: Record<number | 'default', { max: number }>;
  };
}

export interface MemoryBackend extends StorageBackend {
  setPinnedIds(ids: Set<string>): void;
}

export function memoryBackend(options?: MemoryBackendOptions): MemoryBackend {
  const byId = new Map<string, StoredEvent>();
  const byReplaceableKey = new Map<string, string>();
  const byAddressableKey = new Map<string, string>();
  const accessTime = new Map<string, number>();
  let pinnedIds = new Set<string>();
  let accessCounter = 0;

  const maxEvents = options?.maxEvents;
  const userBudgets = options?.eviction?.budgets;

  function getBudget(kind: number): number | undefined {
    if (!options?.eviction) return undefined;
    if (userBudgets) {
      const kindBudget = userBudgets[kind as keyof typeof userBudgets];
      if (kindBudget && typeof kindBudget === 'object' && 'max' in kindBudget) {
        return kindBudget.max;
      }
      const defaultBudget = userBudgets['default' as keyof typeof userBudgets];
      if (defaultBudget && typeof defaultBudget === 'object' && 'max' in defaultBudget) {
        return defaultBudget.max;
      }
    }
    return DEFAULT_BUDGETS[kind] ?? DEFAULT_BUDGET_FALLBACK;
  }

  function touch(eventId: string): void {
    accessTime.set(eventId, ++accessCounter);
  }

  function evictKind(kind: number): void {
    const budget = getBudget(kind);
    if (budget === undefined) return;

    const kindEvents: string[] = [];
    for (const [id, stored] of byId) {
      if (stored.event.kind === kind) kindEvents.push(id);
    }

    if (kindEvents.length <= budget) return;

    const candidates = kindEvents
      .filter(id => !pinnedIds.has(id))
      .sort((a, b) => (accessTime.get(a) ?? 0) - (accessTime.get(b) ?? 0));

    const toRemove = candidates.slice(0, kindEvents.length - budget);
    for (const id of toRemove) {
      removeEvent(id);
    }
  }

  function evictGlobal(): void {
    if (maxEvents === undefined) return;
    while (byId.size > maxEvents) {
      const candidates = Array.from(byId.keys())
        .filter(id => !pinnedIds.has(id))
        .sort((a, b) => (accessTime.get(a) ?? 0) - (accessTime.get(b) ?? 0));

      if (candidates.length === 0) break; // all pinned
      removeEvent(candidates[0]);
    }
  }

  function removeEvent(eventId: string): void {
    const stored = byId.get(eventId);
    if (!stored) return;
    byId.delete(eventId);
    accessTime.delete(eventId);
    const { kind, pubkey } = stored.event;
    if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) {
      const key = `${kind}:${pubkey}`;
      if (byReplaceableKey.get(key) === eventId) byReplaceableKey.delete(key);
    }
    if (kind >= 30000 && kind < 40000) {
      const key = `${kind}:${pubkey}:${stored._d_tag}`;
      if (byAddressableKey.get(key) === eventId) byAddressableKey.delete(key);
    }
  }

  function runEviction(newEventKind?: number): void {
    if (newEventKind !== undefined) {
      evictKind(newEventKind);
    }
    if (maxEvents !== undefined) {
      evictGlobal();
    }
  }

  return {
    setPinnedIds(ids: Set<string>): void {
      pinnedIds = ids;
    },

    async put(stored: StoredEvent): Promise<void> {
      const { event } = stored;
      byId.set(event.id, stored);
      touch(event.id);

      const { kind, pubkey } = event;
      if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) {
        byReplaceableKey.set(`${kind}:${pubkey}`, event.id);
      }
      if (kind >= 30000 && kind < 40000) {
        byAddressableKey.set(`${kind}:${pubkey}:${stored._d_tag}`, event.id);
      }

      runEviction(kind);
    },

    async get(eventId: string): Promise<StoredEvent | null> {
      const stored = byId.get(eventId) ?? null;
      if (stored) touch(eventId);
      return stored;
    },

    async getByReplaceableKey(kind: number, pubkey: string): Promise<StoredEvent | null> {
      const id = byReplaceableKey.get(`${kind}:${pubkey}`);
      if (!id) return null;
      const stored = byId.get(id) ?? null;
      if (stored) touch(id);
      return stored;
    },

    async getByAddressableKey(kind: number, pubkey: string, dTag: string): Promise<StoredEvent | null> {
      const id = byAddressableKey.get(`${kind}:${pubkey}:${dTag}`);
      if (!id) return null;
      const stored = byId.get(id) ?? null;
      if (stored) touch(id);
      return stored;
    },

    async query(filter: NostrFilter): Promise<StoredEvent[]> {
      let results: StoredEvent[] = [];

      for (const stored of byId.values()) {
        if (!matchesFilter(stored.event, filter)) continue;

        let tagMatch = true;
        for (const key of Object.keys(filter)) {
          if (!key.startsWith('#')) continue;
          const tagName = key.slice(1);
          const values = filter[key as `#${string}`];
          if (!values || values.length === 0) continue;
          const tagKeys = values.map(v => `${tagName}:${v}`);
          if (!stored._tag_index.some(ti => tagKeys.includes(ti))) {
            tagMatch = false;
            break;
          }
        }
        if (!tagMatch) continue;

        results.push(stored);
      }

      // Touch all results
      for (const stored of results) {
        touch(stored.event.id);
      }

      results.sort((a, b) => b.event.created_at - a.event.created_at);

      if (filter.limit !== undefined && filter.limit > 0) {
        results = results.slice(0, filter.limit);
      }

      return results;
    },

    async delete(eventId: string): Promise<void> {
      removeEvent(eventId);
    },

    async getAllEventIds(): Promise<string[]> {
      return Array.from(byId.keys());
    },

    async clear(): Promise<void> {
      byId.clear();
      byReplaceableKey.clear();
      byAddressableKey.clear();
      accessTime.clear();
    },
  };
}
