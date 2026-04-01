import type { NostrFilter } from '../types.js';
import type { StorageBackend, StoredEvent, ReplaceDeletionRecord } from './interface.js';
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
  const byKind = new Map<number, Set<string>>();
  const byAuthor = new Map<string, Set<string>>();
  const deletedRecords = new Map<string, { deletedBy: string; deletedAt: number }>();
  const replaceDeletions = new Map<string, ReplaceDeletionRecord>();
  const negativeCache = new Map<string, number>(); // eventId → expiresAt (Date.now based)
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

    const kindIds = byKind.get(kind);
    if (!kindIds || kindIds.size <= budget) return;

    const candidates = Array.from(kindIds)
      .filter((id) => !pinnedIds.has(id))
      .sort((a, b) => (accessTime.get(a) ?? 0) - (accessTime.get(b) ?? 0));

    const toRemove = candidates.slice(0, kindIds.size - budget);
    for (const id of toRemove) {
      removeEvent(id);
    }
  }

  function evictGlobal(): void {
    if (maxEvents === undefined || byId.size <= maxEvents) return;

    const candidates = Array.from(byId.keys())
      .filter((id) => !pinnedIds.has(id))
      .sort((a, b) => (accessTime.get(a) ?? 0) - (accessTime.get(b) ?? 0));

    const toRemove = candidates.slice(0, byId.size - maxEvents);
    for (const id of toRemove) {
      removeEvent(id);
    }
  }

  function removeEvent(eventId: string): void {
    const stored = byId.get(eventId);
    if (!stored) return;
    byId.delete(eventId);
    accessTime.delete(eventId);
    const { kind, pubkey } = stored;

    // Clean kind index
    const kindSet = byKind.get(kind);
    if (kindSet) {
      kindSet.delete(eventId);
      if (kindSet.size === 0) byKind.delete(kind);
    }
    // Clean author index
    const authorSet = byAuthor.get(pubkey);
    if (authorSet) {
      authorSet.delete(eventId);
      if (authorSet.size === 0) byAuthor.delete(pubkey);
    }

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
      byId.set(stored.id, stored);
      touch(stored.id);

      const { kind, pubkey } = stored;

      // Maintain kind index
      let kindSet = byKind.get(kind);
      if (!kindSet) {
        kindSet = new Set();
        byKind.set(kind, kindSet);
      }
      kindSet.add(stored.id);

      // Maintain author index
      let authorSet = byAuthor.get(pubkey);
      if (!authorSet) {
        authorSet = new Set();
        byAuthor.set(pubkey, authorSet);
      }
      authorSet.add(stored.id);

      if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) {
        byReplaceableKey.set(`${kind}:${pubkey}`, stored.id);
      }
      if (kind >= 30000 && kind < 40000) {
        byAddressableKey.set(`${kind}:${pubkey}:${stored._d_tag}`, stored.id);
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

    async getByAddressableKey(
      kind: number,
      pubkey: string,
      dTag: string,
    ): Promise<StoredEvent | null> {
      const id = byAddressableKey.get(`${kind}:${pubkey}:${dTag}`);
      if (!id) return null;
      const stored = byId.get(id) ?? null;
      if (stored) touch(id);
      return stored;
    },

    async query(filter: NostrFilter): Promise<StoredEvent[]> {
      let candidateIds: Iterable<string>;

      const hasKinds = filter.kinds && filter.kinds.length > 0;
      const hasAuthors = filter.authors && filter.authors.length > 0;
      // NIP-01: authors with < 64 chars are prefix matches — can't use exact-key index
      const authorsHasPrefix = hasAuthors && filter.authors!.some((a) => a.length < 64);

      if (hasKinds && hasAuthors && !authorsHasPrefix) {
        const kindCandidates = new Set<string>();
        for (const k of filter.kinds!) {
          const set = byKind.get(k);
          if (set) for (const id of set) kindCandidates.add(id);
        }
        const intersected: string[] = [];
        for (const a of filter.authors!) {
          const set = byAuthor.get(a);
          if (set)
            for (const id of set) {
              if (kindCandidates.has(id)) intersected.push(id);
            }
        }
        candidateIds = intersected;
      } else if (hasKinds) {
        // kinds are always exact match — index is safe
        const union: string[] = [];
        for (const k of filter.kinds!) {
          const set = byKind.get(k);
          if (set) for (const id of set) union.push(id);
        }
        candidateIds = union;
      } else if (hasAuthors && !authorsHasPrefix) {
        const union: string[] = [];
        for (const a of filter.authors!) {
          const set = byAuthor.get(a);
          if (set) for (const id of set) union.push(id);
        }
        candidateIds = union;
      } else {
        // Full scan: no usable index, or prefix authors without kinds
        candidateIds = byId.keys();
      }

      const results: StoredEvent[] = [];
      for (const id of candidateIds) {
        const stored = byId.get(id);
        if (stored && matchesFilter(stored.event, filter)) {
          results.push(stored);
        }
      }

      for (const stored of results) {
        touch(stored.id);
      }

      results.sort((a, b) => b.created_at - a.created_at);

      if (filter.limit !== undefined && filter.limit > 0) {
        return results.slice(0, filter.limit);
      }

      return results;
    },

    async count(filter: NostrFilter): Promise<number> {
      const results = await this.query({ ...filter, limit: undefined });
      return results.length;
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
      byKind.clear();
      byAuthor.clear();
      deletedRecords.clear();
      replaceDeletions.clear();
      negativeCache.clear();
    },

    async markDeleted(eventId: string, deletedBy: string, deletedAt: number): Promise<void> {
      deletedRecords.set(eventId, { deletedBy, deletedAt });
    },

    async isDeleted(eventId: string, pubkey?: string): Promise<boolean> {
      const record = deletedRecords.get(eventId);
      if (!record) return false;
      // If pubkey is provided, check that the deletion was by the same pubkey or by '' (explicit delete)
      if (pubkey !== undefined && record.deletedBy !== '' && record.deletedBy !== pubkey) {
        return false;
      }
      return true;
    },

    async markReplaceDeletion(
      aTagHash: string,
      deletedBy: string,
      deletedAt: number,
    ): Promise<void> {
      const existing = replaceDeletions.get(aTagHash);
      if (!existing || deletedAt > existing.deletedAt) {
        replaceDeletions.set(aTagHash, { aTagHash, deletedBy, deletedAt });
      }
    },

    async getReplaceDeletion(aTagHash: string): Promise<ReplaceDeletionRecord | null> {
      return replaceDeletions.get(aTagHash) ?? null;
    },

    async setNegative(eventId: string, ttl: number): Promise<void> {
      negativeCache.set(eventId, Date.now() + ttl);
    },

    async isNegative(eventId: string): Promise<boolean> {
      const expiresAt = negativeCache.get(eventId);
      if (expiresAt === undefined) return false;
      if (Date.now() >= expiresAt) {
        negativeCache.delete(eventId);
        return false;
      }
      return true;
    },

    async cleanExpiredNegative(): Promise<void> {
      const now = Date.now();
      for (const [id, expiresAt] of negativeCache) {
        if (expiresAt <= now) negativeCache.delete(id);
      }
    },
  };
}
