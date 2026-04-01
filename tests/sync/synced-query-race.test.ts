import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, Subject, Observable, firstValueFrom, filter, take } from 'rxjs';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import { createSyncedQuery } from '../../src/sync/synced-query.js';
import type { NostrEvent, SyncStatus, CachedEvent } from '../../src/types.js';

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1',
  kind: 0,
  pubkey: 'pk1',
  created_at: 1000,
  tags: [],
  content: '{"name":"test"}',
  sig: 'sig1',
  ...overrides,
});

/**
 * Simulates rx-nostr: emits events via next(), then completes.
 * The complete() fires synchronously after the last next().
 */
function createMockRxNostr(events: NostrEvent[]) {
  return {
    use(rxReq: { getReqPacketObservable(): Observable<unknown> }, _options?: unknown) {
      return new Observable<{ event: NostrEvent; from: string }>((subscriber) => {
        // Wait for filter emission, then emit events and complete
        const sub = rxReq.getReqPacketObservable().subscribe({
          complete: () => {
            // Simulate relay: emit all events then EOSE (complete)
            for (const event of events) {
              subscriber.next({ event, from: 'wss://mock' });
            }
            subscriber.complete();
          },
        });
        return () => sub.unsubscribe();
      });
    },
  };
}

describe('P1: backward strategy race condition — status$ "complete" vs events$ final emit', () => {
  it('events$ contains all events when status$ emits "complete"', async () => {
    const backend = memoryBackend();
    const store = createEventStore({ backend });

    // Simulate connectStore: add events to store on rx-nostr emission
    const mockEvents = [
      makeEvent({ id: 'p1', kind: 0, pubkey: 'pk1', created_at: 100 }),
      makeEvent({ id: 'p2', kind: 0, pubkey: 'pk2', created_at: 200 }),
      makeEvent({ id: 'p3', kind: 0, pubkey: 'pk3', created_at: 300 }),
    ];

    const rxNostr = createMockRxNostr(mockEvents);

    // Manually simulate connectStore behavior
    const allEvents$ = new Subject<{ event: NostrEvent; from: string }>();
    const connectSub = (rxNostr as any)
      .use({
        strategy: 'backward',
        rxReqId: 'mock',
        getReqPacketObservable: () => {
          const s = new Subject();
          queueMicrotask(() => s.complete());
          return s.asObservable();
        },
      })
      .subscribe({
        next: (packet: { event: NostrEvent; from: string }) => {
          void store.add(packet.event, { relay: packet.from });
        },
      });

    // Create SyncedQuery
    const { events$, status$, dispose } = createSyncedQuery(rxNostr, store, {
      filter: { kinds: [0], limit: 10 },
      strategy: 'backward',
    });

    // Wait for status$ to emit 'complete'
    const statusComplete = firstValueFrom(
      status$.pipe(
        filter((s) => s === 'complete'),
        take(1),
      ),
    );

    await statusComplete;

    // At this point, events$ should already have all 3 events
    const latestEvents = await firstValueFrom(events$);
    expect(latestEvents.length).toBe(3);

    connectSub.unsubscribe();
    dispose();
    store.dispose();
  });
});
