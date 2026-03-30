import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Subject } from 'rxjs';
import { createSyncedQuery, _resetReqPool } from '../../src/sync/synced-query.js';
import { connectStore } from '../../src/sync/global-feed.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';

const wait = (ms = 80) => new Promise(r => setTimeout(r, ms));

function createMockRxNostr() {
  const allEvents$ = new Subject<any>();
  return {
    allEvents$,
    createAllEventObservable: () => allEvents$.asObservable(),
    use: vi.fn(() => {
      const s = new Subject<any>();
      setTimeout(() => s.complete(), 10);
      return s.asObservable();
    }),
  };
}

describe('REQ deduplication', () => {
  let store: ReturnType<typeof createEventStore>;
  let mockRxNostr: ReturnType<typeof createMockRxNostr>;

  beforeEach(() => {
    _resetReqPool();
    store = createEventStore({ backend: memoryBackend() });
    mockRxNostr = createMockRxNostr();
    connectStore(mockRxNostr as any, store);
  });

  it('shares backward REQ for identical filters', async () => {
    const q1 = createSyncedQuery(mockRxNostr as any, store, {
      filter: { kinds: [1], authors: ['pk1'] },
      strategy: 'backward',
    });
    const q2 = createSyncedQuery(mockRxNostr as any, store, {
      filter: { kinds: [1], authors: ['pk1'] },
      strategy: 'backward',
    });

    await wait();

    // Should have called use() only once for the same filter
    // (2 SyncedQueries but 1 REQ)
    const backwardCalls = mockRxNostr.use.mock.calls.length;
    expect(backwardCalls).toBe(1);

    q1.dispose();
    q2.dispose();
  });

  it('sends separate REQs for different filters', async () => {
    const q1 = createSyncedQuery(mockRxNostr as any, store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });
    const q2 = createSyncedQuery(mockRxNostr as any, store, {
      filter: { kinds: [7] },
      strategy: 'backward',
    });

    await wait();

    expect(mockRxNostr.use.mock.calls.length).toBe(2);

    q1.dispose();
    q2.dispose();
  });

  it('releases shared REQ when all consumers dispose', async () => {
    const q1 = createSyncedQuery(mockRxNostr as any, store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });
    const q2 = createSyncedQuery(mockRxNostr as any, store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });

    await wait();
    const callsBefore = mockRxNostr.use.mock.calls.length;

    q1.dispose();
    // q2 still active — REQ should remain

    q2.dispose();
    // Both disposed — REQ should be released

    // Create new query with same filter — should create new REQ
    const q3 = createSyncedQuery(mockRxNostr as any, store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });
    await wait();

    expect(mockRxNostr.use.mock.calls.length).toBeGreaterThan(callsBefore);

    q3.dispose();
  });
});
