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

export function createSyncedQuery(
  store: EventStore,
  options: SyncedQueryOptions,
): SyncedQueryResult {
  const statusSubject = new BehaviorSubject<SyncStatus>('cached');
  const eventsSubject = new BehaviorSubject<CachedEvent[]>([]);
  let disposed = false;
  let querySubscription: Subscription | null = null;

  function setupQuery(filter: NostrFilter): void {
    querySubscription?.unsubscribe();
    querySubscription = store.query(filter).subscribe(events => {
      if (!disposed) {
        eventsSubject.next(events);
      }
    });
  }

  setupQuery(options.filter);

  if (options.strategy === 'forward') {
    statusSubject.next('live');
  }

  return {
    events$: eventsSubject.asObservable(),
    status$: statusSubject.asObservable(),

    emit(filter: NostrFilter): void {
      if (disposed) return;
      setupQuery(filter);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      querySubscription?.unsubscribe();
      eventsSubject.complete();
      statusSubject.complete();
    },
  };
}
