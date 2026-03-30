import { Subject, Observable, BehaviorSubject, firstValueFrom, race, timer, EMPTY } from 'rxjs';
import { take, map, filter as rxFilter, catchError } from 'rxjs/operators';
import type {
  NostrEvent,
  CachedEvent,
  AddResult,
  StoreChange,
  EventMeta,
  NostrFilter,
} from '../types.js';
import type { StorageBackend, StoredEvent } from '../backends/interface.js';
import {
  classifyEvent,
  isExpired,
  getDTag,
  compareEventsForReplacement,
} from './nip-rules.js';
import { QueryManager } from './query-manager.js';
import { createNegativeCache, type NegativeCache } from './negative-cache.js';

export interface EventStoreOptions {
  backend: StorageBackend;
}

export interface FetchByIdOptions {
  /**
   * Fetch function that retrieves an event from relays.
   * Expected to return a Promise resolving to { event, relay } or null.
   * Example with rx-nostr:
   * ```
   * fetch: (id) => fetchEventFromRelay(rxNostr, id)
   * ```
   */
  fetch?: (eventId: string) => Promise<{ event: NostrEvent; relay: string } | null>;
  /** @deprecated Use `fetch` instead. Kept for convenience — internally creates a oneshot REQ. */
  rxNostr?: { use(req: any, options?: any): Observable<any> };
  relayHint?: string;
  timeout?: number;
  negativeTTL?: number;
}

export interface EventStore {
  add(event: NostrEvent, meta?: EventMeta): Promise<AddResult>;
  query(filter: NostrFilter): Observable<CachedEvent[]>;
  fetchById(eventId: string, options?: FetchByIdOptions): Promise<CachedEvent | null>;
  changes$: Observable<StoreChange>;
}

function fetchFromRelay(
  rxNostr: { use(req: any, options?: any): Observable<any> },
  eventId: string,
  timeout: number,
  relayHint?: string,
): Promise<{ event: NostrEvent; relay: string } | null> {
  return new Promise<{ event: NostrEvent; relay: string } | null>((resolve) => {
    const reqPacketSubject = new BehaviorSubject<any>(null);
    let resolved = false;

    const useOptions = relayHint ? { on: { relays: [relayHint] } } : undefined;

    const subscription = rxNostr.use({
      strategy: 'backward' as const,
      rxReqId: `auftakt-fetch-${eventId}-${Date.now()}`,
      getReqPacketObservable() {
        return reqPacketSubject.asObservable();
      },
    }, useOptions).subscribe({
      next: (packet: any) => {
        if (!resolved && packet.event?.id === eventId) {
          resolved = true;
          subscription.unsubscribe();
          resolve({ event: packet.event, relay: packet.from });
        }
      },
      complete: () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      },
      error: () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      },
    });

    reqPacketSubject.next({ filters: [{ ids: [eventId] }] });
    reqPacketSubject.complete();

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        subscription.unsubscribe();
        resolve(null);
      }
    }, timeout);
  });
}

export function createEventStore(options: EventStoreOptions): EventStore {
  const { backend } = options;
  const deletedIds = new Set<string>();
  const pendingDeletions = new Map<string, { pubkey: string; registeredAt: number }>();
  const changeSubject = new Subject<StoreChange>();
  const queryManager = new QueryManager(deletedIds);
  const negativeCache: NegativeCache = createNegativeCache();
  const inflight = new Map<string, Promise<CachedEvent | null>>();

  queryManager.setQueryFn(filter => backend.query(filter));

  function buildStoredEvent(event: NostrEvent, meta?: EventMeta): StoredEvent {
    const tagIndex = event.tags
      .filter(t => t.length >= 2)
      .map(t => `${t[0]}:${t[1]}`);
    return {
      event,
      seenOn: meta?.relay ? [meta.relay] : [],
      firstSeen: Date.now(),
      _tag_index: tagIndex,
      _d_tag: getDTag(event),
    };
  }

  async function processKind5(event: NostrEvent): Promise<void> {
    const eTargets = event.tags.filter(t => t[0] === 'e').map(t => t[1]);
    for (const targetId of eTargets) {
      const existing = await backend.get(targetId);
      if (existing) {
        if (existing.event.pubkey === event.pubkey) {
          deletedIds.add(targetId);
          changeSubject.next({ event: existing.event, type: 'deleted' });
          queryManager.notifyDeletion();
        }
      } else {
        pendingDeletions.set(targetId, { pubkey: event.pubkey, registeredAt: Date.now() });
      }
    }

    const aTargets = event.tags.filter(t => t[0] === 'a').map(t => t[1]);
    for (const aValue of aTargets) {
      const parts = aValue.split(':');
      if (parts.length < 3) continue;
      const [kindStr, pubkey, ...dTagParts] = parts;
      const kind = parseInt(kindStr, 10);
      const dTag = dTagParts.join(':');
      if (pubkey !== event.pubkey) continue;
      const existing = await backend.getByAddressableKey(kind, pubkey, dTag);
      if (existing && existing.event.created_at <= event.created_at) {
        deletedIds.add(existing.event.id);
        changeSubject.next({ event: existing.event, type: 'deleted' });
        queryManager.notifyDeletion();
      }
    }
  }

  function checkPendingDeletions(event: NostrEvent): boolean {
    const pending = pendingDeletions.get(event.id);
    if (!pending) return false;
    pendingDeletions.delete(event.id);
    if (pending.pubkey === event.pubkey) {
      deletedIds.add(event.id);
      return true;
    }
    return false;
  }

  function cleanPendingDeletions(): void {
    const threshold = Date.now() - 5 * 60 * 1000;
    for (const [id, entry] of pendingDeletions) {
      if (entry.registeredAt < threshold) pendingDeletions.delete(id);
    }
    if (pendingDeletions.size > 10000) {
      const entries = Array.from(pendingDeletions.entries())
        .sort((a, b) => a[1].registeredAt - b[1].registeredAt);
      const toRemove = entries.slice(0, entries.length - 10000);
      for (const [id] of toRemove) pendingDeletions.delete(id);
    }
  }

  const store: EventStore = {
    async add(event: NostrEvent, meta?: EventMeta): Promise<AddResult> {
      // Step 1: Ephemeral
      if (classifyEvent(event) === 'ephemeral') return 'ephemeral';

      // Step 1.5: Already deleted
      if (deletedIds.has(event.id)) return 'deleted';

      // Step 2: Duplicate
      const existing = await backend.get(event.id);
      if (existing) {
        if (meta?.relay && !existing.seenOn.includes(meta.relay)) {
          existing.seenOn.push(meta.relay);
          await backend.put(existing);
        }
        return 'duplicate';
      }

      // Step 3: NIP-40 expiration
      if (isExpired(event)) return 'expired';

      // Step 4: Kind 5 deletion
      if (event.kind === 5) {
        await processKind5(event);
        await backend.put(buildStoredEvent(event, meta));
        changeSubject.next({ event, type: 'added', relay: meta?.relay });
        queryManager.notifyPotentialChange(buildStoredEvent(event, meta));
        return 'added';
      }

      const classification = classifyEvent(event);

      // Step 5: Replaceable
      if (classification === 'replaceable') {
        const existingRepl = await backend.getByReplaceableKey(event.kind, event.pubkey);
        if (existingRepl) {
          const cmp = compareEventsForReplacement(event, existingRepl.event);
          if (cmp <= 0) return 'duplicate';
          await backend.delete(existingRepl.event.id);
          const stored = buildStoredEvent(event, meta);
          await backend.put(stored);
          changeSubject.next({ event, type: 'replaced', relay: meta?.relay });
          queryManager.notifyPotentialChange(stored);
          return 'replaced';
        }
      }

      // Step 6: Addressable
      if (classification === 'addressable') {
        const dTag = getDTag(event);
        const existingAddr = await backend.getByAddressableKey(event.kind, event.pubkey, dTag);
        if (existingAddr) {
          const cmp = compareEventsForReplacement(event, existingAddr.event);
          if (cmp <= 0) return 'duplicate';
          await backend.delete(existingAddr.event.id);
          const stored = buildStoredEvent(event, meta);
          await backend.put(stored);
          changeSubject.next({ event, type: 'replaced', relay: meta?.relay });
          queryManager.notifyPotentialChange(stored);
          return 'replaced';
        }
      }

      // Step 7: Regular — store as-is
      const stored = buildStoredEvent(event, meta);
      await backend.put(stored);

      // Step 8: Check pending deletions
      const wasDeleted = checkPendingDeletions(event);
      if (wasDeleted) {
        changeSubject.next({ event, type: 'deleted', relay: meta?.relay });
        queryManager.notifyDeletion();
        cleanPendingDeletions();
        return 'deleted';
      }

      changeSubject.next({ event, type: 'added', relay: meta?.relay });
      queryManager.notifyPotentialChange(stored);
      cleanPendingDeletions();
      return 'added';
    },

    query(filter: NostrFilter): Observable<CachedEvent[]> {
      const { observable } = queryManager.registerQuery(filter);
      return observable;
    },

    async fetchById(eventId: string, options?: FetchByIdOptions): Promise<CachedEvent | null> {
      // Step 0: In-flight dedup
      const pending = inflight.get(eventId);
      if (pending) return pending;

      const promise = (async (): Promise<CachedEvent | null> => {
        // Step 1: Check local store
        const existing = await backend.get(eventId);
        if (existing && !deletedIds.has(eventId)) {
          return {
            event: existing.event,
            seenOn: existing.seenOn,
            firstSeen: existing.firstSeen,
          };
        }

        // Step 2: Negative cache
        if (negativeCache.has(eventId)) return null;

        // Step 3: Fetch from relay
        const fetchFn = options?.fetch
          ?? (options?.rxNostr
            ? (id: string) => fetchFromRelay(options.rxNostr!, id, options.timeout ?? 5000, options.relayHint)
            : null);

        if (fetchFn) {
          const fetched = await fetchFn(eventId);
          if (fetched) {
            await store.add(fetched.event, { relay: fetched.relay });
            const stored = await backend.get(eventId);
            if (stored && !deletedIds.has(eventId)) {
              return {
                event: stored.event,
                seenOn: stored.seenOn,
                firstSeen: stored.firstSeen,
              };
            }
          }
        }

        // Step 4: Not found → register negative cache
        if (options?.negativeTTL) {
          negativeCache.set(eventId, options.negativeTTL);
        }

        return null;
      })();

      inflight.set(eventId, promise);
      try {
        return await promise;
      } finally {
        inflight.delete(eventId);
      }
    },

    changes$: changeSubject.asObservable(),
  };

  return store;
}
