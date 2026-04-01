import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { NostrFilter } from '../types.js';
import type {
  StorageBackend,
  StoredEvent,
  DeletedRecord,
  ReplaceDeletionRecord,
} from './interface.js';
import { matchesFilter } from '../core/filter-matcher.js';

interface NegativeCacheRecord {
  eventId: string;
  expiresAt: number;
}

class AuftaktDB extends Dexie {
  events!: Table<StoredEvent, string>;
  deleted!: Table<DeletedRecord, string>;
  replaceDeletion!: Table<ReplaceDeletionRecord, string>;
  negativeCache!: Table<NegativeCacheRecord, string>;

  constructor(dbName: string) {
    super(dbName);
    this.version(1).stores({
      events:
        'id, created_at, pubkey, [kind+created_at], [pubkey+kind], [kind+pubkey+_d_tag], *_tag_index',
      deleted: 'eventId',
      replaceDeletion: 'aTagHash',
      negativeCache: 'eventId, expiresAt',
    });
  }
}

export interface DexieBackendOptions {
  dbName?: string;
}

export function dexieBackend(options?: DexieBackendOptions): StorageBackend {
  if (typeof indexedDB === 'undefined') {
    throw new Error('[auftakt] dexieBackend requires indexedDB. Use memoryBackend for SSR.');
  }

  const dbName = options?.dbName ?? 'auftakt';
  const db = new AuftaktDB(dbName);

  async function queryWithHeuristic(filter: NostrFilter): Promise<StoredEvent[]> {
    const hasIds = filter.ids && filter.ids.length > 0;
    const tagKeys = Object.keys(filter).filter((k) => k.startsWith('#'));
    const hasTags = tagKeys.length > 0;
    const hasAuthors = filter.authors && filter.authors.length > 0;
    const hasKinds = filter.kinds && filter.kinds.length > 0;
    const authorsHasPrefix = hasAuthors && filter.authors!.some((a) => a.length < 64);

    let candidates: StoredEvent[];

    // Priority 1: ids → PK direct lookup
    if (hasIds) {
      const results = await db.events.bulkGet(filter.ids!);
      candidates = results.filter((r): r is StoredEvent => r !== undefined);
    }
    // Priority 2: tags → multiEntry index
    else if (hasTags) {
      const tagName = tagKeys[0].slice(1);
      const values = filter[tagKeys[0] as `#${string}`] ?? [];
      if (values.length > 0) {
        const allResults: StoredEvent[] = [];
        for (const v of values) {
          const partial = await db.events.where('_tag_index').equals(`${tagName}:${v}`).toArray();
          allResults.push(...partial);
        }
        // Deduplicate
        const seen = new Set<string>();
        candidates = allResults.filter((s) => {
          if (seen.has(s.id)) return false;
          seen.add(s.id);
          return true;
        });
      } else {
        candidates = await db.events.toArray();
      }
    }
    // Priority 3: authors + kinds compound (no prefix)
    else if (hasAuthors && hasKinds && !authorsHasPrefix) {
      const allResults: StoredEvent[] = [];
      for (const pubkey of filter.authors!) {
        for (const kind of filter.kinds!) {
          const partial = await db.events.where('[pubkey+kind]').equals([pubkey, kind]).toArray();
          allResults.push(...partial);
        }
      }
      candidates = allResults;
    }
    // Priority 4: authors only
    else if (hasAuthors) {
      if (authorsHasPrefix) {
        // Prefix search on pubkey index
        const allResults: StoredEvent[] = [];
        for (const author of filter.authors!) {
          if (author.length < 64) {
            const partial = await db.events.where('pubkey').startsWith(author).toArray();
            allResults.push(...partial);
          } else {
            const partial = await db.events.where('pubkey').equals(author).toArray();
            allResults.push(...partial);
          }
        }
        // Deduplicate
        const seen = new Set<string>();
        candidates = allResults.filter((s) => {
          if (seen.has(s.id)) return false;
          seen.add(s.id);
          return true;
        });
      } else {
        const allResults: StoredEvent[] = [];
        for (const author of filter.authors!) {
          const partial = await db.events.where('pubkey').equals(author).toArray();
          allResults.push(...partial);
        }
        candidates = allResults;
      }
    }
    // Priority 5: kinds only
    else if (hasKinds) {
      const allResults: StoredEvent[] = [];
      for (const kind of filter.kinds!) {
        let collection = db.events.where('[kind+created_at]');

        const lower = [kind, filter.since ?? -Infinity];
        const upper = [kind, filter.until ?? Infinity];

        const partial = await collection.between(lower, upper, true, true).toArray();
        allResults.push(...partial);
      }
      candidates = allResults;
    }
    // Priority 6: fallback
    else {
      candidates = await db.events.orderBy('created_at').toArray();
    }

    // Post-filter ALL results with matchesFilter for correctness
    const filtered = candidates.filter((stored) => matchesFilter(stored.event, filter));

    // Sort by created_at descending
    filtered.sort((a, b) => b.created_at - a.created_at);

    // Apply limit
    if (filter.limit !== undefined && filter.limit > 0) {
      return filtered.slice(0, filter.limit);
    }

    return filtered;
  }

  return {
    async put(stored: StoredEvent): Promise<void> {
      await db.events.put(stored);
    },

    async get(eventId: string): Promise<StoredEvent | null> {
      return (await db.events.get(eventId)) ?? null;
    },

    async getByReplaceableKey(kind: number, pubkey: string): Promise<StoredEvent | null> {
      return (await db.events.where('[pubkey+kind]').equals([pubkey, kind]).first()) ?? null;
    },

    async getByAddressableKey(
      kind: number,
      pubkey: string,
      dTag: string,
    ): Promise<StoredEvent | null> {
      return (
        (await db.events.where('[kind+pubkey+_d_tag]').equals([kind, pubkey, dTag]).first()) ?? null
      );
    },

    async query(filter: NostrFilter): Promise<StoredEvent[]> {
      return queryWithHeuristic(filter);
    },

    async count(filter: NostrFilter): Promise<number> {
      const results = await queryWithHeuristic({ ...filter, limit: undefined });
      return results.length;
    },

    async delete(eventId: string): Promise<void> {
      await db.events.delete(eventId);
    },

    async getAllEventIds(): Promise<string[]> {
      return db.events.toCollection().primaryKeys();
    },

    async clear(): Promise<void> {
      await db.transaction(
        'rw',
        [db.events, db.deleted, db.replaceDeletion, db.negativeCache],
        async () => {
          await db.events.clear();
          await db.deleted.clear();
          await db.replaceDeletion.clear();
          await db.negativeCache.clear();
        },
      );
    },

    async markDeleted(eventId: string, deletedBy: string, deletedAt: number): Promise<void> {
      await db.deleted.put({ eventId, deletedBy, deletedAt });
    },

    async isDeleted(eventId: string, pubkey?: string): Promise<boolean> {
      const record = await db.deleted.get(eventId);
      if (!record) return false;
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
      const existing = await db.replaceDeletion.get(aTagHash);
      if (!existing || deletedAt > existing.deletedAt) {
        await db.replaceDeletion.put({ aTagHash, deletedBy, deletedAt });
      }
    },

    async getReplaceDeletion(aTagHash: string): Promise<ReplaceDeletionRecord | null> {
      return (await db.replaceDeletion.get(aTagHash)) ?? null;
    },

    async setNegative(eventId: string, ttl: number): Promise<void> {
      await db.negativeCache.put({ eventId, expiresAt: Date.now() + ttl });
    },

    async isNegative(eventId: string): Promise<boolean> {
      const record = await db.negativeCache.get(eventId);
      if (!record) return false;
      if (Date.now() >= record.expiresAt) {
        return false;
      }
      return true;
    },

    async cleanExpiredNegative(): Promise<void> {
      const now = Date.now();
      await db.negativeCache
        .where('expiresAt')
        .below(now + 1)
        .delete();
    },

    async dispose(): Promise<void> {
      db.close();
    },
  };
}
