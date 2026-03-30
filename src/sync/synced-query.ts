import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import type { CachedEvent, NostrFilter, SyncStatus } from '../types.js';
import type { EventStore } from '../core/store.js';

interface SyncedQueryOptions {
  filter: NostrFilter;
  strategy: 'backward' | 'forward' | 'dual';
  on?: { relays?: string[] };
  staleTime?: number;
}

interface SyncedQueryResult {
  events$: Observable<CachedEvent[]>;
  status$: Observable<SyncStatus>;
  emit: (filter: NostrFilter) => void;
  dispose: () => void;
}

interface RxNostrLike {
  use(rxReq: any, options?: any): Observable<any>;
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
    querySubscription = store.query(filter).subscribe(events => {
      if (!disposed) {
        eventsSubject.next(events);
      }
    });
  }

  function startBackward(filter: NostrFilter, onComplete: () => void): void {
    backwardSubscription?.unsubscribe();

    // Create a minimal RxReq-like object for backward
    const rxReq = createBackwardReq();
    const useOptions = options.on ? { on: options.on } : undefined;

    backwardSubscription = rxNostr.use(rxReq, useOptions).subscribe({
      complete: () => {
        lastFetchedAt = Date.now();
        onComplete();
      },
    });

    rxReq.emit(filter);
    rxReq.over();
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
    backwardSubscription?.unsubscribe();
    forwardSubscription?.unsubscribe();
    backwardSubscription = null;
    forwardSubscription = null;
  }

  // Initialize
  let currentFilter = options.filter;
  setupStoreQuery(currentFilter);
  startStrategy(currentFilter);

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

    dispose(): void {
      if (disposed) return;
      disposed = true;
      cleanupSubscriptions();
      querySubscription?.unsubscribe();
      eventsSubject.complete();
      statusSubject.complete();
    },
  };
}

// Minimal RxReq mock factories for internal use
// These create objects that rx-nostr's use() expects

function createBackwardReq() {
  let emitFn: ((f: any) => void) | null = null;
  let overFn: (() => void) | null = null;
  const reqPacketSubject = new BehaviorSubject<any>(null);

  return {
    strategy: 'backward' as const,
    rxReqId: `auftakt-backward-${Date.now()}`,
    emit(filters: any): void {
      reqPacketSubject.next({ filters: Array.isArray(filters) ? filters : [filters] });
    },
    over(): void {
      reqPacketSubject.complete();
    },
    getReqPacketObservable(): Observable<any> {
      return reqPacketSubject.asObservable();
    },
  };
}

function createForwardReq() {
  const reqPacketSubject = new BehaviorSubject<any>(null);

  return {
    strategy: 'forward' as const,
    rxReqId: `auftakt-forward-${Date.now()}`,
    emit(filters: any): void {
      reqPacketSubject.next({ filters: Array.isArray(filters) ? filters : [filters] });
    },
    getReqPacketObservable(): Observable<any> {
      return reqPacketSubject.asObservable();
    },
  };
}
