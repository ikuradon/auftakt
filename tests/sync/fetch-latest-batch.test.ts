import { describe, it, expect, vi } from 'vitest';
import { Subject, Observable } from 'rxjs';
import { createEventStore } from '../../src/core/store.js';
import { connectStore } from '../../src/sync/global-feed.js';
import { memoryBackend } from '../../src/backends/memory.js';
import { fetchLatestBatch } from '../../src/sync/fetch-latest-batch.js';
import type { NostrEvent } from '../../src/types.js';

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
 * Mock rx-nostr that simulates real relay behavior:
 * - Events arrive via allEvents$ (connectStore subscribes to this)
 * - use() triggers the REQ; events are emitted, then EOSE (complete) fires
 * - EOSE fires after a microtask delay to let store.add() calls settle
 */
function createMockRxNostr(events: NostrEvent[]) {
  const allEvents$ = new Subject<{ event: NostrEvent; from: string }>();

  return {
    allEvents$,
    createAllEventObservable: () => allEvents$.asObservable(),
    use: vi.fn((rxReq: { getReqPacketObservable(): Observable<unknown> }, _options?: unknown) => {
      return new Observable<{ event: NostrEvent; from: string }>((subscriber) => {
        const sub = rxReq.getReqPacketObservable().subscribe({
          complete: () => {
            // Emit events via allEvents$ (connectStore path) and use() next
            for (const event of events) {
              allEvents$.next({ event, from: 'wss://mock' });
              subscriber.next({ event, from: 'wss://mock' });
            }
            // Delay EOSE to let store.add() Promises resolve
            // This simulates real relay behavior where EOSE arrives after events
            setTimeout(() => subscriber.complete(), 30);
          },
        });
        return () => sub.unsubscribe();
      });
    }),
  };
}

/**
 * Mock rx-nostr that never completes (for timeout testing).
 */
function createHangingMockRxNostr() {
  const allEvents$ = new Subject<{ event: NostrEvent; from: string }>();

  return {
    allEvents$,
    createAllEventObservable: () => allEvents$.asObservable(),
    use: vi.fn((_rxReq: { getReqPacketObservable(): Observable<unknown> }, _options?: unknown) => {
      return new Observable<{ event: NostrEvent; from: string }>(() => {
        // Never emits, never completes
      });
    }),
  };
}

describe('fetchLatestBatch', () => {
  it('returns events for multiple pubkeys', async () => {
    const backend = memoryBackend();
    const store = createEventStore({ backend });

    const mockEvents = [
      makeEvent({ id: 'e1', kind: 0, pubkey: 'pk1', created_at: 100 }),
      makeEvent({ id: 'e2', kind: 0, pubkey: 'pk2', created_at: 200 }),
      makeEvent({ id: 'e3', kind: 0, pubkey: 'pk3', created_at: 300 }),
    ];

    const rxNostr = createMockRxNostr(mockEvents);
    const disconnectStore = connectStore(rxNostr as any, store);

    const result = await fetchLatestBatch(rxNostr as any, store, ['pk1', 'pk2', 'pk3'], 0);

    expect(result.length).toBe(3);
    const pubkeys = result.map((e) => e.event.pubkey).sort();
    expect(pubkeys).toEqual(['pk1', 'pk2', 'pk3']);

    disconnectStore();
    store.dispose();
  });

  it('returns empty array for empty pubkeys', async () => {
    const backend = memoryBackend();
    const store = createEventStore({ backend });

    const result = await fetchLatestBatch({} as any, store, [], 0);

    expect(result).toEqual([]);

    store.dispose();
  });

  it('respects timeout', async () => {
    const backend = memoryBackend();
    const store = createEventStore({ backend });

    const rxNostr = createHangingMockRxNostr();
    const disconnectStore = connectStore(rxNostr as any, store);

    await expect(
      fetchLatestBatch(rxNostr as any, store, ['pk1'], 0, { timeout: 100 }),
    ).rejects.toThrow('fetchLatestBatch timed out');

    disconnectStore();
    store.dispose();
  });

  it('respects AbortSignal', async () => {
    const backend = memoryBackend();
    const store = createEventStore({ backend });

    const rxNostr = createHangingMockRxNostr();
    const disconnectStore = connectStore(rxNostr as any, store);

    const controller = new AbortController();

    // Abort after a short delay
    setTimeout(() => controller.abort(), 50);

    await expect(
      fetchLatestBatch(rxNostr as any, store, ['pk1'], 0, { signal: controller.signal }),
    ).rejects.toThrow('fetchLatestBatch aborted');

    disconnectStore();
    store.dispose();
  });

  it('respects already-aborted AbortSignal', async () => {
    const backend = memoryBackend();
    const store = createEventStore({ backend });

    const rxNostr = createHangingMockRxNostr();

    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchLatestBatch(rxNostr as any, store, ['pk1'], 0, { signal: controller.signal }),
    ).rejects.toThrow('fetchLatestBatch aborted');

    store.dispose();
  });
});
