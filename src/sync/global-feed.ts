import type { Observable } from 'rxjs';
import type { NostrEvent } from '../types.js';
import type { EventStore } from '../core/store.js';
import { reconcileDeletions } from './deletion-reconcile.js';

/** Minimal rx-nostr contract for connectStore */
interface RxNostrFeedLike {
  createAllEventObservable(): Observable<{ event: NostrEvent; from: string }>;
  use?(rxReq: unknown, options?: unknown): Observable<unknown>;
}

interface ConnectStoreOptions {
  filter?: (event: NostrEvent, meta: { relay: string }) => boolean;
  reconcileDeletions?: boolean;
}

export function connectStore(
  rxNostr: RxNostrFeedLike,
  store: EventStore,
  options?: ConnectStoreOptions,
): () => void {
  // Register filter for mismatch detection
  if (store._setConnectFilter) {
    store._setConnectFilter(options?.filter);
  }

  const subscription = rxNostr.createAllEventObservable().subscribe(packet => {
    const { event, from: relay } = packet;
    if (options?.filter && !options.filter(event, { relay })) return;
    void store.add(event, { relay });
  });

  if (options?.reconcileDeletions && rxNostr.use) {
    void reconcileDeletions(rxNostr as Parameters<typeof reconcileDeletions>[0], store);
  }

  return () => {
    subscription.unsubscribe();
    if (store._setConnectFilter) {
      store._setConnectFilter(undefined);
    }
  };
}
