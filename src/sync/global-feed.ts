import type { Observable } from 'rxjs';
import type { NostrEvent } from '../types.js';
import type { EventStore } from '../core/store.js';

interface ConnectStoreOptions {
  filter?: (event: NostrEvent, meta: { relay: string }) => boolean;
  reconcileDeletions?: boolean;
}

export function connectStore(
  rxNostr: { createAllEventObservable(): Observable<{ event: NostrEvent; from: string }> },
  store: EventStore,
  options?: ConnectStoreOptions,
): () => void {
  const subscription = rxNostr.createAllEventObservable().subscribe(packet => {
    const { event, from: relay } = packet;
    if (options?.filter && !options.filter(event, { relay })) return;
    void store.add(event, { relay });
  });

  return () => subscription.unsubscribe();
}
