import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Subject } from 'rxjs';
import { createSyncedQuery } from '../../src/sync/synced-query.js';
import { connectStore } from '../../src/sync/global-feed.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1',
  kind: 1,
  pubkey: 'pk1',
  created_at: 1000,
  tags: [],
  content: '',
  sig: 'sig1',
  ...overrides,
});

function createMockRxNostr() {
  const allEvents$ = new Subject<any>();
  const useCallFilters: any[] = [];

  return {
    allEvents$,
    useCallFilters,
    createAllEventObservable: () => allEvents$.asObservable(),
    use: vi.fn((rxReq: any, options?: any) => {
      const subject = new Subject<any>();
      // Capture the filters emitted by the rxReq
      const sub = rxReq.getReqPacketObservable().subscribe((packet: any) => {
        if (packet?.filters) {
          useCallFilters.push(...packet.filters);
        }
      });
      // Auto-complete backward after a tick
      setTimeout(() => {
        sub.unsubscribe();
        subject.complete();
      }, 10);
      return subject.asObservable();
    }),
  };
}

describe('SyncedQuery cache-aware since', () => {
  it('applies since from cached events on backward REQ', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const mockRxNostr = createMockRxNostr();
    connectStore(mockRxNostr as any, store);

    // Pre-populate cache
    await store.add(makeEvent({ id: 'a', kind: 1, created_at: 500 }));
    await store.add(makeEvent({ id: 'b', kind: 1, created_at: 1000 }));
    await wait();

    const { dispose } = createSyncedQuery(mockRxNostr as any, store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });

    await wait(50);

    // The backward REQ should include since: 1000 (latest cached created_at)
    const backwardFilter = mockRxNostr.useCallFilters.find(
      (f: any) => f.kinds?.includes(1) && f.since !== undefined,
    );
    expect(backwardFilter).toBeDefined();
    expect(backwardFilter.since).toBe(1000);

    dispose();
  });

  it('sends REQ without since when cache is empty', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const mockRxNostr = createMockRxNostr();
    connectStore(mockRxNostr as any, store);

    const { dispose } = createSyncedQuery(mockRxNostr as any, store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });

    await wait(50);

    // Should still send REQ but without since
    const filters = mockRxNostr.useCallFilters.filter((f: any) => f.kinds?.includes(1));
    expect(filters.length).toBeGreaterThan(0);
    // When no cache, since should be absent
    const hasSince = filters.some((f: any) => f.since !== undefined);
    expect(hasSince).toBe(false);

    dispose();
  });
});
