import type { NostrFilter } from '../types.js';
import type { StorageBackend, StoredEvent } from './interface.js';
import { matchesFilter } from '../core/filter-matcher.js';
import { memoryBackend as memoryBackendFallback } from './memory.js';

const DB_VERSION = 2;

function openDB(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('events')) {
        const store = db.createObjectStore('events', { keyPath: 'event.id' });
        store.createIndex('pubkey_kind', ['event.pubkey', 'event.kind']);
        store.createIndex('replace_key', ['event.kind', 'event.pubkey', '_d_tag']);
        store.createIndex('kind_created_at', ['event.kind', 'event.created_at']);
        store.createIndex('tag_index', '_tag_index', { multiEntry: true });
      }
      if (!db.objectStoreNames.contains('deleted')) {
        db.createObjectStore('deleted', { keyPath: 'eventId' });
      }
      if (!db.objectStoreNames.contains('negative_cache')) {
        db.createObjectStore('negative_cache', { keyPath: 'eventId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export interface IndexedDBBackendOptions {
  batchWrites?: boolean;
}

export function indexedDBBackend(
  dbName: string,
  options?: IndexedDBBackendOptions,
): StorageBackend {
  // SSR fallback: when indexedDB is not available, use memory backend
  if (typeof indexedDB === 'undefined') {
    return memoryBackendFallback();
  }

  let dbPromise: Promise<IDBDatabase> | null = null;

  function getDB(): Promise<IDBDatabase> {
    if (!dbPromise) dbPromise = openDB(dbName);
    return dbPromise;
  }

  // Batch write buffer
  const writeBuffer: StoredEvent[] = [];
  let flushScheduled = false;
  const flushCallbacks: Array<() => void> = [];

  async function flushWrites(): Promise<void> {
    if (writeBuffer.length === 0) {
      flushScheduled = false;
      return;
    }
    const batch = writeBuffer.splice(0);
    const callbacks = flushCallbacks.splice(0);
    flushScheduled = false;

    try {
      const db = await getDB();
      const tx = db.transaction('events', 'readwrite');
      const store = tx.objectStore('events');
      for (const stored of batch) {
        store.put(stored);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('[auftakt] IndexedDB batch write failed:', err);
    }
    for (const cb of callbacks) cb();
  }

  return {
    async put(stored: StoredEvent): Promise<void> {
      if (options?.batchWrites) {
        return new Promise<void>((resolve) => {
          writeBuffer.push(stored);
          flushCallbacks.push(resolve);
          if (!flushScheduled) {
            flushScheduled = true;
            queueMicrotask(() => void flushWrites());
          }
        });
      }
      try {
        const db = await getDB();
        const tx = db.transaction('events', 'readwrite');
        tx.objectStore('events').put(stored);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (err) {
        console.warn('[auftakt] IndexedDB write failed:', err);
      }
    },

    async get(eventId: string): Promise<StoredEvent | null> {
      const db = await getDB();
      const tx = db.transaction('events', 'readonly');
      const result = await idbRequest(tx.objectStore('events').get(eventId));
      return result ?? null;
    },

    async getByReplaceableKey(kind: number, pubkey: string): Promise<StoredEvent | null> {
      const db = await getDB();
      const tx = db.transaction('events', 'readonly');
      const index = tx.objectStore('events').index('pubkey_kind');
      const result = await idbRequest(index.get([pubkey, kind]));
      return result ?? null;
    },

    async getByAddressableKey(
      kind: number,
      pubkey: string,
      dTag: string,
    ): Promise<StoredEvent | null> {
      const db = await getDB();
      const tx = db.transaction('events', 'readonly');
      const index = tx.objectStore('events').index('replace_key');
      const result = await idbRequest(index.get([kind, pubkey, dTag]));
      return result ?? null;
    },

    async query(filter: NostrFilter): Promise<StoredEvent[]> {
      const db = await getDB();
      const tx = db.transaction('events', 'readonly');
      const store = tx.objectStore('events');

      let rawResults: StoredEvent[];

      // Optimize: tag query via multiEntry index
      const tagKeys = Object.keys(filter).filter((k) => k.startsWith('#'));
      if (tagKeys.length > 0) {
        const tagName = tagKeys[0].slice(1);
        const values = filter[tagKeys[0] as `#${string}`] ?? [];
        if (values.length > 0) {
          const index = store.index('tag_index');
          const allResults: StoredEvent[] = [];
          for (const v of values) {
            const partial = await idbRequest(index.getAll(`${tagName}:${v}`));
            allResults.push(...partial);
          }
          const seen = new Set<string>();
          rawResults = allResults.filter((s) => {
            if (seen.has(s.event.id)) return false;
            seen.add(s.event.id);
            return true;
          });
        } else {
          rawResults = await idbRequest(store.getAll());
        }
      } else if (filter.kinds && filter.kinds.length === 1) {
        // Optimize: single kind via kind_created_at index
        const index = store.index('kind_created_at');
        const kind = filter.kinds[0];
        const range = IDBKeyRange.bound([kind, 0], [kind, Infinity]);
        rawResults = await idbRequest(index.getAll(range));
      } else {
        rawResults = await idbRequest(store.getAll());
      }

      let results = rawResults.filter((s) => matchesFilter(s.event, filter));
      results.sort((a, b) => b.event.created_at - a.event.created_at);
      if (filter.limit && filter.limit > 0) {
        results = results.slice(0, filter.limit);
      }
      return results;
    },

    async delete(eventId: string): Promise<void> {
      const db = await getDB();
      const tx = db.transaction('events', 'readwrite');
      tx.objectStore('events').delete(eventId);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async getAllEventIds(): Promise<string[]> {
      const db = await getDB();
      const tx = db.transaction('events', 'readonly');
      const keys = await idbRequest(tx.objectStore('events').getAllKeys());
      return keys as string[];
    },

    async clear(): Promise<void> {
      const db = await getDB();
      const tx = db.transaction(['events', 'deleted', 'negative_cache'], 'readwrite');
      tx.objectStore('events').clear();
      tx.objectStore('deleted').clear();
      tx.objectStore('negative_cache').clear();
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async markDeleted(eventId: string, deletionEventId: string): Promise<void> {
      try {
        const db = await getDB();
        const tx = db.transaction('deleted', 'readwrite');
        tx.objectStore('deleted').put({
          eventId,
          deletedBy: deletionEventId,
          deletedAt: Date.now(),
        });
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (err) {
        console.warn('[auftakt] IndexedDB markDeleted failed:', err);
      }
    },

    async isDeleted(eventId: string): Promise<boolean> {
      try {
        const db = await getDB();
        const tx = db.transaction('deleted', 'readonly');
        const result = await idbRequest(tx.objectStore('deleted').get(eventId));
        return result !== undefined;
      } catch {
        return false;
      }
    },

    async setNegative(eventId: string, expiresAt: number): Promise<void> {
      try {
        const db = await getDB();
        const tx = db.transaction('negative_cache', 'readwrite');
        tx.objectStore('negative_cache').put({ eventId, expiresAt });
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (err) {
        console.warn('[auftakt] IndexedDB setNegative failed:', err);
      }
    },

    async isNegative(eventId: string): Promise<boolean> {
      try {
        const db = await getDB();
        const tx = db.transaction('negative_cache', 'readonly');
        const result = await idbRequest(tx.objectStore('negative_cache').get(eventId));
        if (!result) return false;
        if (Date.now() >= result.expiresAt) return false;
        return true;
      } catch {
        return false;
      }
    },
  };
}
