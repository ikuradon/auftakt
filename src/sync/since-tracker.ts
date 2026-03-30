import { firstValueFrom } from 'rxjs';
import type { NostrFilter } from '../types.js';
import type { EventStore } from '../core/store.js';

export interface SinceTracker {
  getSince(filter: NostrFilter): Promise<number | undefined>;
}

/**
 * Tracks the latest created_at for cached events matching a filter.
 * Used by SyncedQuery to set `since` on backward REQs (cache-aware fetch).
 */
export function createSinceTracker(store: EventStore): SinceTracker {
  return {
    async getSince(filter: NostrFilter): Promise<number | undefined> {
      // Query store, wait for the reactive query to flush with actual data.
      // Take two emissions: initial [] + first real result.
      return new Promise<number | undefined>((resolve) => {
        let emitCount = 0;
        const sub = store.query({ ...filter, limit: 1 }).subscribe(events => {
          emitCount++;
          // Skip initial empty emit from BehaviorSubject, wait for flush
          if (emitCount >= 2 || events.length > 0) {
            sub.unsubscribe();
            resolve(events.length > 0 ? events[0].event.created_at : undefined);
          }
        });
        // Timeout: if only one emit and it's empty, resolve undefined
        setTimeout(() => {
          sub.unsubscribe();
          resolve(undefined);
        }, 100);
      });
    },
  };
}
