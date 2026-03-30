import { Subject, Observable } from 'rxjs';
import type { EventStore } from '../core/store.js';

interface RxNostrLike {
  use(rxReq: any, options?: any): Observable<any>;
}

/**
 * Fetch kind:5 deletion events from relays for given event IDs.
 * Applies any discovered deletions to the store via store.add().
 * Chunks IDs into batches of 50 for the #e filter.
 */
export async function reconcileDeletions(
  rxNostr: RxNostrLike,
  store: EventStore,
  eventIds?: string[],
): Promise<void> {
  // If no eventIds provided, skip (caller should provide from their cache)
  if (!eventIds || eventIds.length === 0) return;

  const CHUNK_SIZE = 50;
  const promises: Promise<void>[] = [];

  for (let i = 0; i < eventIds.length; i += CHUNK_SIZE) {
    const chunk = eventIds.slice(i, i + CHUNK_SIZE);
    promises.push(fetchDeletionsForChunk(rxNostr, store, chunk));
  }

  await Promise.all(promises);
}

function fetchDeletionsForChunk(
  rxNostr: RxNostrLike,
  store: EventStore,
  eventIds: string[],
): Promise<void> {
  return new Promise<void>((resolve) => {
    const reqPacketSubject = new Subject<any>();
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subscription.unsubscribe();
      resolve();
    };

    const timer = setTimeout(finish, 10_000);

    const subscription = rxNostr.use({
      strategy: 'backward' as const,
      rxReqId: `auftakt-reconcile-${Date.now()}`,
      getReqPacketObservable() {
        return reqPacketSubject.asObservable();
      },
    }).subscribe({
      next: (packet: any) => {
        void store.add(packet.event, { relay: packet.from });
      },
      complete: finish,
      error: finish,
    });

    reqPacketSubject.next({ filters: [{ kinds: [5], '#e': eventIds }] });
    reqPacketSubject.complete();
  });
}
