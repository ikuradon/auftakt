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
      const events = await store.getSync({ ...filter, limit: 1 });
      return events.length > 0 ? events[0].event.created_at : undefined;
    },
  };
}
