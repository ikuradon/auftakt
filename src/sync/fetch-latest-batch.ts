import { firstValueFrom, filter, race, timer, Observable, take } from 'rxjs';
import { map } from 'rxjs/operators';
import type { CachedEvent } from '../types.js';
import type { EventStore } from '../core/store.js';
import { createSyncedQuery, type RxNostrLike } from './synced-query.js';

export interface FetchLatestBatchOptions {
  on?: { relays?: string[] };
  timeout?: number; // default: 10000ms
  signal?: AbortSignal;
}

export async function fetchLatestBatch(
  rxNostr: RxNostrLike,
  store: EventStore,
  pubkeys: string[],
  kind: number,
  options?: FetchLatestBatchOptions,
): Promise<CachedEvent[]> {
  if (pubkeys.length === 0) {
    return [];
  }

  const timeout = options?.timeout ?? 10000;
  const signal = options?.signal;

  // Check if already aborted
  if (signal?.aborted) {
    throw new Error('fetchLatestBatch aborted');
  }

  const { events$, status$, dispose } = createSyncedQuery(rxNostr, store, {
    filter: { kinds: [kind], authors: pubkeys },
    strategy: 'backward',
    on: options?.on,
  });

  try {
    // Build competing observables
    const complete$ = status$.pipe(
      filter((s) => s === 'complete'),
      take(1),
    );

    const timeout$ = timer(timeout).pipe(
      map(() => {
        throw new Error('fetchLatestBatch timed out');
      }),
    );

    const racers: Observable<unknown>[] = [complete$, timeout$];

    if (signal) {
      const abort$ = new Observable<never>((subscriber) => {
        const onAbort = () => {
          subscriber.error(new Error('fetchLatestBatch aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        return () => signal.removeEventListener('abort', onAbort);
      });
      racers.push(abort$);
    }

    await firstValueFrom(race(racers));

    // status$ emitted 'complete', events$ should be up-to-date
    const events = await firstValueFrom(events$);
    return events;
  } finally {
    dispose();
  }
}
