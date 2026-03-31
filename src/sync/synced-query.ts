import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs';
import type { NostrEvent, CachedEvent, NostrFilter, SyncStatus } from '../types.js';
import type { EventStore } from '../core/store.js';
import { createSinceTracker } from './since-tracker.js';

interface SyncedQueryOptions {
  filter: NostrFilter;
  strategy: 'backward' | 'forward' | 'dual';
  on?: { relays?: string[] };
  staleTime?: number;
  signal?: AbortSignal;
}

interface SyncedQueryResult {
  events$: Observable<CachedEvent[]>;
  status$: Observable<SyncStatus>;
  emit: (filter: NostrFilter) => void;
  dispose: () => void;
}

/** Minimal rx-nostr contract for SyncedQuery */
export interface RxNostrLike {
  use(rxReq: RxReqLike, options?: UseOptions): Observable<EventPacketLike>;
}

export interface RxReqLike {
  strategy: 'backward' | 'forward';
  rxReqId: string;
  getReqPacketObservable(): Observable<unknown>;
}

interface UseOptions {
  on?: { relays?: string[] };
}

export interface EventPacketLike {
  event: NostrEvent;
  from: string;
}

// Shared backward REQ pool (module-level singleton)
interface PoolEntry {
  subscription: Subscription;
  refCount: number;
  completionCallbacks: Array<() => void>;
  completed: boolean;
}

/**
 * Module-level singleton pool for backward REQ deduplication.
 * All createSyncedQuery instances share this pool.
 *
 * NOTE: If using multiple EventStore instances in the same process,
 * queries with identical filters across different stores will share
 * the same REQ. This is acceptable because connectStore() feeds
 * events from rx-nostr to the specific store — the REQ itself just
 * triggers relay responses that connectStore routes correctly.
 *
 * For tests: call _resetReqPool() in beforeEach to avoid cross-test leakage.
 */
const backwardReqPool = new Map<string, PoolEntry>();

/** @internal Reset pool for testing. Call in beforeEach. */
export function _resetReqPool(): void {
  for (const entry of backwardReqPool.values()) {
    entry.subscription.unsubscribe();
  }
  backwardReqPool.clear();
}

function hashFilter(filter: NostrFilter): string {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(filter).sort()) {
    const val = (filter as Record<string, unknown>)[key];
    if (val !== undefined) {
      normalized[key] = Array.isArray(val) ? [...val].sort() : val;
    }
  }
  return JSON.stringify(normalized);
}

export function createSyncedQuery(
  rxNostr: RxNostrLike,
  store: EventStore,
  options: SyncedQueryOptions,
): SyncedQueryResult {
  const statusSubject = new BehaviorSubject<SyncStatus>('cached');
  const eventsSubject = new BehaviorSubject<CachedEvent[]>([]);
  let disposed = false;
  let querySubscription: Subscription | null = null;
  let backwardSubscription: Subscription | null = null;
  let forwardSubscription: Subscription | null = null;
  let lastFetchedAt: number | null = null;

  function setupStoreQuery(filter: NostrFilter): void {
    querySubscription?.unsubscribe();
    querySubscription = store.query(filter).subscribe((events) => {
      if (!disposed) {
        eventsSubject.next(events);
      }
    });
  }

  const sinceTracker = createSinceTracker(store);

  let currentBackwardHash: string | null = null;

  function startBackward(filter: NostrFilter, onComplete: () => void): void {
    releaseBackwardPool();

    void sinceTracker.getSince(filter).then((latestCached) => {
      if (disposed) return;

      const adjustedFilter = latestCached ? { ...filter, since: latestCached } : filter;

      const hash = hashFilter(adjustedFilter);
      currentBackwardHash = hash;

      const existing = backwardReqPool.get(hash);
      if (existing && !existing.completed) {
        existing.refCount++;
        existing.completionCallbacks.push(() => {
          lastFetchedAt = Date.now();
          onComplete();
        });
        return;
      }

      const rxReq = createBackwardReq();
      const useOptions = options.on ? { on: options.on } : undefined;

      const entry: PoolEntry = {
        subscription: rxNostr.use(rxReq, useOptions).subscribe({
          complete: () => {
            entry.completed = true;
            for (const cb of entry.completionCallbacks) cb();
          },
        }),
        refCount: 1,
        completionCallbacks: [
          () => {
            lastFetchedAt = Date.now();
            onComplete();
          },
        ],
        completed: false,
      };

      backwardReqPool.set(hash, entry);

      rxReq.emit(adjustedFilter);
      rxReq.over!();
    });
  }

  function releaseBackwardPool(): void {
    if (currentBackwardHash) {
      const entry = backwardReqPool.get(currentBackwardHash);
      if (entry) {
        entry.refCount--;
        if (entry.refCount <= 0) {
          entry.subscription.unsubscribe();
          backwardReqPool.delete(currentBackwardHash);
        }
      }
      currentBackwardHash = null;
    }
  }

  function startForward(filter: NostrFilter): void {
    forwardSubscription?.unsubscribe();

    const rxReq = createForwardReq();
    const useOptions = options.on ? { on: options.on } : undefined;

    forwardSubscription = rxNostr.use(rxReq, useOptions).subscribe();

    rxReq.emit(filter);
  }

  function isStale(): boolean {
    if (!options.staleTime || lastFetchedAt === null) return true;
    return Date.now() - lastFetchedAt >= options.staleTime;
  }

  function startStrategy(filter: NostrFilter): void {
    const { strategy } = options;

    if (strategy === 'backward') {
      if (isStale()) {
        statusSubject.next('fetching');
        startBackward(filter, () => {
          if (!disposed) statusSubject.next('complete');
        });
      } else {
        statusSubject.next('complete');
      }
    } else if (strategy === 'forward') {
      statusSubject.next('live');
      startForward(filter);
    } else if (strategy === 'dual') {
      if (isStale()) {
        statusSubject.next('fetching');
        startBackward(filter, () => {
          if (!disposed) {
            statusSubject.next('live');
            startForward(filter);
          }
        });
      } else {
        statusSubject.next('live');
        startForward(filter);
      }
    }
  }

  function cleanupSubscriptions(): void {
    releaseBackwardPool();
    backwardSubscription?.unsubscribe();
    forwardSubscription?.unsubscribe();
    backwardSubscription = null;
    forwardSubscription = null;
  }

  function checkFilterMismatch(filter: NostrFilter): void {
    const connectFilter = store._getConnectFilter?.();
    if (!connectFilter || !filter.kinds) return;

    for (const kind of filter.kinds) {
      const testEvent = { id: '', kind, pubkey: '', created_at: 0, tags: [], content: '', sig: '' };
      if (!connectFilter(testEvent as any, { relay: '' })) {
        console.warn(
          '[auftakt] SyncedQuery filter mismatch:',
          `kind ${kind} is excluded by connectStore filter. Events for this kind will not reach the store.`,
        );
        break;
      }
    }
  }

  // Initialize
  let currentFilter = options.filter;

  function doDispose(): void {
    if (disposed) return;
    disposed = true;
    cleanupSubscriptions();
    querySubscription?.unsubscribe();
    eventsSubject.complete();
    statusSubject.complete();
  }

  // AbortSignal support
  if (options.signal?.aborted) {
    doDispose();
  } else if (options.signal) {
    options.signal.addEventListener('abort', () => doDispose(), { once: true });
  }

  if (!disposed) {
    checkFilterMismatch(currentFilter);
    setupStoreQuery(currentFilter);
    startStrategy(currentFilter);
  }

  return {
    events$: eventsSubject.asObservable(),
    status$: statusSubject.asObservable(),

    emit(filter: NostrFilter): void {
      if (disposed) return;
      currentFilter = filter;
      cleanupSubscriptions();
      setupStoreQuery(filter);
      startStrategy(filter);
    },

    dispose: doDispose,
  };
}

// Minimal RxReq mock factories for internal use
// These create objects that rx-nostr's use() expects

interface InternalRxReq extends RxReqLike {
  emit(filters: NostrFilter | NostrFilter[]): void;
  over?(): void;
}

function createBackwardReq(): InternalRxReq {
  // Use Subject (not BehaviorSubject) to avoid emitting null on subscribe.
  // rx-nostr destructures { filters } from the packet — null causes TypeError.
  const reqPacketSubject = new Subject<unknown>();

  return {
    strategy: 'backward' as const,
    rxReqId: `auftakt-backward-${Date.now()}`,
    emit(filters: NostrFilter | NostrFilter[]): void {
      reqPacketSubject.next({ filters: Array.isArray(filters) ? filters : [filters] });
    },
    over(): void {
      reqPacketSubject.complete();
    },
    getReqPacketObservable(): Observable<unknown> {
      return reqPacketSubject.asObservable();
    },
  };
}

function createForwardReq(): InternalRxReq {
  // Use Subject (not BehaviorSubject) to avoid emitting null on subscribe.
  const reqPacketSubject = new Subject<unknown>();

  return {
    strategy: 'forward' as const,
    rxReqId: `auftakt-forward-${Date.now()}`,
    emit(filters: NostrFilter | NostrFilter[]): void {
      reqPacketSubject.next({ filters: Array.isArray(filters) ? filters : [filters] });
    },
    getReqPacketObservable(): Observable<unknown> {
      return reqPacketSubject.asObservable();
    },
  };
}
