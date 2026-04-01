import Dexie from 'dexie';
import { liveQuery } from 'dexie';
import type { Table } from 'dexie';
import { Observable } from 'rxjs';
import type { CachedEvent, NostrFilter } from '../../src/types.js';
import type { StoredEvent } from '../../src/backends/interface.js';
import { matchesFilter } from '../../src/core/filter-matcher.js';
import { isExpired } from '../../src/core/nip-rules.js';

/**
 * Open a Dexie instance pointing at the same DB used by dexieBackend.
 * liveQuery requires direct Dexie Table access for change tracking.
 */
class BenchDB extends Dexie {
  events!: Table<StoredEvent, string>;

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

/**
 * Config B: Pure liveQuery — re-runs full query on every DB change.
 * Connects directly to the Dexie DB (required for liveQuery change tracking).
 */
export function liveQueryObservable(
  dbName: string,
  filter: NostrFilter,
): Observable<CachedEvent[]> {
  const db = new BenchDB(dbName);

  const dexieObs = liveQuery(async () => {
    let results: StoredEvent[];

    if (filter.kinds?.length) {
      const allResults: StoredEvent[] = [];
      for (const kind of filter.kinds) {
        const partial = await db.events
          .where('[kind+created_at]')
          .between([kind, filter.since ?? -Infinity], [kind, filter.until ?? Infinity], true, true)
          .toArray();
        allResults.push(...partial);
      }
      results = allResults;
    } else {
      results = await db.events.orderBy('created_at').toArray();
    }

    const now = Math.floor(Date.now() / 1000);
    return results
      .filter((s) => matchesFilter(s.event, filter))
      .filter((s) => !isExpired(s.event, now))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, filter.limit ?? Infinity)
      .map(
        (s): CachedEvent => ({
          event: s.event,
          seenOn: s.seenOn,
          firstSeen: s.firstSeen,
        }),
      );
  });

  return new Observable<CachedEvent[]>((subscriber) => {
    const sub = dexieObs.subscribe({
      next: (val) => subscriber.next(val),
      error: (err) => subscriber.error(err),
    });
    return () => {
      sub.unsubscribe();
      db.close();
    };
  });
}

/**
 * Config C: liveQuery + 16ms debounce (RAF-equivalent).
 */
export function liveQueryDebouncedObservable(
  dbName: string,
  filter: NostrFilter,
  debounceMs = 16,
): Observable<CachedEvent[]> {
  const db = new BenchDB(dbName);

  const dexieObs = liveQuery(async () => {
    let results: StoredEvent[];

    if (filter.kinds?.length) {
      const allResults: StoredEvent[] = [];
      for (const kind of filter.kinds) {
        const partial = await db.events
          .where('[kind+created_at]')
          .between([kind, filter.since ?? -Infinity], [kind, filter.until ?? Infinity], true, true)
          .toArray();
        allResults.push(...partial);
      }
      results = allResults;
    } else {
      results = await db.events.orderBy('created_at').toArray();
    }

    const now = Math.floor(Date.now() / 1000);
    return results
      .filter((s) => matchesFilter(s.event, filter))
      .filter((s) => !isExpired(s.event, now))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, filter.limit ?? Infinity)
      .map(
        (s): CachedEvent => ({
          event: s.event,
          seenOn: s.seenOn,
          firstSeen: s.firstSeen,
        }),
      );
  });

  return new Observable<CachedEvent[]>((subscriber) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latest: CachedEvent[] | null = null;

    const sub = dexieObs.subscribe({
      next: (val) => {
        latest = val;
        if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            if (latest !== null) {
              subscriber.next(latest);
              latest = null;
            }
          }, debounceMs);
        }
      },
      error: (err) => subscriber.error(err),
    });

    return () => {
      if (timer) clearTimeout(timer);
      sub.unsubscribe();
      db.close();
    };
  });
}
