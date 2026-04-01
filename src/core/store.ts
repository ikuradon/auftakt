import { Subject, Observable, BehaviorSubject } from 'rxjs';
import type {
  NostrEvent,
  CachedEvent,
  AddResult,
  StoreChange,
  EventMeta,
  NostrFilter,
} from '../types.js';
import type { StorageBackend, StoredEvent } from '../backends/interface.js';
import { classifyEvent, isExpired, getDTag, compareEventsForReplacement } from './nip-rules.js';
import { QueryManager } from './query-manager.js';

export interface EventStoreOptions {
  backend: StorageBackend;
  /**
   * Tag names to index for `#<tag>` queries.
   * Default: undefined (all tags indexed, NIP-01 compliant).
   * Set to e.g. `['e', 'p', 't', 'a', 'k']` to restrict indexing for performance.
   */
  indexedTags?: string[];
  /** Maximum event size in characters (JSON.stringify length). undefined = unlimited. */
  maxEventSize?: number;
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
  rxNostr?: {
    use(req: unknown, options?: unknown): Observable<{ event: NostrEvent; from: string }>;
  };
  relayHint?: string;
  timeout?: number;
  negativeTTL?: number;
  signal?: AbortSignal;
}

export type ConnectStoreFilter = (event: NostrEvent, meta: { relay: string }) => boolean;

export interface EventStore {
  add(event: NostrEvent, meta?: EventMeta): Promise<AddResult>;
  query(filter: NostrFilter): Observable<CachedEvent[]>;
  fetchById(eventId: string, options?: FetchByIdOptions): Promise<CachedEvent | null>;
  /** Non-reactive snapshot query. Returns a Promise of CachedEvent[]. */
  getSync(filter: NostrFilter): Promise<CachedEvent[]>;
  /** Count events matching a filter without loading them. Ignores limit. */
  count(filter: NostrFilter): Promise<number>;
  /** Explicitly delete an event by ID. Marks as deleted, removes from backend, notifies queries. */
  delete(eventId: string): Promise<void>;
  /** Dispose the store: completes changes$, unregisters all queries. */
  dispose(): void;
  /** Get all event IDs stored in the backend. Used by reconcileDeletions. */
  getAllEventIds(): Promise<string[]>;
  /** @internal Used by connectStore to register its filter for mismatch detection */
  _setConnectFilter(filter: ConnectStoreFilter | undefined): void;
  /** @internal Used by createSyncedQuery to check for filter mismatch */
  _getConnectFilter(): ConnectStoreFilter | undefined;
  changes$: Observable<StoreChange>;
}

function fetchFromRelay(
  rxNostr: {
    use(req: unknown, options?: unknown): Observable<{ event: NostrEvent; from: string }>;
  },
  eventId: string,
  timeout: number,
  relayHint?: string,
): Promise<{ event: NostrEvent; relay: string } | null> {
  return new Promise<{ event: NostrEvent; relay: string } | null>((resolve) => {
    const reqPacketSubject = new BehaviorSubject<any>(null);
    let resolved = false;

    const useOptions = relayHint ? { on: { relays: [relayHint] } } : undefined;

    const subscription = rxNostr
      .use(
        {
          strategy: 'backward' as const,
          rxReqId: `auftakt-fetch-${eventId}-${Date.now()}`,
          getReqPacketObservable() {
            return reqPacketSubject.asObservable();
          },
        },
        useOptions,
      )
      .subscribe({
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
  const changeSubject = new Subject<StoreChange>();
  const queryManager = new QueryManager();
  const inflight = new Map<string, Promise<CachedEvent | null>>();
  let connectFilter: ConnectStoreFilter | undefined;
  const maxEventSize = options.maxEventSize;

  function validateEvent(event: NostrEvent): boolean {
    if (typeof event.id !== 'string' || !event.id) return false;
    if (typeof event.pubkey !== 'string' || !event.pubkey) return false;
    if (typeof event.kind !== 'number' || !Number.isInteger(event.kind)) return false;
    if (typeof event.created_at !== 'number' || !Number.isFinite(event.created_at)) return false;
    if (!Array.isArray(event.tags)) return false;
    if (typeof event.content !== 'string') return false;
    if (typeof event.sig !== 'string' || !event.sig) return false;
    if (maxEventSize !== undefined && JSON.stringify(event).length > maxEventSize) return false;
    return true;
  }

  queryManager.setQueryFn((filter) => backend.query(filter));

  const indexedTags = options.indexedTags;

  function buildStoredEvent(event: NostrEvent, meta?: EventMeta): StoredEvent {
    const tagIndex = event.tags
      .filter((t) => t.length >= 2 && t[0].length === 1)
      .filter((t) => !indexedTags || indexedTags.includes(t[0]))
      .map((t) => `${t[0]}:${t[1]}`);
    return {
      id: event.id,
      pubkey: event.pubkey,
      kind: event.kind,
      created_at: event.created_at,
      event,
      seenOn: meta?.relay ? [meta.relay] : [],
      firstSeen: Date.now(),
      _tag_index: tagIndex,
      _d_tag: getDTag(event),
    };
  }

  async function processKind5(event: NostrEvent): Promise<void> {
    const eTargets = event.tags.filter((t) => t[0] === 'e').map((t) => t[1]);
    const existingEvents = await Promise.all(
      eTargets.map((id) => backend.get(id).then((e) => [id, e] as const)),
    );
    for (const [targetId, existing] of existingEvents) {
      if (existing) {
        // NIP-09: "Publishing a deletion request against a deletion request has no effect"
        if (existing.kind === 5) continue;
        if (existing.pubkey === event.pubkey) {
          // Persist deletion record only after pubkey verification
          await backend.markDeleted(targetId, event.pubkey, event.created_at);
          await backend.delete(targetId);
          changeSubject.next({ event: existing.event, type: 'deleted' });
          queryManager.notifyDeletion(existing);
        }
      } else {
        // Target not yet in store — persist deletion record for future arrival
        await backend.markDeleted(targetId, event.pubkey, event.created_at);
      }
    }

    const aTargets = event.tags.filter((t) => t[0] === 'a').map((t) => t[1]);
    for (const aValue of aTargets) {
      const parts = aValue.split(':');
      if (parts.length < 3) continue;
      const [kindStr, pubkey, ...dTagParts] = parts;
      const kind = parseInt(kindStr, 10);
      if (isNaN(kind) || kind < 0) continue;
      const dTag = dTagParts.join(':');
      if (pubkey !== event.pubkey) continue;

      // Persist replace deletion record
      const aTagHash = `${kind}:${pubkey}:${dTag}`;
      await backend.markReplaceDeletion(aTagHash, event.pubkey, event.created_at);

      const existing = await backend.getByAddressableKey(kind, pubkey, dTag);
      if (existing && existing.created_at <= event.created_at) {
        await backend.markDeleted(existing.id, event.pubkey, event.created_at);
        await backend.delete(existing.id);
        changeSubject.next({ event: existing.event, type: 'deleted' });
        queryManager.notifyDeletion(existing);
      }
    }
  }

  const store: EventStore = {
    async add(event: NostrEvent, meta?: EventMeta): Promise<AddResult> {
      // Step 0: Validate event structure
      if (!validateEvent(event)) return 'rejected';

      // Step 1: Ephemeral
      if (classifyEvent(event) === 'ephemeral') return 'ephemeral';

      // Step 1.5: Already deleted
      if (await backend.isDeleted(event.id, event.pubkey)) return 'deleted';

      // Step 2: Duplicate
      const existing = await backend.get(event.id);
      if (existing) {
        if (meta?.relay && !existing.seenOn.includes(meta.relay)) {
          const updated = { ...existing, seenOn: [...existing.seenOn, meta.relay] };
          await backend.put(updated);
        }
        return 'duplicate';
      }

      // Step 3: NIP-40 expiration
      if (isExpired(event)) return 'expired';

      // Step 4: Kind 5 deletion
      if (event.kind === 5) {
        await processKind5(event);
        const stored = buildStoredEvent(event, meta);
        await backend.put(stored);
        changeSubject.next({ event, type: 'added', relay: meta?.relay });
        queryManager.notifyPotentialChange(stored);
        return 'added';
      }

      const classification = classifyEvent(event);

      // Step 5: Replaceable
      if (classification === 'replaceable') {
        const existingRepl = await backend.getByReplaceableKey(event.kind, event.pubkey);
        if (existingRepl) {
          const cmp = compareEventsForReplacement(event, existingRepl.event);
          if (cmp <= 0) return 'duplicate';
          await backend.delete(existingRepl.id);
          const stored = buildStoredEvent(event, meta);
          await backend.put(stored);
          // Check if the new event was pending deletion
          if (await backend.isDeleted(event.id, event.pubkey)) {
            await backend.delete(event.id);
            changeSubject.next({ event, type: 'deleted', relay: meta?.relay });
            queryManager.notifyDeletion(stored);
            return 'deleted';
          }
          changeSubject.next({ event, type: 'replaced', relay: meta?.relay });
          queryManager.notifyPotentialChange(stored, 'replaced');
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
          await backend.delete(existingAddr.id);
          const stored = buildStoredEvent(event, meta);
          await backend.put(stored);
          // Check if the new event was pending deletion (e-tag)
          if (await backend.isDeleted(event.id, event.pubkey)) {
            await backend.delete(event.id);
            changeSubject.next({ event, type: 'deleted', relay: meta?.relay });
            queryManager.notifyDeletion(stored);
            return 'deleted';
          }
          // Check a-tag replace deletion
          const aTagHash = `${event.kind}:${event.pubkey}:${dTag}`;
          const replaceDel = await backend.getReplaceDeletion(aTagHash);
          if (
            replaceDel &&
            replaceDel.deletedAt >= event.created_at &&
            replaceDel.deletedBy === event.pubkey
          ) {
            await backend.delete(event.id);
            changeSubject.next({ event, type: 'deleted', relay: meta?.relay });
            queryManager.notifyDeletion(stored);
            return 'deleted';
          }
          changeSubject.next({ event, type: 'replaced', relay: meta?.relay });
          queryManager.notifyPotentialChange(stored, 'replaced');
          return 'replaced';
        }

        // No existing addressable — still check a-tag replace deletion for new addressable events
        const aTagHash = `${event.kind}:${event.pubkey}:${dTag}`;
        const replaceDel = await backend.getReplaceDeletion(aTagHash);
        if (
          replaceDel &&
          replaceDel.deletedAt >= event.created_at &&
          replaceDel.deletedBy === event.pubkey
        ) {
          return 'deleted';
        }
      }

      // Step 7: Regular — store as-is
      const stored = buildStoredEvent(event, meta);
      await backend.put(stored);

      // Step 8: Check pending deletions via backend
      if (await backend.isDeleted(event.id, event.pubkey)) {
        await backend.delete(event.id);
        changeSubject.next({ event, type: 'deleted', relay: meta?.relay });
        queryManager.notifyDeletion(stored);
        return 'deleted';
      }

      changeSubject.next({ event, type: 'added', relay: meta?.relay });
      queryManager.notifyPotentialChange(stored, 'added');
      return 'added';
    },

    query(filter: NostrFilter): Observable<CachedEvent[]> {
      const { id, observable } = queryManager.registerQuery(filter);
      return new Observable<CachedEvent[]>((subscriber) => {
        const sub = observable.subscribe(subscriber);
        return () => {
          sub.unsubscribe();
          queryManager.unregisterQuery(id);
        };
      });
    },

    async fetchById(eventId: string, options?: FetchByIdOptions): Promise<CachedEvent | null> {
      const signal = options?.signal;

      // Step 0: Check if already aborted
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      // Step 0.5: In-flight dedup (skip if caller has AbortSignal to avoid
      // propagating AbortError to non-signal callers sharing the same promise)
      if (!signal) {
        const pending = inflight.get(eventId);
        if (pending) return pending;
      }

      const promise = (async (): Promise<CachedEvent | null> => {
        // Step 1: Check local store (cache hit — return regardless of signal)
        const existing = await backend.get(eventId);
        if (existing) {
          return {
            event: existing.event,
            seenOn: existing.seenOn,
            firstSeen: existing.firstSeen,
          };
        }

        // Step 2: Negative cache
        if (await backend.isNegative(eventId)) return null;

        // Step 2.5: Check abort before relay fetch
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        // Step 3: Fetch from relay
        const fetchFn =
          options?.fetch ??
          (options?.rxNostr
            ? (id: string) =>
                fetchFromRelay(options.rxNostr!, id, options.timeout ?? 5000, options.relayHint)
            : null);

        if (fetchFn) {
          const fetched = await Promise.race([
            fetchFn(eventId),
            ...(signal
              ? [
                  new Promise<never>((_, reject) => {
                    signal.addEventListener(
                      'abort',
                      () => reject(new DOMException('Aborted', 'AbortError')),
                      { once: true },
                    );
                  }),
                ]
              : []),
          ]);
          if (fetched) {
            await store.add(fetched.event, { relay: fetched.relay });
            const stored = await backend.get(eventId);
            if (stored) {
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
          await backend.setNegative(eventId, options.negativeTTL);
        }

        return null;
      })();

      if (!signal) {
        inflight.set(eventId, promise);
      }
      try {
        return await promise;
      } finally {
        inflight.delete(eventId);
      }
    },

    changes$: changeSubject.asObservable(),

    async getSync(filter: NostrFilter): Promise<CachedEvent[]> {
      const results = await backend.query(filter);
      const now = Math.floor(Date.now() / 1000);
      return results
        .filter((s) => !isExpired(s.event, now))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, filter.limit ?? Infinity)
        .map((s) => ({ event: s.event, seenOn: s.seenOn, firstSeen: s.firstSeen }));
    },

    async count(filter: NostrFilter): Promise<number> {
      const results = await backend.query({ ...filter, limit: undefined });
      const now = Math.floor(Date.now() / 1000);
      return results.filter((s) => !isExpired(s.event, now)).length;
    },

    async delete(eventId: string): Promise<void> {
      await backend.markDeleted(eventId, '', 0);
      const stored = await backend.get(eventId);
      await backend.delete(eventId);
      if (stored) {
        changeSubject.next({ event: stored.event, type: 'deleted' });
        queryManager.notifyDeletion(stored);
      }
    },

    dispose(): void {
      changeSubject.complete();
      queryManager.disposeAll();
      inflight.clear();
      void backend.dispose?.();
    },

    async getAllEventIds(): Promise<string[]> {
      return backend.getAllEventIds();
    },

    _setConnectFilter(filter: ConnectStoreFilter | undefined): void {
      connectFilter = filter;
    },

    _getConnectFilter(): ConnectStoreFilter | undefined {
      return connectFilter;
    },
  };

  return store;
}
