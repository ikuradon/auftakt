import type { NostrFilter } from '../types.js';
import type { StorageBackend, StoredEvent } from './interface.js';
import { matchesFilter } from '../core/filter-matcher.js';

const DB_VERSION = 1;

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

export function indexedDBBackend(dbName: string): StorageBackend {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function getDB(): Promise<IDBDatabase> {
    if (!dbPromise) dbPromise = openDB(dbName);
    return dbPromise;
  }

  return {
    async put(stored: StoredEvent): Promise<void> {
      const db = await getDB();
      const tx = db.transaction('events', 'readwrite');
      tx.objectStore('events').put(stored);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
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

    async getByAddressableKey(kind: number, pubkey: string, dTag: string): Promise<StoredEvent | null> {
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
      const tagKeys = Object.keys(filter).filter(k => k.startsWith('#'));
      if (tagKeys.length > 0) {
        const tagName = tagKeys[0].slice(1);
        const values = filter[tagKeys[0] as `#${string}`] ?? [];
        if (values.length > 0) {
          const index = store.index('tag_index');
          rawResults = await idbRequest(index.getAll(`${tagName}:${values[0]}`));
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

      let results = rawResults.filter(s => matchesFilter(s.event, filter));
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
      const tx = db.transaction('events', 'readwrite');
      tx.objectStore('events').clear();
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}
