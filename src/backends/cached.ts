import type { NostrFilter } from '../types.js';
import type { StorageBackend, StoredEvent } from './interface.js';
import { memoryBackend as createMemoryBackend } from './memory.js';

export interface CachedBackendOptions {
  maxCached: number;
}

/**
 * Read-through cache wrapper for any StorageBackend.
 * - put(): write-through (both cache + inner)
 * - get(): cache first, miss → inner → populate cache
 * - query(): always inner (results populate cache)
 * - delete(): both cache + inner
 */
export function cachedBackend(
  inner: StorageBackend,
  options: CachedBackendOptions,
): StorageBackend {
  const cache = createMemoryBackend({ maxEvents: options.maxCached });

  return {
    async put(stored: StoredEvent): Promise<void> {
      await Promise.all([cache.put(stored), inner.put(stored)]);
    },

    async get(eventId: string): Promise<StoredEvent | null> {
      // Cache hit
      const cached = await cache.get(eventId);
      if (cached) return cached;

      // Cache miss → inner
      const fromInner = await inner.get(eventId);
      if (fromInner) {
        await cache.put(fromInner);
      }
      return fromInner;
    },

    async getByReplaceableKey(kind: number, pubkey: string): Promise<StoredEvent | null> {
      const cached = await cache.getByReplaceableKey(kind, pubkey);
      if (cached) return cached;

      const fromInner = await inner.getByReplaceableKey(kind, pubkey);
      if (fromInner) {
        await cache.put(fromInner);
      }
      return fromInner;
    },

    async getByAddressableKey(
      kind: number,
      pubkey: string,
      dTag: string,
    ): Promise<StoredEvent | null> {
      const cached = await cache.getByAddressableKey(kind, pubkey, dTag);
      if (cached) return cached;

      const fromInner = await inner.getByAddressableKey(kind, pubkey, dTag);
      if (fromInner) {
        await cache.put(fromInner);
      }
      return fromInner;
    },

    async query(filter: NostrFilter): Promise<StoredEvent[]> {
      // Always query inner for completeness
      const results = await inner.query(filter);

      // Populate cache with results
      for (const stored of results) {
        await cache.put(stored);
      }

      return results;
    },

    async delete(eventId: string): Promise<void> {
      await Promise.all([cache.delete(eventId), inner.delete(eventId)]);
    },

    async getAllEventIds(): Promise<string[]> {
      return inner.getAllEventIds();
    },

    async clear(): Promise<void> {
      await Promise.all([cache.clear(), inner.clear()]);
    },
  };
}
