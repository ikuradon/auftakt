import type { Observable } from 'rxjs';
import type { NostrEvent } from '../types.js';
import type { EventStore } from '../core/store.js';
import { reconcileDeletions } from './deletion-reconcile.js';

interface ConnectStoreOptions {
  filter?: (event: NostrEvent, meta: { relay: string }) => boolean;
  reconcileDeletions?: boolean;
}

export function connectStore(
  rxNostr: {
    createAllEventObservable(): Observable<{ event: NostrEvent; from: string }>;
    use?(rxReq: any, options?: any): Observable<any>;
  },
  store: EventStore,
  options?: ConnectStoreOptions,
): () => void {
  const subscription = rxNostr.createAllEventObservable().subscribe(packet => {
    const { event, from: relay } = packet;
    if (options?.filter && !options.filter(event, { relay })) return;
    void store.add(event, { relay });
  });

  if (options?.reconcileDeletions && rxNostr.use) {
    void reconcileDeletions(rxNostr as any, store);
  }

  return () => subscription.unsubscribe();
}
