/**
 * Svelte adapter for @ikuradon/auftakt.
 *
 * Provides Svelte-compatible readable stores (subscribe protocol) that wrap
 * RxJS Observables. Works with both Svelte 4 (readable stores) and Svelte 5
 * (can be used inside $effect or assigned to $state).
 *
 * Usage in .svelte files:
 * ```svelte
 * <script>
 *   import { createSvelteQuery } from '@ikuradon/auftakt/adapters/svelte';
 *   const { events, status, dispose } = createSvelteQuery(rxNostr, store, {
 *     filter: { kinds: [1] },
 *     strategy: 'dual',
 *   });
 *   // events and status are Svelte readable stores — use with $events, $status
 *   // For Svelte 5 runes: const filtered = $derived($events.filter(...))
 * </script>
 * ```
 */
import type { Observable } from 'rxjs';
import type { CachedEvent, NostrFilter, SyncStatus } from '../types.js';
import type { EventStore } from '../core/store.js';
import { createSyncedQuery } from '../sync/synced-query.js';

/** Svelte readable store contract (subscribe protocol) */
export interface Readable<T> {
  subscribe(run: (value: T) => void): () => void;
}

/**
 * Convert any RxJS Observable to a Svelte-compatible readable store.
 */
export function toReadable<T>(observable: Observable<T>): Readable<T> {
  return {
    subscribe(run: (value: T) => void): () => void {
      const subscription = observable.subscribe(run);
      return () => subscription.unsubscribe();
    },
  };
}

interface SvelteQueryOptions {
  filter: NostrFilter;
  strategy: 'backward' | 'forward' | 'dual';
  on?: { relays?: string[] };
  staleTime?: number;
}

interface SvelteQueryResult {
  events: Readable<CachedEvent[]>;
  status: Readable<SyncStatus>;
  emit: (filter: NostrFilter) => void;
  dispose: () => void;
}

/**
 * Create a SyncedQuery wrapped as Svelte readable stores.
 */
export function createSvelteQuery(
  rxNostr: any,
  store: EventStore,
  options: SvelteQueryOptions,
): SvelteQueryResult {
  const synced = createSyncedQuery(rxNostr, store, options);

  return {
    events: toReadable(synced.events$),
    status: toReadable(synced.status$),
    emit: synced.emit,
    dispose: synced.dispose,
  };
}
