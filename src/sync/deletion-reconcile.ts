import { Subject } from 'rxjs';
import type { EventStore } from '../core/store.js';
import type { RxNostrLike, EventPacketLike } from './synced-query.js';

export interface ReconcileOptions {
  maxEventIds?: number; // default: 10000
  concurrency?: number; // default: 5
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
  options?: ReconcileOptions,
): Promise<void> {
  // If no eventIds provided, skip (caller should provide from their cache)
  if (!eventIds || eventIds.length === 0) return;

  const maxEventIds = options?.maxEventIds ?? 10_000;
  const concurrency = options?.concurrency ?? 5;

  // Truncate to maxEventIds, keeping the most recent (end of array)
  const ids = eventIds.length > maxEventIds ? eventIds.slice(-maxEventIds) : eventIds;

  const CHUNK_SIZE = 50;
  const chunks: string[][] = [];

  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    chunks.push(ids.slice(i, i + CHUNK_SIZE));
  }

  await pMap(chunks, (chunk) => fetchDeletionsForChunk(rxNostr, store, chunk), concurrency);
}

async function pMap<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function fetchDeletionsForChunk(
  rxNostr: RxNostrLike,
  store: EventStore,
  eventIds: string[],
): Promise<void> {
  return new Promise<void>((resolve) => {
    const reqPacketSubject = new Subject<unknown>();
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subscription.unsubscribe();
      resolve();
    };

    const timer = setTimeout(finish, 10_000);

    const subscription = rxNostr
      .use({
        strategy: 'backward' as const,
        rxReqId: `auftakt-reconcile-${Date.now()}`,
        getReqPacketObservable() {
          return reqPacketSubject.asObservable();
        },
      })
      .subscribe({
        next: (packet: EventPacketLike) => {
          void store.add(packet.event, { relay: packet.from });
        },
        complete: finish,
        error: finish,
      });

    reqPacketSubject.next({ filters: [{ kinds: [5], '#e': eventIds }] });
    reqPacketSubject.complete();
  });
}
