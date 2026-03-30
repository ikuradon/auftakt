import type { NostrFilter } from '../types.js';
import type { StorageBackend, StoredEvent } from './interface.js';
import { matchesFilter } from '../core/filter-matcher.js';

export function memoryBackend(): StorageBackend {
  const byId = new Map<string, StoredEvent>();
  const byReplaceableKey = new Map<string, string>();
  const byAddressableKey = new Map<string, string>();

  return {
    async put(stored: StoredEvent): Promise<void> {
      const { event } = stored;
      byId.set(event.id, stored);

      const { kind, pubkey } = event;
      if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) {
        byReplaceableKey.set(`${kind}:${pubkey}`, event.id);
      }
      if (kind >= 30000 && kind < 40000) {
        byAddressableKey.set(`${kind}:${pubkey}:${stored._d_tag}`, event.id);
      }
    },

    async get(eventId: string): Promise<StoredEvent | null> {
      return byId.get(eventId) ?? null;
    },

    async getByReplaceableKey(kind: number, pubkey: string): Promise<StoredEvent | null> {
      const id = byReplaceableKey.get(`${kind}:${pubkey}`);
      return id ? (byId.get(id) ?? null) : null;
    },

    async getByAddressableKey(kind: number, pubkey: string, dTag: string): Promise<StoredEvent | null> {
      const id = byAddressableKey.get(`${kind}:${pubkey}:${dTag}`);
      return id ? (byId.get(id) ?? null) : null;
    },

    async query(filter: NostrFilter): Promise<StoredEvent[]> {
      let results: StoredEvent[] = [];

      for (const stored of byId.values()) {
        if (!matchesFilter(stored.event, filter)) continue;

        // Additional tag index check for # filters
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

      results.sort((a, b) => b.event.created_at - a.event.created_at);

      if (filter.limit !== undefined && filter.limit > 0) {
        results = results.slice(0, filter.limit);
      }

      return results;
    },

    async delete(eventId: string): Promise<void> {
      const stored = byId.get(eventId);
      if (!stored) return;
      byId.delete(eventId);
      const { kind, pubkey } = stored.event;
      if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) {
        const key = `${kind}:${pubkey}`;
        if (byReplaceableKey.get(key) === eventId) byReplaceableKey.delete(key);
      }
      if (kind >= 30000 && kind < 40000) {
        const key = `${kind}:${pubkey}:${stored._d_tag}`;
        if (byAddressableKey.get(key) === eventId) byAddressableKey.delete(key);
      }
    },

    async getAllEventIds(): Promise<string[]> {
      return Array.from(byId.keys());
    },

    async clear(): Promise<void> {
      byId.clear();
      byReplaceableKey.clear();
      byAddressableKey.clear();
    },
  };
}
